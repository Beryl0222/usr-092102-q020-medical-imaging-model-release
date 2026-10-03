import { randomUUID } from "node:crypto";

import { DomainError } from "../errors.js";

/**
 * 预测调用门禁：先过适用性检查；越界调用被拒绝并按机构+版本局部暂停；
 * 命中人工升级规则时必须确认已升级。预测记录只增不改，回滚后仍可追溯。
 */
export class PredictionService {
  constructor(context, applicability) {
    this.context = context;
    this.applicability = applicability;
  }

  async record({
    institution_id,
    model_version = null,
    exam,
    output = null,
    confidence = null,
    clinician_id = null,
    escalated_to_human = false,
  }) {
    const { operational, now, suspendRelease } = this.context;
    const check = await this.applicability.check({ institution_id, model_version, exam, confidence });

    if (!check.applicable) {
      await operational.add("violation", {
        violation_id: randomUUID(),
        kind: "OUT_OF_BOUNDARY_CALL",
        institution_id,
        model_version: check.model_version,
        exam,
        clinician_id,
        missing_requirements: check.missing_requirements,
        at: now(),
      });
      if (check.status === "active" && check.release_id) {
        await suspendRelease({
          release_id: check.release_id,
          reason: "OUT_OF_BOUNDARY_CALL",
          detail: `越界调用：${check.missing_requirements.join("；")}`,
        });
      }
      throw new DomainError("越界调用被拒绝，已按机构和模型版本局部暂停", check.missing_requirements);
    }

    if (check.escalation.must_escalate && !escalated_to_human) {
      throw new DomainError("该检查必须人工升级后才能调用模型", check.escalation.reasons);
    }

    const prediction = {
      prediction_id: randomUUID(),
      release_id: check.release_id,
      institution_id,
      model_version: check.model_version,
      exam,
      output,
      confidence,
      clinician_id,
      escalated_to_human,
      applicable_snapshot: check,
      created_at: now(),
    };
    await operational.add("prediction", prediction);
    return prediction;
  }
}
