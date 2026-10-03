import { randomUUID } from "node:crypto";

import { DomainError, NotFoundError } from "../errors.js";

const SEVERITIES = ["low", "medium", "high", "critical"];

/**
 * 启用后持续监控：输入漂移、关键指标与安全事件。
 * 任何越限都按机构+模型版本触发局部暂停（MODEL_SUSPENDED 事件），
 * 不影响其他机构或其他版本。
 */
export class MonitoringService {
  constructor(context) {
    this.context = context;
  }

  async recordSample({
    institution_id,
    model_version = null,
    window_start = null,
    window_end = null,
    drift = {},
    metrics = {},
    n = null,
  }) {
    const { operational, now, suspendRelease } = this.context;
    const release = this.#findRelease(institution_id, model_version);
    const sample = {
      sample_id: randomUUID(),
      institution_id,
      model_version: release.model_version,
      window_start,
      window_end,
      drift,
      metrics,
      n,
      at: now(),
    };
    await operational.add("sample", sample);

    if (release.status !== "active") {
      return { status: "release_not_active", sample_id: sample.sample_id, breaches: [] };
    }

    const breaches = [];
    const limits = release.monitoring;
    if (typeof drift.psi === "number" && drift.psi > limits.drift.psi_max) {
      breaches.push(`输入漂移 PSI ${drift.psi} 超过上限 ${limits.drift.psi_max}`);
    }
    if (typeof metrics.sensitivity === "number" && metrics.sensitivity < limits.metric_floors.sensitivity_min) {
      breaches.push(`灵敏度 ${metrics.sensitivity} 低于下限 ${limits.metric_floors.sensitivity_min}`);
    }
    if (breaches.length === 0) {
      return { status: "ok", sample_id: sample.sample_id, breaches: [] };
    }
    const event = await suspendRelease({
      release_id: release.release_id,
      reason: "THRESHOLD_BREACH",
      detail: breaches.join("；"),
    });
    return { status: "suspended", sample_id: sample.sample_id, breaches, suspension_event_id: event?.event_id ?? null };
  }

  async recordSafetyEvent({ institution_id, model_version = null, severity, description }) {
    const { operational, now, suspendRelease } = this.context;
    if (!SEVERITIES.includes(severity)) {
      throw new DomainError(`severity 必须是 ${SEVERITIES.join(" / ")} 之一`);
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      throw new DomainError("安全事件必须描述 description");
    }
    const release = this.#findRelease(institution_id, model_version);
    const record = {
      safety_event_id: randomUUID(),
      institution_id,
      model_version: release.model_version,
      severity,
      description,
      at: now(),
    };
    await operational.add("safety_event", record);

    if ((severity === "high" || severity === "critical") && release.status === "active") {
      const event = await suspendRelease({
        release_id: release.release_id,
        reason: "SAFETY_EVENT",
        detail: `${severity}：${description}`,
      });
      return { status: "suspended", ...record, suspension_event_id: event?.event_id ?? null };
    }
    return { status: "recorded", ...record };
  }

  #findRelease(institutionId, modelVersion) {
    const { projections } = this.context;
    const release = modelVersion
      ? projections.byScope(institutionId, modelVersion)
      : projections.latestActiveForInstitution(institutionId);
    if (!release) {
      throw new NotFoundError(`无启用中的放行：${institutionId}${modelVersion ? ` / ${modelVersion}` : ""}`);
    }
    return release;
  }
}
