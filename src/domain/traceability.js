// 治理追溯：从一个异常结果（预测或安全事件）反向追到
// 数据授权与撤回、脱敏、标注争议、合成来源、训练运行、模型包校验值、
// 跨院跨设备与亚组验证、四道决定、启用 scope、暂停/回滚处置，以及每层责任人。
//
// 追溯结果的每个节点都携带 event_id，可直接回到仅追加日志中的原始事件。

export function tracePrediction(model, predictionId) {
  const prediction = model.getPrediction(predictionId);
  if (!prediction) return null;
  const invocation = model.getInvocation(prediction.invocation_id);
  if (!invocation) {
    return { prediction, error: "预测缺少对应的 MODEL_INVOKED 事件" };
  }
  return traceFromInvocation(model, invocation, { via: "prediction", prediction });
}

export function traceSafetyEvent(model, safetyEventId) {
  const event = model.safetyEvents.get(safetyEventId);
  const release = event ? model.getRelease(event.release_id) : null;
  if (!event || !release) return null;
  const base = buildPackageChain(model, release.package_id, release);
  return {
    entrypoint: { kind: "safety_event", safety_event: event },
    clinicalContext: event.invocation_id
      ? minimalInvocation(model.getInvocation(event.invocation_id))
      : null,
    ...base,
    disposition: buildDisposition(model, release),
  };
}

function traceFromInvocation(model, invocation, entry) {
  const release = model.getRelease(invocation.release_id);
  if (!release) return { ...entry, invocation, error: "调用缺少 RELEASE_ACTIVATED 放行记录" };
  const base = buildPackageChain(model, release.package_id, release);
  return {
    entrypoint: {
      kind: entry.via,
      prediction: entry.prediction ?? null,
    },
    clinicalContext: minimalInvocation(invocation),
    ...base,
    disposition: buildDisposition(model, release),
  };
}

function minimalInvocation(inv) {
  if (!inv) return null;
  return {
    invocation_id: inv.invocation_id,
    indication: inv.indication,
    population_group: inv.population_group,
    device: inv.device,
    eligibility: inv.eligibility,
    reasons: inv.reasons,
    at: inv.at,
    out_of_scope: inv.out_of_scope
      ? { event_id: inv.out_of_scope.event_id, violated_dimensions: inv.out_of_scope.violated_dimensions, at: inv.out_of_scope.at }
      : null,
    escalations: inv.escalations.map((e) => ({
      event_id: e.event_id,
      clinician_id: e.clinician_id,
      reason_kind: e.reason_kind,
      at: e.at,
    })),
    override: inv.override
      ? {
          event_id: inv.override.event_id,
          clinician_id: inv.override.clinician_id,
          responsibility: inv.override.responsibility,
          performance_penalty_applied: inv.override.performance_penalty_applied,
          clinical_rationale: inv.override.clinical_rationale,
          final_decision: inv.override.final_decision,
          at: inv.override.at,
        }
      : null,
  };
}

function buildPackageChain(model, packageId, release) {
  const pkg = model.getPackage(packageId);
  const lineage = model.packageLineage(packageId);
  const evidence = model.packageEvidence(packageId);
  const research = model.researchByPackage.get(packageId) ?? null;
  const ethics = model.ethicsByPackage.get(packageId) ?? null;
  const technical = model.technicalByPackage.get(packageId) ?? null;

  const dvStatus = lineage?.datasetVersion
    ? model.datasetVersionStatus(lineage.datasetVersion.dataset_version_id)
    : null;

  const records = lineage
    ? lineage.realRecords.map((id) => {
        const auth = model.recordAuthorization(id);
        return {
          record_id: id,
          authorized_at_trace: auth.authorized,
          authorization_state: auth.reason ?? "authorized",
          withdrawn: model.isRecordWithdrawn(id),
          grant_event_ids: model.records.get(id)?.grants.map((g) => g.event_id) ?? [],
          withdrawal_event_ids: model.records.get(id)?.withdrawals.map((w) => w.event_id) ?? [],
          impacts: model.impactsForRecord(id).map((a) => ({
            event_id: a.event_id,
            disposition: a.disposition,
            assessed_by: a.assessed_by,
          })),
        };
      })
    : [];

  return {
    release: {
      release_id: release.release_id,
      institution_id: release.institution_id,
      status: release.status,
      scope: release.scope,
      activation_event_id: release.activation_event_id,
      activated_by: release.activated_by,
      activated_at: release.activated_at,
      snapshot_fingerprint: release.snapshot_fingerprint,
      package_sha256_at_activation: release.package_sha256,
    },
    package: pkg
      ? {
          package_id: pkg.package_id,
          sha256: pkg.sha256,
          package_event_id: pkg.package_event_id,
          intended_use: pkg.intended_use,
        }
      : null,
    training: lineage?.run
      ? {
          run_id: lineage.run.run_id,
          started_event_id: lineage.run.started_event_id,
          started_by: lineage.run.started_by,
          dataset_version_id: lineage.run.dataset_version_id,
          trained_event_id: lineage.run.trained?.event_id ?? null,
          synthetic_ratio: lineage.syntheticRatio,
        }
      : null,
    data: dvStatus
      ? {
          dataset_version_id: dvStatus.datasetVersion.dataset_version_id,
          publish_event_id: dvStatus.datasetVersion.event_id,
          synthetic_ratio: dvStatus.datasetVersion.synthetic_ratio,
          deidentification: dvStatus.deid
            ? {
                event_id: dvStatus.deid.event_id,
                verifier: dvStatus.deid.verifier,
                method: dvStatus.deid.method,
                report_id: dvStatus.deid.report_id,
                residual_direct_identifiers: dvStatus.deid.residual_direct_identifiers,
              }
            : null,
          open_disputes: dvStatus.openDisputes.map((d) => ({
            dispute_id: d.dispute_id,
            item_ref: d.item_ref,
            raised_by: d.raised.by,
            raised_event_id: d.raised.event_id,
          })),
          synthetic_batches: dvStatus.batches.map((b) => ({
            batch_id: b.batch_id,
            event_id: b.event_id,
            generator_run_id: b.generator_run_id,
            source_record_ids: b.source_record_ids,
            ratio_in_version: b.ratio_in_version,
          })),
          records,
          approvals: dvStatus.approvals.map((a) => ({
            event_id: a.event_id,
            approved_by: a.approved_by,
            allowed_run_purpose: a.allowed_run_purpose,
          })),
          governance_problems: dvStatus.problems,
        }
      : null,
    validation: {
      studies: evidence.studies.map((s) => ({
        study_id: s.study_id,
        event_id: s.event_id,
        site_id: s.site_id,
        device_vendor: s.device_vendor,
        device_model: s.device_model,
        threshold: s.threshold,
        strata: s.strata,
      })),
      bias_assessments: evidence.biasAssessments.map((a) => ({
        assessment_id: a.assessment_id,
        event_id: a.event_id,
        worst_group: a.worst_group,
        worst_sensitivity_gap: a.worst_sensitivity_gap,
        non_inferiority_margin: a.non_inferiority_margin,
        passed: a.passed,
      })),
    },
    decisions: {
      research: research
        ? { event_id: research.event_id, principal_investigator: research.principal_investigator, at: research.at }
        : null,
      ethics: ethics
        ? {
            event_id: ethics.event_id,
            committee_id: ethics.committee_id,
            decided_by: ethics.decided_by,
            approval_id: ethics.approval_id,
            valid_until: ethics.valid_until,
            conditions: ethics.conditions,
          }
        : null,
      technical: technical
        ? {
            event_id: technical.event_id,
            accepted_by: technical.accepted_by,
            required_device_vendors: technical.required_device_vendors,
            required_populations: technical.required_populations,
          }
        : null,
      activation: {
        event_id: release.activation_event_id,
        activated_by: release.activated_by,
        institution_id: release.institution_id,
      },
    },
  };
}

