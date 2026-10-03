// 启用后持续监测策略：输入漂移、关键指标、安全事件三类信号；
// 任一指标越过激活时声明的界值即"阈值失守"，处置粒度严格限定为 机构 × 模型版本。

export const DEFAULT_MONITOR_POLICY = Object.freeze({
  // 严重及以上安全事件立即失守；其他级别按计数
  safetyImmediateSeverities: ["serious", "critical"],
  maxModerateSafetyEvents: 2,
  // 越界调用计数由调用用例维护，达到 OUT_OF_SCOPE_QUOTA 同样触发暂停
});

/**
 * 判定一批新信号是否构成暂停理由。
 * 信号自带 observed/bound/breached，本函数负责汇总并分级，不掩盖任何一条越界。
 */
export function evaluateSignals(signals, safetyEvents, policy = {}) {
  const cfg = { ...DEFAULT_MONITOR_POLICY, ...policy };
  const breaches = [];

  for (const s of signals) {
    if (s.breached) {
      breaches.push({
        kind: s.kind,
        signal_id: s.signal_id,
        event_id: s.event_id,
        detail: `${s.kind === "input_drift" ? "输入漂移" : "关键指标"}越界：observed=${JSON.stringify(s.observed)} bound=${JSON.stringify(s.bound)}`,
      });
    }
  }

  const serious = safetyEvents.filter((e) => cfg.safetyImmediateSeverities.includes(e.severity));
  for (const e of serious) {
    breaches.push({
      kind: "safety",
      safety_event_id: e.safety_event_id,
      event_id: e.event_id,
      detail: `安全事件级别 ${e.severity}：${e.description}`,
    });
  }
  const moderate = safetyEvents.filter((e) => e.severity === "moderate");
  if (moderate.length > cfg.maxModerateSafetyEvents) {
    breaches.push({
      kind: "safety",
      event_id: moderate[moderate.length - 1].event_id,
      detail: `中度安全事件 ${moderate.length} 起，超过上限 ${cfg.maxModerateSafetyEvents}`,
    });
  }

  return {
    breached: breaches.length > 0,
    breaches,
    reason: breaches.some((b) => b.kind === "safety")
      ? "safety_event"
      : breaches.some((b) => b.kind === "input_drift")
        ? "input_drift"
        : "threshold_breach",
  };
}

/** 汇总某 release 当前的监测态势（供治理视图与暂停决策）。 */
export function releaseMonitoringStatus(model, releaseId, policy = {}) {
  const release = model.getRelease(releaseId);
  if (!release) return null;
  const signals = model.signalsForRelease(releaseId);
  const safety = model.safetyEventsForRelease(releaseId);
  const evaluation = evaluateSignals(signals, safety, policy);
  return {
    release_id: releaseId,
    institution_id: release.institution_id,
    package_id: release.package_id,
    status: release.status,
    signal_count: signals.length,
    breached_signals: signals.filter((s) => s.breached),
    safety_event_count: safety.length,
    out_of_scope_count: release.out_of_scope_count,
    evaluation,
  };
}
