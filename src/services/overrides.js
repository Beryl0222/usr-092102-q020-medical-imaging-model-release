import { randomUUID } from "node:crypto";

import { DomainError, NotFoundError } from "../errors.js";

const PROTECTED_NOTE = "医生覆盖记录受保护，仅提供汇总，不得用于个人绩效评价";

/**
 * 医生覆盖模型判断：必须留下临床理由；记录受保护，
 * 不提供任何按个人维度的统计，避免成为个人绩效惩罚依据。
 */
export class OverrideService {
  constructor(context) {
    this.context = context;
  }

  async record({ prediction_id, clinician_id, clinical_rationale, detail = null }) {
    const { operational, now } = this.context;
    if (!operational.predictionById(prediction_id)) {
      throw new NotFoundError(`预测不存在：${prediction_id}`);
    }
    if (typeof clinician_id !== "string" || clinician_id.trim().length === 0) {
      throw new DomainError("缺少医生标识 clinician_id");
    }
    if (typeof clinical_rationale !== "string" || clinical_rationale.trim().length < 5) {
      throw new DomainError("覆盖模型判断必须留下临床理由（clinical_rationale）");
    }
    const record = {
      override_id: randomUUID(),
      prediction_id,
      clinician_id,
      clinical_rationale,
      detail,
      performance_protected: true,
      at: now(),
    };
    await operational.add("override", record);
    return record;
  }

  /** 仅提供汇总统计（按放行/总量），刻意不提供按医生个人的分解。 */
  stats({ release_id = null } = {}) {
    const { operational } = this.context;
    const predictionRelease = new Map(
      operational.predictions.map((p) => [p.prediction_id, p.release_id]),
    );
    const rows = operational.overrides.filter(
      (o) => !release_id || predictionRelease.get(o.prediction_id) === release_id,
    );
    const byRelease = {};
    for (const row of rows) {
      const id = predictionRelease.get(row.prediction_id) ?? "unknown";
      byRelease[id] = (byRelease[id] ?? 0) + 1;
    }
    return { total: rows.length, by_release: byRelease, note: PROTECTED_NOTE };
  }

  statsByClinician() {
    throw new DomainError(PROTECTED_NOTE);
  }
}
