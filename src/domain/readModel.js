// 读模型：把仅追加事件流投影成逐层关联的治理视图。
// 投影是纯函数式的：给定同一批事件必然得到同一状态；不保存任何事件之外的事实。
//
// 关联主线（所有 ID 均来自事件载荷，逐层可双向跳转）：
//   record ──< dataset_version >── synthetic_batch ──> source_record
//      └─< run ── package(sha256) ──< validation_study / bias_assessment
//             └─< research / ethics / technical 三道决定 ──< release(机构×版本)
//                    └─< invocation ── prediction / escalation / override
//                    └─< monitoring_signal / safety_event ── suspension / rollback
//   withdrawal ── impact_assessment（沿同一条主线反查）
export class ReadModel {
  constructor() {
    this.records = new Map();
    this.deidByVersion = new Map();
    this.disputes = new Map();
    this.syntheticBatches = new Map();
    this.datasetVersions = new Map();
    this.datasetApprovals = [];
    this.runs = new Map();
    this.packages = new Map(); // package_id
    this.studies = new Map();
    this.biasAssessments = new Map();
    this.researchByPackage = new Map();
    this.ethicsByPackage = new Map();
    this.technicalByPackage = new Map();
    this.releases = new Map();
    this.invocations = new Map();
    this.predictions = new Map();
    this.signals = new Map();
    this.safetyEvents = new Map();
    this.impactAssessments = [];
    this.applied = 0;
  }

