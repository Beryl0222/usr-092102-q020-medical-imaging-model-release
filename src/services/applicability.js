import { DomainError } from "../errors.js";

const isText = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * 发起检查时的适用性判断：只有适用病种、人群、设备和阈值全部满足，
 * 且放行处于启用状态，模型才允许调用；同时给出何时必须人工升级。
 * 每次检查都留痕，供治理审计。
 */
export class ApplicabilityService {
  constructor(context) {
    this.context = context;
  }

  async check({ institution_id, model_version = null, exam = {}, confidence = null }) {
    const errors = [];
    if (!isText(institution_id)) errors.push("缺少机构 institution_id");
    for (const field of ["disease", "population", "device_vendor"]) {
      if (!isText(exam[field])) errors.push(`检查上下文缺少 exam.${field}`);
    }
    if (errors.length) throw new DomainError("适用性检查参数不完整", errors);

    const { projections, operational, now } = this.context;
    const release = model_version
      ? projections.byScope(institution_id, model_version)
      : projections.latestActiveForInstitution(institution_id) ??
        projections.latestForInstitution(institution_id);

    let result;
    if (!release) {
      result = {
        applicable: false,
        status: "none",
        missing_requirements: ["该机构无已启用的模型放行"],
        escalation: { must_escalate: true, reasons: ["无可用模型，按人工流程处理"] },
      };
    } else if (release.status !== "active") {
      const last = release.suspensions.at(-1);
      result = {
        applicable: false,
        status: "suspended",
        release_id: release.release_id,
        missing_requirements: [`放行已暂停：${last?.reason ?? ""} ${last?.detail ?? ""}`.trim()],
        escalation: { must_escalate: true, reasons: ["模型已暂停，必须人工处理"] },
        responsibility: release.responsibility,
      };
    } else {
      const boundary = release.boundary;
      const missing = [];
      if (!boundary.diseases.includes(exam.disease)) missing.push(`病种不在用途边界：${exam.disease}`);
      if (!boundary.populations.includes(exam.population)) missing.push(`人群不在用途边界：${exam.population}`);
      if (!boundary.device_vendors.includes(exam.device_vendor)) {
        missing.push(`设备厂商不在用途边界：${exam.device_vendor}`);
      }
      const escalationReasons = [];
      if (boundary.escalation?.always_escalate_populations?.includes(exam.population)) {
        escalationReasons.push(`人群 ${exam.population} 必须人工复核`);
      }
      const lowConfidenceBelow = boundary.escalation?.low_confidence_below;
      if (typeof confidence === "number" && typeof lowConfidenceBelow === "number" && confidence < lowConfidenceBelow) {
        escalationReasons.push(`模型置信度 ${confidence} 低于 ${lowConfidenceBelow}`);
      }
      result = {
        applicable: missing.length === 0,
        status: "active",
        release_id: release.release_id,
        missing_requirements: missing,
        thresholds: boundary.thresholds,
        escalation: { must_escalate: escalationReasons.length > 0, reasons: escalationReasons },
        responsibility: release.responsibility,
      };
    }

    const record = {
      institution_id,
      model_version: model_version ?? release?.model_version ?? null,
      exam,
      confidence,
      ...result,
      checked_at: now(),
    };
    await operational.add("applicability", record);
    return record;
  }
}
