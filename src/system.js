import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { DomainError, NotFoundError } from "./errors.js";
import { EventStore } from "./event-store.js";
import { OperationalStore } from "./operational-store.js";
import { Projections } from "./projections.js";
import { validatePayloadRules } from "./rules.js";
import { loadContractSchema, validateAgainstSchema } from "./schema-validator.js";
import { ApplicabilityService } from "./services/applicability.js";
import { MonitoringService } from "./services/monitoring.js";
import { OverrideService } from "./services/overrides.js";
import { PredictionService } from "./services/predictions.js";
import { ReleasePackageService } from "./services/release-package.js";
import { RollbackService } from "./services/rollback.js";
import { TraceabilityService } from "./services/traceability.js";
import { WithdrawalService } from "./services/withdrawals.js";

/**
 * 组合根：事件存储（契约信封 + 版本序列）→ 放行载荷规则 → 投影，
 * 再叠加操作型记录与各业务服务。dataDir 提供时事件与操作记录均落盘 JSONL。
 */
export async function createReleaseSystem({ dataDir = null, now = () => new Date().toISOString() } = {}) {
  const schema = loadContractSchema();
  const store = await EventStore.open({
    validateEnvelope: (event) => validateAgainstSchema(schema, event),
    persistenceFile: dataDir ? join(dataDir, "events.jsonl") : null,
  });
  const projections = new Projections();
  for (const event of store.list()) projections.apply(event);
  store.subscribe(projections.apply);

  const operational = await OperationalStore.open({
    file: dataDir ? join(dataDir, "operational.jsonl") : null,
  });

  async function appendEvent(event) {
    const envelopeErrors = validateAgainstSchema(schema, event);
    if (envelopeErrors.length) throw new DomainError("事件不符合领域契约", envelopeErrors);
    const ruleErrors = validatePayloadRules(event, projections);
    if (ruleErrors.length) throw new DomainError("事件载荷不满足放行规则", ruleErrors);
    return store.append(event);
  }

  function emit({ event_type, aggregate_type, aggregate_id, summary, ...payload }) {
    return appendEvent({
      event_id: randomUUID(),
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at: now(),
      version: store.nextVersion(aggregate_type, aggregate_id),
      summary,
      ...payload,
    });
  }

  async function suspendRelease({ release_id, reason, detail, effective_at = null }) {
    const release = projections.releases.get(release_id);
    if (!release) throw new NotFoundError(`放行不存在：${release_id}`);
    if (release.status !== "active") return null; // 已暂停，幂等
    return emit({
      event_type: "MODEL_SUSPENDED",
      aggregate_type: "clinical_release",
      aggregate_id: release_id,
      summary: `局部暂停 ${release.institution_id} / ${release.model_version}：${reason}`,
      release_id,
      scope: { institution_id: release.institution_id, model_version: release.model_version },
      reason,
      detail,
      effective_at: effective_at ?? now(),
    });
  }

  const context = { projections, operational, now, emit, suspendRelease };
  const applicability = new ApplicabilityService(context);
  const services = {
    applicability,
    predictions: new PredictionService(context, applicability),
    overrides: new OverrideService(context),
    monitoring: new MonitoringService(context),
    withdrawals: new WithdrawalService(context),
    rollback: new RollbackService(context),
    packages: new ReleasePackageService(context),
    traceability: new TraceabilityService(context),
  };

  // 回放操作型记录：恢复授权撤回状态（暂停结果已在事件日志中）
  for (const record of operational.recordsOf("withdrawal")) {
    services.withdrawals.restore(record);
  }

  return { store, projections, operational, appendEvent, emit, suspendRelease, services };
}