function buildDisposition(model, release) {
  const signals = model.signalsForRelease(release.release_id);
  const safety = model.safetyEventsForRelease(release.release_id);
  return {
    signals: signals.map((s) => ({
      event_id: s.event_id,
      signal_id: s.signal_id,
      kind: s.kind,
      breached: s.breached,
      observed: s.observed,
      bound: s.bound,
      at: s.at,
    })),
    safety_events: safety.map((e) => ({
      event_id: e.event_id,
      safety_event_id: e.safety_event_id,
      severity: e.severity,
      reported_by: e.reported_by,
      description: e.description,
      at: e.at,
    })),
    suspensions: release.suspensions.map((s) => ({
      event_id: s.event_id,
      suspended_by: s.suspended_by,
      reason: s.reason,
      trigger_event_ids: s.trigger_event_ids,
      at: s.at,
    })),
    resumptions: release.resumptions.map((r) => ({
      event_id: r.event_id,
      resumed_by: r.resumed_by,
      reason: r.reason,
      at: r.at,
    })),
    rollback: release.rollback
      ? {
          event_id: release.rollback.event_id,
          rolled_back_by: release.rollback.rolled_back_by,
          from_package_id: release.rollback.from_package_id,
          to_package_id: release.rollback.to_package_id,
          reason: release.rollback.reason,
          trigger_event_ids: release.rollback.trigger_event_ids,
          historical_predictions_preserved: true,
          at: release.rollback.at,
        }
      : null,
  };
}

/** 责任链汇总：治理人员一眼看到每一层由谁负责。 */
export function responsibilityChain(trace) {
  if (!trace) return [];
  const chain = [];
  if (trace.decisions?.research)
    chain.push({ layer: "研究完成", owner: trace.decisions.research.principal_investigator, event_id: trace.decisions.research.event_id });
  if (trace.decisions?.ethics)
    chain.push({ layer: "伦理审查", owner: trace.decisions.ethics.decided_by, event_id: trace.decisions.ethics.event_id });
  if (trace.decisions?.technical)
    chain.push({ layer: "技术验证", owner: trace.decisions.technical.accepted_by, event_id: trace.decisions.technical.event_id });
  if (trace.decisions?.activation)
    chain.push({ layer: "院内启用", owner: trace.decisions.activation.activated_by, event_id: trace.decisions.activation.event_id });
  if (trace.data?.deidentification)
    chain.push({ layer: "脱敏验证", owner: trace.data.deidentification.verifier, event_id: trace.data.deidentification.event_id });
  if (trace.data?.approvals?.length)
    for (const a of trace.data.approvals)
      chain.push({ layer: "数据治理放行", owner: a.approved_by, event_id: a.event_id });
  if (trace.training)
    chain.push({ layer: "训练运行", owner: trace.training.started_by, event_id: trace.training.started_event_id });
  if (trace.clinicalContext?.override)
    chain.push({ layer: "医生覆盖（接诊医生负责，非绩效惩罚）", owner: trace.clinicalContext.override.clinician_id, event_id: trace.clinicalContext.override.event_id });
  for (const s of trace.disposition?.suspensions ?? [])
    chain.push({ layer: "局部暂停处置", owner: s.suspended_by, event_id: s.event_id });
  if (trace.disposition?.rollback)
    chain.push({ layer: "版本回滚处置", owner: trace.disposition.rollback.rolled_back_by, event_id: trace.disposition.rollback.event_id });
  return chain;
}