  apply(event) {
    this.applied += 1;
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "DATA_AUTHORIZATION_GRANTED": {
        const r = this.#record(p.record_id);
        r.grants.push({
          event_id: event.event_id,
          granted_by: p.granted_by,
          purpose: p.purpose,
          at: event.occurred_at,
          expires_at: p.expires_at ?? null,
        });
        break;
      }
      case "DATA_AUTHORIZATION_WITHDRAWN": {
        const r = this.#record(p.record_id);
        r.withdrawals.push({
          event_id: event.event_id,
          withdrawn_by: p.withdrawn_by,
          reason: p.reason,
          at: event.occurred_at,
        });
        break;
      }
      case "DEIDENTIFICATION_VERIFIED":
        this.deidByVersion.set(p.dataset_version_id, { event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      case "ANNOTATION_DISPUTE_RAISED":
        this.disputes.set(p.dispute_id, {
          dispute_id: p.dispute_id,
          dataset_version_id: p.dataset_version_id,
          item_ref: p.item_ref,
          status: "open",
          raised: { event_id: event.event_id, by: p.raised_by, reason: p.reason, at: event.occurred_at },
          resolution: null,
        });
        break;
      case "ANNOTATION_DISPUTE_RESOLVED": {
        const d = this.disputes.get(p.dispute_id);
        if (d) {
          d.status = "resolved";
          d.resolution = {
            event_id: event.event_id,
            by: p.resolved_by,
            resolution: p.resolution,
            adjudicated_label: p.adjudicated_label,
            at: event.occurred_at,
          };
        }
        break;
      }
      case "SYNTHETIC_BATCH_REGISTERED":
        this.syntheticBatches.set(p.batch_id, { event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      case "DATASET_VERSION_PUBLISHED":
        this.datasetVersions.set(p.dataset_version_id, {
          event_id: event.event_id,
          dataset_version_id: p.dataset_version_id,
          real_record_ids: p.real_record_ids,
          synthetic_batch_ids: p.synthetic_batch_ids ?? [],
          synthetic_ratio: p.synthetic_ratio,
          notes: p.notes ?? "",
          at: event.occurred_at,
          approvals: [],
        });
        break;
      case "DATASET_APPROVED": {
        const dv = this.datasetVersions.get(p.dataset_version_id);
        const approval = { event_id: event.event_id, ...p, at: event.occurred_at };
        if (dv) dv.approvals.push(approval);
        this.datasetApprovals.push(approval);
        break;
      }
      case "TRAINING_RUN_STARTED":
        this.runs.set(p.run_id, {
          run_id: p.run_id,
          started_event_id: event.event_id,
          dataset_version_id: p.dataset_version_id,
          started_by: p.started_by,
          synthetic_ratio: p.synthetic_ratio,
          at: event.occurred_at,
          trained: null,
        });
        break;
      case "MODEL_PACKAGE_REGISTERED":
        this.packages.set(p.package_id, {
          package_id: p.package_id,
          run_id: p.run_id,
          sha256: p.sha256,
          intended_use: p.intended_use,
          package_event_id: event.event_id,
          registered_at: event.occurred_at,
          trained: null,
        });
        break;
      case "MODEL_TRAINED": {
        const run = this.runs.get(p.run_id);
        const pkg = this.packages.get(p.package_id);
        const trained = {
          event_id: event.event_id,
          run_id: p.run_id,
          dataset_version_id: p.dataset_version_id ?? run?.dataset_version_id ?? null,
          sha256: p.sha256,
          synthetic_ratio: p.synthetic_ratio,
          at: event.occurred_at,
        };
        if (run) run.trained = trained;
        if (pkg) pkg.trained = trained;
        break;
      }
      case "VALIDATION_COMPLETED":
        this.studies.set(p.study_id, { event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      case "SUBGROUP_BIAS_ASSESSED":
        this.biasAssessments.set(p.assessment_id, { event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      case "RESEARCH_COMPLETED":
        this.researchByPackage.set(p.package_id, { event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      case "ETHICS_APPROVAL_GRANTED":
        this.ethicsByPackage.set(p.package_id, { event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      case "TECHNICAL_VALIDATION_ACCEPTED":
        this.technicalByPackage.set(p.package_id, { event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      case "RELEASE_ACTIVATED":
        this.releases.set(p.release_id, {
          release_id: p.release_id,
          package_id: p.package_id,
          institution_id: p.institution_id,
          scope: p.scope,
          decision_refs: p.decision_refs,
          snapshot_fingerprint: p.snapshot_fingerprint,
          package_sha256: p.package_sha256 ?? null,
          activated_by: p.activated_by,
          activated_at: event.occurred_at,
          activation_event_id: event.event_id,
          status: "active",
          suspensions: [],
          resumptions: [],
          rollback: null,
          out_of_scope_count: 0,
        });
        break;
      case "MODEL_INVOKED":
        this.invocations.set(p.invocation_id, {
          invocation_id: p.invocation_id,
          release_id: p.release_id,
          institution_id: p.institution_id,
          indication: p.indication,
          population_group: p.population_group,
          device: p.device,
          eligibility: p.eligibility,
          reasons: p.reasons ?? [],
          at: event.occurred_at,
          invoke_event_id: event.event_id,
          prediction: null,
          escalations: [],
          override: null,
          out_of_scope: null,
        });
        break;
      case "MODEL_PREDICTION_RECORDED": {
        const inv = this.invocations.get(p.invocation_id);
        const prediction = { event_id: event.event_id, ...p, at: event.occurred_at };
        if (inv) inv.prediction = prediction;
        this.predictions.set(p.prediction_id, prediction);
        break;
      }
      case "CLINICIAN_ESCALATION_PERFORMED": {
        const inv = this.invocations.get(p.invocation_id);
        if (inv) inv.escalations.push({ event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      }
      case "CLINICIAN_OVERRIDE_RECORDED": {
        const inv = this.invocations.get(p.invocation_id);
        if (inv) inv.override = { event_id: event.event_id, ...p, at: event.occurred_at };
        break;
      }
      case "OUT_OF_SCOPE_CALL_RECORDED": {
        const inv = this.invocations.get(p.invocation_id);
        const rel = this.releases.get(p.release_id);
        if (inv) inv.out_of_scope = { event_id: event.event_id, ...p, at: event.occurred_at };
        if (rel) rel.out_of_scope_count += 1;
        break;
      }
      case "MONITORING_SIGNAL_RAISED":
        this.signals.set(p.signal_id, { event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      case "SAFETY_EVENT_REPORTED":
        this.safetyEvents.set(p.safety_event_id, { event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      case "MODEL_SUSPENDED": {
        const rel = this.releases.get(p.release_id);
        if (rel) {
          rel.status = "suspended";
          rel.suspensions.push({ event_id: event.event_id, ...p, at: event.occurred_at });
        }
        break;
      }
      case "RELEASE_RESUMED": {
        const rel = this.releases.get(p.release_id);
        if (rel) {
          rel.status = "active";
          rel.resumptions.push({ event_id: event.event_id, ...p, at: event.occurred_at });
        }
        break;
      }
      case "RELEASE_ROLLED_BACK": {
        const rel = this.releases.get(p.release_id);
        if (rel) {
          rel.status = "rolled_back";
          rel.rollback = { event_id: event.event_id, ...p, at: event.occurred_at };
        }
        break;
      }
      case "WITHDRAWAL_IMPACT_ASSESSED":
        this.impactAssessments.push({ event_id: event.event_id, ...p, at: event.occurred_at });
        break;
      default:
        // 未识别事件不致命（前向兼容），但目录层保证当前版本不会写入未知类型。
        break;
    }
  }

  #record(id) {
    if (!this.records.has(id)) {
      this.records.set(id, { record_id: id, grants: [], withdrawals: [] });
    }
    return this.records.get(id);
  }

  // ── 查询 ──────────────────────────────────────────────────────────────

  /** 授权状态：存在未过期授权，且最新一次动作为授予而非撤回。 */
  recordAuthorization(recordId, at = new Date().toISOString()) {
    const r = this.records.get(recordId);
    if (!r || r.grants.length === 0) return { authorized: false, reason: "no_grant" };
    const activeGrant = r.grants.find(
      (g) => (!g.expires_at || Date.parse(g.expires_at) >= Date.parse(at)) && Date.parse(g.at) <= Date.parse(at),
    );
    if (!activeGrant) return { authorized: false, reason: "grant_expired" };
    const withdrawnAfter = r.withdrawals.some(
      (w) => Date.parse(w.at) > Date.parse(activeGrant.at),
    );
    if (withdrawnAfter) return { authorized: false, reason: "withdrawn", grant: activeGrant };
    return { authorized: true, grant: activeGrant };
  }

  isRecordWithdrawn(recordId) {
    const r = this.records.get(recordId);
    if (!r) return false;
    const lastGrantAt = r.grants.reduce((m, g) => Math.max(m, Date.parse(g.at)), 0);
    const lastWithdrawalAt = r.withdrawals.reduce((m, w) => Math.max(m, Date.parse(w.at)), 0);
    return lastWithdrawalAt > lastGrantAt;
  }

  /** 数据集版本的治理状态：授权覆盖、撤回排除、脱敏、争议、合成来源。 */
  datasetVersionStatus(datasetVersionId) {
    const dv = this.datasetVersions.get(datasetVersionId);
    if (!dv) return { exists: false, problems: ["数据集版本不存在"] };
    const problems = [];
    const ungranted = [];
    const withdrawnReal = [];
    for (const id of dv.real_record_ids) {
      const auth = this.recordAuthorization(id);
      if (!auth.authorized && auth.reason === "no_grant") ungranted.push(id);
      if (this.isRecordWithdrawn(id)) withdrawnReal.push(id);
    }
    if (ungranted.length) problems.push(`真实记录缺少授权：${ungranted.join(", ")}`);
    if (withdrawnReal.length) problems.push(`真实记录已撤回但仍在版本中：${withdrawnReal.join(", ")}`);

    const batches = dv.synthetic_batch_ids.map((b) => this.syntheticBatches.get(b)).filter(Boolean);
    const missingBatches = dv.synthetic_batch_ids.filter((b) => !this.syntheticBatches.has(b));
    if (missingBatches.length) problems.push(`合成批次未登记：${missingBatches.join(", ")}`);
    const withdrawnSyntheticSources = [...new Set(
      batches.flatMap((b) => b.source_record_ids.filter((r) => this.isRecordWithdrawn(r))),
    )];
    if (withdrawnSyntheticSources.length) {
      problems.push(`合成数据的真实来源记录已撤回：${withdrawnSyntheticSources.join(", ")}`);
    }

    const deid = this.deidByVersion.get(datasetVersionId);
    if (!deid) problems.push("缺少脱敏验证");
    else if (deid.residual_direct_identifiers !== 0) problems.push("脱敏验证未通过：仍有直接标识残留");

    const openDisputes = [...this.disputes.values()].filter(
      (d) => d.dataset_version_id === datasetVersionId && d.status === "open",
    );
    if (openDisputes.length) problems.push(`存在 ${openDisputes.length} 起未裁决标注争议`);

    return {
      exists: true,
      datasetVersion: dv,
      deid,
      batches,
      openDisputes,
      withdrawnReal,
      withdrawnSyntheticSources,
      approved: dv.approvals.length > 0,
      approvals: dv.approvals,
      problems,
    };
  }

  getPackage(packageId) {
    return this.packages.get(packageId) ?? null;
  }

  findPackageBySha(sha256) {
    return [...this.packages.values()].find((pkg) => pkg.sha256 === sha256) ?? null;
  }

  /** 包的全部研究证据：跨院跨设备研究列表 + 亚组指标聚合 + 群体偏差评估。 */
  packageEvidence(packageId) {
    const studies = [...this.studies.values()].filter((s) => s.package_id === packageId);
    const assessments = [...this.biasAssessments.values()].filter((a) => a.package_id === packageId);
    return {
      studies,
      sites: [...new Set(studies.map((s) => s.site_id))],
      vendors: [...new Set(studies.map((s) => s.device_vendor))],
      devicePairs: [...new Set(studies.map((s) => `${s.device_vendor}|${s.device_model}`))],
      indications: [...new Set(studies.flatMap((s) => s.indications ?? []))],
      populations: [...new Set(studies.flatMap((s) => s.strata.map((x) => x.group_key)))],
      thresholds: [...new Set(studies.map((s) => s.threshold))],
      biasAssessments: assessments,
    };
  }

  /** 包 → 训练运行 → 数据集版本 → 真实记录/合成批次的完整血缘。 */
  packageLineage(packageId) {
    const pkg = this.packages.get(packageId);
    if (!pkg) return null;
    const run = this.runs.get(pkg.run_id) ?? null;
    const dvId = pkg.trained?.dataset_version_id ?? run?.dataset_version_id ?? null;
    const dv = dvId ? this.datasetVersions.get(dvId) : null;
    const batches = dv
      ? dv.synthetic_batch_ids.map((b) => this.syntheticBatches.get(b)).filter(Boolean)
      : [];
    return {
      package: pkg,
      run,
      datasetVersion: dv ?? null,
      realRecords: dv ? dv.real_record_ids : [],
      syntheticBatches: batches,
      syntheticRatio: pkg.trained?.synthetic_ratio ?? run?.synthetic_ratio ?? dv?.synthetic_ratio ?? null,
    };
  }

  getRelease(releaseId) {
    return this.releases.get(releaseId) ?? null;
  }

  releasesForPackage(packageId) {
    return [...this.releases.values()].filter((r) => r.package_id === packageId);
  }

  getInvocation(invocationId) {
    return this.invocations.get(invocationId) ?? null;
  }

  getPrediction(predictionId) {
    return this.predictions.get(predictionId) ?? null;
  }

  signalsForRelease(releaseId) {
    return [...this.signals.values()].filter((s) => s.release_id === releaseId);
  }

  safetyEventsForRelease(releaseId) {
    return [...this.safetyEvents.values()].filter((s) => s.release_id === releaseId);
  }

  impactsForRecord(recordId) {
    return this.impactAssessments.filter((a) => a.record_id === recordId);
  }
}

/** 从事件存储（或事件数组）一次性重建读模型。 */
export function buildReadModel(source) {
  const model = new ReadModel();
  const events = Array.isArray(source) ? source : source.allEvents();
  for (const event of events) model.apply(event);
  return model;
}
