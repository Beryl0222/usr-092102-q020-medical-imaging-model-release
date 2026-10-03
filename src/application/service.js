// 应用服务：编排全部用例，是领域层（存储/读模型/策略）之上的唯一写入入口。
// 所有状态变化都以"追加事件"表达；服务不保留事件之外的私有事实。
import { EventStore } from "../domain/eventStore.js";
import { ReadModel } from "../domain/readModel.js";
import { evaluateReleasePackage } from "../domain/releasePackage.js";
import {
  checkEligibility,
  evaluatePrediction,
  OUT_OF_SCOPE_QUOTA,
} from "../domain/policy.js";
import { evaluateSignals } from "../domain/monitoring.js";

export class ServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.details = details;
  }
}

let seq = 0;
function defaultIdGen(draft) {
  seq += 1;
  return `${draft.event_type.toLowerCase()}-${Date.now().toString(36)}-${seq}`;
}

export function createReleaseService({ store, eventFile, now, idGen } = {}) {
  const eventStore = store ?? new EventStore({ file: eventFile, now, idGen: idGen ?? defaultIdGen });
  const model = new ReadModel();
  for (const event of eventStore.allEvents()) model.apply(event);
  eventStore.subscribe((e) => model.apply(e));

  const append = (draft) => eventStore.append(draft);

  // ── 第一层：数据授权 / 撤回 / 脱敏 / 争议 / 合成 / 版本 / 放行 ──────────

  function grantData({ record_id, granted_by, purpose, expires_at }) {
    return append({
      event_type: "DATA_AUTHORIZATION_GRANTED",
      aggregate_type: "imaging_dataset",
      aggregate_id: `record:${record_id}`,
      summary: `记录 ${record_id} 由 ${granted_by} 授权用于 ${purpose}`,
      payload: { record_id, granted_by, purpose, expires_at },
    });
  }

  /**
   * 撤回授权：写撤回事件后立即做影响评估。
   * 既往研究事件、历史预测一律保留；评估结果决定能否用于新训练/新启用。
   */
  function withdrawData({ record_id, withdrawn_by, reason }) {
    if (!model.records.get(record_id)) {
      throw new ServiceError("UNKNOWN_RECORD", `记录 ${record_id} 从未登记授权，无法撤回`);
    }
    const withdrawal = append({
      event_type: "DATA_AUTHORIZATION_WITHDRAWN",
      aggregate_type: "imaging_dataset",
      aggregate_id: `record:${record_id}`,
      summary: `记录 ${record_id} 授权撤回：${reason}`,
      payload: { record_id, withdrawn_by, reason },
    });
    const { assessment, suspensions } = assessWithdrawalImpact({
      withdrawal_event_id: withdrawal.event_id,
      record_id,
      assessed_by: withdrawn_by,
    });
    return { withdrawal, impact: assessment, suspensions };
  }

  /**
   * 撤回影响评估：沿 真实记录/合成来源 → 数据集版本 → 训练运行 → 模型包 → 放行 反查。
   * 不修改任何历史事件；block_new_use 时由各写入用例的门禁拒绝未来使用。
   */
  function assessWithdrawalImpact({ withdrawal_event_id, record_id, assessed_by }) {
    const affectedVersions = [];
    for (const dv of model.datasetVersions.values()) {
      const inReal = dv.real_record_ids.includes(record_id);
      const batchIds = dv.synthetic_batch_ids
        .map((b) => model.syntheticBatches.get(b))
        .filter(Boolean);
      const inSyntheticSource = batchIds.some((b) => b.source_record_ids.includes(record_id));
      if (inReal || inSyntheticSource) {
        affectedVersions.push({
          dataset_version_id: dv.dataset_version_id,
          via: [
            ...(inReal ? ["real_record"] : []),
            ...(inSyntheticSource ? ["synthetic_source"] : []),
          ],
        });
      }
    }
    const versionIds = new Set(affectedVersions.map((v) => v.dataset_version_id));
    const affectedRuns = [...model.runs.values()].filter((r) =>
      versionIds.has(r.dataset_version_id),
    );
    const runIds = new Set(affectedRuns.map((r) => r.run_id));
    const affectedPackages = [...model.packages.values()].filter((p) => runIds.has(p.run_id));
    const packageIds = new Set(affectedPackages.map((p) => p.package_id));
    const affectedReleases = [...model.releases.values()].filter((r) =>
      packageIds.has(r.package_id),
    );

    const disposition = affectedPackages.length > 0 ? "block_new_use" : "no_future_use_affected";

    const assessment = append({
      event_type: "WITHDRAWAL_IMPACT_ASSESSED",
      aggregate_type: "clinical_release",
      aggregate_id:
        affectedReleases[0] ? `release:${affectedReleases[0].release_id}` : `withdrawal:${record_id}`,
      summary:
        disposition === "block_new_use"
          ? `记录 ${record_id} 撤回：影响 ${affectedPackages.length} 个模型包，阻断未来使用，既往研究保留`
          : `记录 ${record_id} 撤回：无未来使用受影响，既往研究保留`,
      payload: {
        withdrawal_event_id,
        record_id,
        assessed_by,
        affected_dataset_versions: affectedVersions.map((v) => v.dataset_version_id),
        affected_paths: affectedVersions,
        affected_run_ids: [...runIds],
        affected_package_ids: [...packageIds],
        affected_release_ids: affectedReleases.map((r) => r.release_id),
        active_release_ids: affectedReleases.filter((r) => r.status === "active").map((r) => r.release_id),
        historical_research_preserved: true,
        disposition,
      },
    });

    // block_new_use 必须可执行：对所有仍处于启用状态的受影响 release 立即局部暂停，
    // 粒度仍为 机构 × 模型版本；未激活/已暂停/已回滚的不受影响。既往预测不触碰。
    const suspensions = [];
    if (disposition === "block_new_use") {
      for (const release of affectedReleases) {
        const current = model.getRelease(release.release_id);
        if (current.status !== "active") continue;
        suspensions.push(
          append({
            event_type: "MODEL_SUSPENDED",
            aggregate_type: "clinical_release",
            aggregate_id: `release:${current.release_id}`,
            summary: `数据撤回触发局部暂停：${current.package_id}@${current.institution_id}（记录 ${record_id}）`,
            payload: {
              release_id: current.release_id,
              institution_id: current.institution_id,
              package_id: current.package_id,
              suspended_by: "system:withdrawal-guard",
              reason: "data_withdrawal",
              reason_text: `训练数据记录 ${record_id} 授权撤回，影响评估 ${assessment.event_id} 要求阻断未来使用；既往预测保留`,
              trigger_event_ids: [withdrawal_event_id, assessment.event_id],
            },
          }),
        );
      }
    }
    return { assessment, suspensions };
  }

  function verifyDeidentification(p) {
    return append({
      event_type: "DEIDENTIFICATION_VERIFIED",
      aggregate_type: "imaging_dataset",
      aggregate_id: `dataset-version:${p.dataset_version_id}`,
      summary: `${p.verifier} 验证数据集版本 ${p.dataset_version_id} 脱敏合格`,
      payload: { residual_direct_identifiers: 0, ...p },
    });
  }

  function raiseAnnotationDispute(p) {
    return append({
      event_type: "ANNOTATION_DISPUTE_RAISED",
      aggregate_type: "imaging_dataset",
      aggregate_id: `dataset-version:${p.dataset_version_id}`,
      summary: `${p.raised_by} 对 ${p.item_ref} 标注提出争议`,
      payload: p,
    });
  }

  function resolveAnnotationDispute(p) {
    return append({
      event_type: "ANNOTATION_DISPUTE_RESOLVED",
      aggregate_type: "imaging_dataset",
      aggregate_id: `dataset-version:${p.dataset_version_id}`,
      summary: `标注争议 ${p.dispute_id} 由 ${p.resolved_by} 裁决为 ${p.resolution}`,
      payload: p,
    });
  }

  function registerSyntheticBatch(p) {
    return append({
      event_type: "SYNTHETIC_BATCH_REGISTERED",
      aggregate_type: "imaging_dataset",
      aggregate_id: `synthetic-batch:${p.batch_id}`,
      summary: `合成批次 ${p.batch_id} 登记（来源真实记录 ${p.source_record_ids.length} 条）`,
      payload: p,
    });
  }

  function publishDatasetVersion(p) {
    // 冻结前自检：所有真实记录当前必须处于授权状态。
    const ungranted = p.real_record_ids.filter(
      (id) => model.recordAuthorization(id).reason === "no_grant",
    );
    if (ungranted.length) {
      throw new ServiceError(
        "UNAUTHORIZED_RECORDS",
        `数据集版本包含未授权记录：${ungranted.join(", ")}`,
        { ungranted },
      );
    }
    return append({
      event_type: "DATASET_VERSION_PUBLISHED",
      aggregate_type: "imaging_dataset",
      aggregate_id: `dataset-version:${p.dataset_version_id}`,
      summary: `数据集版本 ${p.dataset_version_id} 冻结（合成占比 ${(p.synthetic_ratio * 100).toFixed(1)}%）`,
      payload: p,
    });
  }

  function approveDataset(p) {
    const status = model.datasetVersionStatus(p.dataset_version_id);
    if (!status.exists) throw new ServiceError("UNKNOWN_DATASET", "数据集版本不存在");
    if (status.problems.length) {
      throw new ServiceError("DATASET_NOT_GOVERNABLE", "数据集治理状态不满足放行条件", {
        problems: status.problems,
      });
    }
    return append({
      event_type: "DATASET_APPROVED",
      aggregate_type: "imaging_dataset",
      aggregate_id: `dataset-version:${p.dataset_version_id}`,
      summary: `数据集版本 ${p.dataset_version_id} 治理放行，允许指定用途训练`,
      payload: p,
    });
  }

  // ── 第二层：训练运行与模型包 ───────────────────────────────────────────

  function startTrainingRun({ run_id, dataset_version_id, started_by, purpose }) {
    const status = model.datasetVersionStatus(dataset_version_id);
    if (!status.exists) throw new ServiceError("UNKNOWN_DATASET", "数据集版本不存在");
    if (status.problems.length) {
      throw new ServiceError("DATASET_NOT_GOVERNABLE", "存在治理问题，禁止在该版本上训练", {
        problems: status.problems,
      });
    }
    const approval = status.approvals.find((a) =>
      a.allowed_run_purpose.includes(purpose ?? a.allowed_run_purpose[0]),
    );
    if (!approval) {
      throw new ServiceError(
        "PURPOSE_NOT_AUTHORIZED",
        `数据集放行用途不包含：${purpose ?? "(未声明)"}`,
      );
    }
    return append({
      event_type: "TRAINING_RUN_STARTED",
      aggregate_type: "model_build",
      aggregate_id: `run:${run_id}`,
      summary: `训练运行 ${run_id} 绑定冻结版本 ${dataset_version_id}`,
      payload: {
        run_id,
        dataset_version_id,
        started_by,
        purpose,
        synthetic_ratio: status.datasetVersion.synthetic_ratio,
      },
    });
  }

  function registerPackage(p) {
    return append({
      event_type: "MODEL_PACKAGE_REGISTERED",
      aggregate_type: "model_build",
      aggregate_id: `package:${p.package_id}`,
      summary: `模型包 ${p.package_id} 登记，sha256=${p.sha256.slice(0, 12)}…`,
      payload: p,
    });
  }

  function completeTraining({ run_id, package_id, sha256 }) {
    const run = model.runs.get(run_id);
    if (!run) throw new ServiceError("UNKNOWN_RUN", `训练运行 ${run_id} 不存在`);
    const pkg = model.packages.get(package_id);
    if (!pkg) throw new ServiceError("UNKNOWN_PACKAGE", `模型包 ${package_id} 未登记`);
    if (pkg.sha256 !== sha256) {
      throw new ServiceError("CHECKSUM_MISMATCH", "训练完成上报的 sha256 与模型包登记值不一致");
    }
    return append({
      event_type: "MODEL_TRAINED",
      aggregate_type: "model_build",
      aggregate_id: `package:${package_id}`,
      summary: `训练运行 ${run_id} 完成，产出模型包 ${package_id}`,
      payload: {
        run_id,
        package_id,
        dataset_version_id: run.dataset_version_id,
        sha256,
        synthetic_ratio: run.synthetic_ratio,
      },
    });
  }

  // ── 第三层：验证 / 偏差 / 前三道决定 ───────────────────────────────────

  function recordValidation(p) {
    if (!model.packages.get(p.package_id)) {
      throw new ServiceError("UNKNOWN_PACKAGE", `模型包 ${p.package_id} 未登记`);
    }
    return append({
      event_type: "VALIDATION_COMPLETED",
      aggregate_type: "validation_study",
      aggregate_id: `study:${p.study_id}`,
      summary: `${p.site_id} 在 ${p.device_vendor}/${p.device_model} 上完成 ${p.package_id} 验证`,
      payload: p,
    });
  }

  function assessSubgroupBias(p) {
    const passed = p.worst_sensitivity_gap <= p.non_inferiority_margin;
    return append({
      event_type: "SUBGROUP_BIAS_ASSESSED",
      aggregate_type: "validation_study",
      aggregate_id: `package-studies:${p.package_id}`,
      summary: passed
        ? `${p.package_id} 群体偏差评估通过（最差差距 ${p.worst_sensitivity_gap}）`
        : `${p.package_id} 群体偏差评估未通过（最差组 ${p.worst_group}）`,
      payload: { ...p, passed },
    });
  }

  function completeResearch(p) {
    for (const id of p.study_ids) {
      const s = model.studies.get(id);
      if (!s || s.package_id !== p.package_id) {
        throw new ServiceError("BAD_STUDY_REF", `研究 ${id} 不存在或不属于该模型包`);
      }
    }
    return append({
      event_type: "RESEARCH_COMPLETED",
      aggregate_type: "validation_study",
      aggregate_id: `package-studies:${p.package_id}`,
      summary: `${p.package_id} 研究完成（决定一，PI：${p.principal_investigator}）`,
      payload: p,
    });
  }

  function grantEthics(p) {
    return append({
      event_type: "ETHICS_APPROVAL_GRANTED",
      aggregate_type: "validation_study",
      aggregate_id: `package-studies:${p.package_id}`,
      summary: `${p.committee_id} 通过 ${p.package_id} 伦理审查（决定二）`,
      payload: p,
    });
  }

  function acceptTechnical({ package_id, accepted_by, assessment_id, required_device_vendors, required_populations, verified_sha256 }) {
    const pkg = model.packages.get(package_id);
    if (!pkg) throw new ServiceError("UNKNOWN_PACKAGE", "模型包未登记");
    if (verified_sha256 && verified_sha256 !== pkg.sha256) {
      throw new ServiceError("CHECKSUM_MISMATCH", "技术验证复核的 sha256 与登记包不一致");
    }
    return append({
      event_type: "TECHNICAL_VALIDATION_ACCEPTED",
      aggregate_type: "validation_study",
      aggregate_id: `package-studies:${package_id}`,
      summary: `联盟技术验证接受 ${package_id}（决定三）`,
      payload: {
        package_id,
        accepted_by,
        assessment_id,
        required_device_vendors,
        required_populations,
        package_sha256_verified: true,
        verified_sha256: verified_sha256 ?? pkg.sha256,
      },
    });
  }

  // ── 第四道决定：院内启用（门禁全绿才允许写入 RELEASE_ACTIVATED）──────────

  function evaluateActivation({ package_id, institution_id, scope, policy, at }) {
    return evaluateReleasePackage(model, { packageId: package_id, institutionId: institution_id, scope, policy, at });
  }

  function activateRelease({ release_id, package_id, institution_id, activated_by, scope, policy, at }) {
    const evaluation = evaluateReleasePackage(model, {
      packageId: package_id,
      institutionId: institution_id,
      scope,
      policy,
      at,
    });
    if (!evaluation.eligible) {
      throw new ServiceError("RELEASE_GATE_FAILED", "放行包门禁未全部通过，禁止院内启用", {
        blockers: evaluation.blockers,
        gates: evaluation.gates,
      });
    }
    const pkg = model.getPackage(package_id);
    const event = append({
      event_type: "RELEASE_ACTIVATED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${release_id}`,
      summary: `${institution_id} 按声明 scope 启用 ${package_id}（决定四）`,
      payload: {
        release_id,
        package_id,
        institution_id,
        activated_by,
        scope,
        decision_refs: {
          research_event_id: evaluation.decisions.research.event_id,
          ethics_event_id: evaluation.decisions.ethics.event_id,
          technical_event_id: evaluation.decisions.technical.event_id,
        },
        snapshot_fingerprint: evaluation.snapshotFingerprint,
        package_sha256: pkg.sha256,
      },
    });
    return { event, evaluation };
  }

  // ── 临床：发起检查（适用性即时可知）/ 预测 / 升级 / 覆盖 ────────────────

  /**
   * 发起检查。返回即时判定：
   *  - APPLICABLE：可出模型分；
   *  - ESCALATION_REQUIRED：在 scope 内但必须人工升级，模型仅供参考；
   *  - NOT_APPLICABLE：越界或版本暂停/回滚，禁止调用；越界留痕并累计，
   *    同一机构同一版本累计达到上限自动局部暂停。
   */
  function initiateExamination({ invocation_id, release_id, indication, population_group, device, policy }) {
    const decision = checkEligibility(
      model,
      { releaseId: release_id, indication, population_group, device },
      policy,
    );
    const release = decision.release;
    if (!release) {
      throw new ServiceError("UNKNOWN_RELEASE", `放行记录 ${release_id} 不存在`);
    }
    const invoked = append({
      event_type: "MODEL_INVOKED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${release_id}`,
      summary: `检查 ${invocation_id} 发起：${decision.eligibility}`,
      payload: {
        invocation_id,
        release_id,
        institution_id: release.institution_id,
        indication,
        population_group,
        device,
        eligibility: decision.eligibility,
        reasons: decision.reasons,
      },
    });

    let suspension = null;
    // 只有"超出病种/人群/设备范围"才算越界调用；版本暂停/回滚是处置状态，不计入越界次数。
    const scopeDimensions = ["indication", "population", "device"];
    const scopeViolations = decision.violatedDimensions.filter((d) => scopeDimensions.includes(d));
    if (decision.eligibility === "NOT_APPLICABLE" && scopeViolations.length > 0) {
      append({
        event_type: "OUT_OF_SCOPE_CALL_RECORDED",
        aggregate_type: "clinical_release",
        aggregate_id: `release:${release_id}`,
        summary: `越界调用留痕：${decision.violatedDimensions.join("/")}`,
        payload: {
          invocation_id,
          release_id,
          institution_id: release.institution_id,
          package_id: release.package_id,
          violated_dimensions: scopeViolations,
          reasons: decision.reasons,
        },
      });
      const updated = model.getRelease(release_id);
      if (updated.out_of_scope_count >= OUT_OF_SCOPE_QUOTA && updated.status === "active") {
        suspension = autoSuspend({
          release_id,
          reason: "out_of_scope_quota",
          suspended_by: "system:out-of-scope-guard",
          reason_text: `越界调用累计 ${updated.out_of_scope_count} 次达到上限 ${OUT_OF_SCOPE_QUOTA}`,
        });
      }
    }
    void invoked;
    return {
      invocation_id,
      eligibility: decision.eligibility,
      reasons: decision.reasons,
      must_escalate: decision.eligibility === "ESCALATION_REQUIRED",
      can_request_prediction: decision.eligibility !== "NOT_APPLICABLE",
      auto_suspended: suspension,
    };
  }

  /** 模型出分：调用时复核包校验值；阈值取自激活 scope，原预测永久保留。 */
  function recordPrediction({ invocation_id, prediction_id, package_sha256_at_call, score }) {
    const invocation = model.getInvocation(invocation_id);
    if (!invocation) throw new ServiceError("UNKNOWN_INVOCATION", "调用不存在");
    if (invocation.eligibility === "NOT_APPLICABLE") {
      throw new ServiceError("OUT_OF_SCOPE", "该检查已判定为越界/停用，禁止出模型分");
    }
    const release = model.getRelease(invocation.release_id);
    if (release.status !== "active") {
      throw new ServiceError("RELEASE_NOT_ACTIVE", `放行状态为 ${release.status}，禁止出分`);
    }
    const pkg = model.getPackage(release.package_id);
    if (package_sha256_at_call !== pkg.sha256) {
      throw new ServiceError("CHECKSUM_MISMATCH", "调用时模型包校验值与登记值不一致，拒绝推理", {
        expected: pkg.sha256,
        received: package_sha256_at_call,
      });
    }
    const judgment = evaluatePrediction(score, release.scope.threshold);
    append({
      event_type: "MODEL_PREDICTION_RECORDED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${release.release_id}`,
      summary: `预测 ${prediction_id}：${judgment.prediction}（score=${score}）${judgment.grayZone ? "，灰区需人工升级" : ""}`,
      payload: {
        invocation_id,
        prediction_id,
        package_id: release.package_id,
        package_sha256_at_call,
        score,
        threshold: release.scope.threshold,
        prediction: judgment.prediction,
        gray_zone: judgment.grayZone,
      },
    });
    return judgment;
  }

  function performEscalation({ invocation_id, clinician_id, reason_kind, note }) {
    const invocation = model.getInvocation(invocation_id);
    if (!invocation) throw new ServiceError("UNKNOWN_INVOCATION", "调用不存在");
    return append({
      event_type: "CLINICIAN_ESCALATION_PERFORMED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${invocation.release_id}`,
      summary: `${clinician_id} 对检查 ${invocation_id} 执行人工升级（${reason_kind}）`,
      payload: { invocation_id, clinician_id, reason_kind, reason: note ?? reason_kind },
    });
  }

  /**
   * 医生覆盖：必须给具体临床理由；责任在接诊医生；
   * 明确标记不得作为个人绩效惩罚；原预测不被改写，另存覆盖决定。
   */
  function recordOverride(p) {
    const invocation = model.getInvocation(p.invocation_id);
    if (!invocation) throw new ServiceError("UNKNOWN_INVOCATION", "调用不存在");
    if (!invocation.prediction) throw new ServiceError("NO_PREDICTION", "尚无模型预测，无法覆盖");
    return append({
      event_type: "CLINICIAN_OVERRIDE_RECORDED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${invocation.release_id}`,
      summary: `${p.clinician_id} 覆盖预测 ${p.prediction_id}：最终 ${p.final_decision}`,
      payload: {
        ...p,
        model_prediction: invocation.prediction.prediction,
        responsibility: "attending_clinician",
        performance_penalty_applied: false,
      },
    });
  }

  // ── 监测与处置：信号 → 自动局部暂停 → 恢复 / 回滚 ──────────────────────

  function autoSuspend({ release_id, reason, suspended_by, reason_text }) {
    const release = model.getRelease(release_id);
    if (!release || release.status !== "active") return null;
    const signals = model.signalsForRelease(release_id);
    const safety = model.safetyEventsForRelease(release_id);
    const triggerIds =
      reason === "out_of_scope_quota"
        ? []
        : evaluateSignals(signals, safety).breaches.map((b) => b.event_id);
    const oosEvents = eventStore
      .byType("OUT_OF_SCOPE_CALL_RECORDED")
      .filter((e) => e.payload.release_id === release_id)
      .map((e) => e.event_id);
    return append({
      event_type: "MODEL_SUSPENDED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${release_id}`,
      summary: `${release.institution_id} 的 ${release.package_id} 局部暂停：${reason_text ?? reason}`,
      payload: {
        release_id,
        institution_id: release.institution_id,
        package_id: release.package_id,
        suspended_by,
        reason,
        reason_text: reason_text ?? reason,
        trigger_event_ids: reason === "out_of_scope_quota" ? oosEvents.slice(-OUT_OF_SCOPE_QUOTA) : triggerIds,
      },
    });
  }

  function raiseMonitoringSignal(p) {
    const release = model.getRelease(p.release_id);
    if (!release) throw new ServiceError("UNKNOWN_RELEASE", "放行记录不存在");
    append({
      event_type: "MONITORING_SIGNAL_RAISED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${p.release_id}`,
      summary: `监测信号 ${p.signal_id}（${p.kind}）${p.breached ? " 已越界" : " 在界内"}`,
      payload: p,
    });
    let suspension = null;
    if (p.breached && release.status === "active") {
      suspension = autoSuspend({
        release_id: p.release_id,
        reason: p.kind === "input_drift" ? "input_drift" : "threshold_breach",
        suspended_by: "system:monitor-guard",
        reason_text: `信号 ${p.signal_id} 越界：observed=${JSON.stringify(p.observed)} bound=${JSON.stringify(p.bound)}`,
      });
    }
    return { signal: model.signals.get(p.signal_id) ?? null, auto_suspended: suspension };
  }

  function reportSafetyEvent(p) {
    const release = model.getRelease(p.release_id);
    if (!release) throw new ServiceError("UNKNOWN_RELEASE", "放行记录不存在");
    append({
      event_type: "SAFETY_EVENT_REPORTED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${p.release_id}`,
      summary: `安全事件 ${p.safety_event_id}（${p.severity}）`,
      payload: p,
    });
    let suspension = null;
    const policy = p.policy;
    const signals = model.signalsForRelease(p.release_id);
    const safety = model.safetyEventsForRelease(p.release_id);
    if (evaluateSignals(signals, safety, policy).breached && release.status === "active") {
      suspension = autoSuspend({
        release_id: p.release_id,
        reason: "safety_event",
        suspended_by: "system:safety-guard",
        reason_text: `安全事件 ${p.safety_event_id} 级别 ${p.severity} 触发立即暂停`,
      });
    }
    return { safety_event: model.safetyEvents.get(p.safety_event_id) ?? null, auto_suspended: suspension };
  }

  function suspendRelease({ release_id, suspended_by, reason, reason_text, trigger_event_ids }) {
    const release = model.getRelease(release_id);
    if (!release) throw new ServiceError("UNKNOWN_RELEASE", "放行记录不存在");
    if (release.status === "suspended") throw new ServiceError("ALREADY_SUSPENDED", "该机构此版本已暂停");
    return append({
      event_type: "MODEL_SUSPENDED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${release_id}`,
      summary: `手动局部暂停 ${release.package_id}@${release.institution_id}`,
      payload: {
        release_id,
        institution_id: release.institution_id,
        package_id: release.package_id,
        suspended_by,
        reason: reason ?? "manual",
        reason_text: reason_text ?? reason ?? "手动暂停",
        trigger_event_ids: trigger_event_ids ?? [],
      },
    });
  }

  function resumeRelease({ release_id, resumed_by, reason, resolved_signal_ids }) {
    const release = model.getRelease(release_id);
    if (!release) throw new ServiceError("UNKNOWN_RELEASE", "放行记录不存在");
    if (release.status !== "suspended") {
      throw new ServiceError("NOT_SUSPENDED", `状态为 ${release.status}，无需解除暂停`);
    }
    return append({
      event_type: "RELEASE_RESUMED",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${release_id}`,
      summary: `${release.institution_id} 的 ${release.package_id} 解除暂停恢复使用`,
      payload: { release_id, resumed_by, reason, resolved_signal_ids: resolved_signal_ids ?? [] },
    });
  }

  /**
   * 版本回滚：切到旧版本或纯人工。历史预测事件原封不动——
   * 回滚后仍可按原 sha256 追溯当时的每一个判断。
   */
  function rollbackRelease({ release_id, rolled_back_by, reason, to_package_id, trigger_event_ids }) {
    const release = model.getRelease(release_id);
    if (!release) throw new ServiceError("UNKNOWN_RELEASE", "放行记录不存在");
    if (release.status === "rolled_back") throw new ServiceError("ALREADY_ROLLED_BACK", "该版本已回滚");
    return append({
      event_type: "RELEASE_ROLLED_BACK",
      aggregate_type: "clinical_release",
      aggregate_id: `release:${release_id}`,
      summary:
        to_package_id === null
          ? `${release.institution_id} 回滚 ${release.package_id} 至纯人工，历史预测保留`
          : `${release.institution_id} 将 ${release.package_id} 回滚至 ${to_package_id}，历史预测保留`,
      payload: {
        release_id,
        institution_id: release.institution_id,
        from_package_id: release.package_id,
        to_package_id: to_package_id ?? null,
        rolled_back_by,
        reason,
        trigger_event_ids: trigger_event_ids ?? [],
      },
    });
  }

  return {
    store: eventStore,
    model,
    // 数据层
    grantData,
    withdrawData,
    assessWithdrawalImpact,
    verifyDeidentification,
    raiseAnnotationDispute,
    resolveAnnotationDispute,
    registerSyntheticBatch,
    publishDatasetVersion,
    approveDataset,
    // 训练层
    startTrainingRun,
    registerPackage,
    completeTraining,
    // 验证与决定
    recordValidation,
    assessSubgroupBias,
    completeResearch,
    grantEthics,
    acceptTechnical,
    // 启用
    evaluateActivation,
    activateRelease,
    // 临床
    initiateExamination,
    recordPrediction,
    performEscalation,
    recordOverride,
    // 监测处置
    raiseMonitoringSignal,
    reportSafetyEvent,
    suspendRelease,
    resumeRelease,
    rollbackRelease,
  };
}
