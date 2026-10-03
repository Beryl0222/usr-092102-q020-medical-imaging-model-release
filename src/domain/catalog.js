// 领域事件目录：在不改动 contracts/domain.schema.json 的前提下扩展业务事件。
// 每个业务事件都必须落在契约允许的四种聚合之一上；契约五件套在注释中标注 [契约]。
//
// 证据链分层（每层事件通过显式 ID 引用上一层）：
//   授权/撤回 → 脱敏验证 → 标注争议 → 合成来源 → 数据集版本
//   → 训练运行 → 模型包校验值 → 跨院跨设备复现/群体偏差
//   → 四道决定(研究完成/伦理/技术验证/院内启用) → 调用/预测/覆盖
//   → 漂移与安全信号 → 局部暂停/回滚。
import { CONTRACT_AGGREGATE_TYPES } from "./envelope.js";

const AGG = Object.freeze({
  DATASET: "imaging_dataset",
  BUILD: "model_build",
  STUDY: "validation_study",
  RELEASE: "clinical_release",
});

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isNumber01 = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const SHA256 = /^[a-f0-9]{64}$/;
const isStringArray = (v) => Array.isArray(v) && v.every(isNonEmptyString);

function requireKeys(payload, keys) {
  const errors = [];
  for (const key of keys) {
    const v = payload[key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      errors.push(`payload.${key} 必填且非空`);
    }
  }
  return errors;
}

function validateScope(scope, where) {
  const errors = [];
  if (!scope || typeof scope !== "object") {
    errors.push(`${where} 必须是对象`);
    return errors;
  }
  for (const key of ["indications", "populations"]) {
    if (!isStringArray(scope[key])) errors.push(`${where}.${key} 必须是非空字符串数组`);
  }
  if (!Array.isArray(scope.devices) || scope.devices.length === 0) {
    errors.push(`${where}.devices 必须是非空数组（每项含 vendor 与 model）`);
  } else {
    for (const [i, d] of scope.devices.entries()) {
      if (!d || !isNonEmptyString(d.vendor) || !isNonEmptyString(d.model)) {
        errors.push(`${where}.devices[${i}] 必须含非空 vendor 与 model`);
      }
    }
  }
  if (
    scope.threshold !== undefined &&
    !(typeof scope.threshold === "number" && scope.threshold > 0 && scope.threshold < 1)
  ) {
    errors.push(`${where}.threshold 必须是 (0,1) 之间的数值`);
  }
  return errors;
}

// 每个条目：aggregate、说明、payload 结构校验。
export const EVENT_CATALOG = Object.freeze({
  // ── 第一层：imaging_dataset（授权/撤回/脱敏/争议/合成/版本）─────────────
  DATA_AUTHORIZATION_GRANTED: {
    aggregate: AGG.DATASET,
    description: "主体或机构授予数据用于指定研究与训练范围",
    validate(p) {
      const errors = requireKeys(p, ["record_id", "granted_by", "purpose"]);
      if (p.expires_at && Number.isNaN(Date.parse(p.expires_at))) {
        errors.push("payload.expires_at 必须是合法时间");
      }
      return errors;
    },
  },
  DATA_AUTHORIZATION_WITHDRAWN: {
    aggregate: AGG.DATASET,
    description: "授权撤回：仅约束未来使用，必须触发影响评估，不删除既往研究",
    validate(p) {
      return requireKeys(p, ["record_id", "withdrawn_by", "reason"]);
    },
  },
  DEIDENTIFICATION_VERIFIED: {
    aggregate: AGG.DATASET,
    description: "脱敏由独立方验证：残留直接标识为零，重标识风险可接受",
    validate(p) {
      const errors = requireKeys(p, ["dataset_version_id", "verifier", "method", "report_id"]);
      if (p.residual_direct_identifiers !== 0) {
        errors.push("payload.residual_direct_identifiers 必须为 0");
      }
      if (p.reidentification_risk !== undefined && !isNumber01(p.reidentification_risk)) {
        errors.push("payload.reidentification_risk 必须在 [0,1]");
      }
      return errors;
    },
  },
  ANNOTATION_DISPUTE_RAISED: {
    aggregate: AGG.DATASET,
    description: "标注争议提出：争议未裁决前相关条目不得进入放行范围",
    validate(p) {
      return requireKeys(p, ["dispute_id", "dataset_version_id", "item_ref", "raised_by", "reason"]);
    },
  },
  ANNOTATION_DISPUTE_RESOLVED: {
    aggregate: AGG.DATASET,
    description: "标注争议由第三方裁决，记录最终标签与裁决人",
    validate(p) {
      const errors = requireKeys(p, [
        "dispute_id",
        "dataset_version_id",
        "resolved_by",
        "resolution",
        "adjudicated_label",
      ]);
      if (p.resolution && !["upheld", "corrected", "split"].includes(p.resolution)) {
        errors.push("payload.resolution 必须是 upheld/corrected/split");
      }
      return errors;
    },
  },
  SYNTHETIC_BATCH_REGISTERED: {
    aggregate: AGG.DATASET,
    description: "合成数据批次登记：必须写清生成器、种子、真实来源记录与占比",
    validate(p) {
      const errors = requireKeys(p, [
        "batch_id",
        "generator_run_id",
        "seed",
        "source_record_ids",
        "provenance",
      ]);
      if (!isStringArray(p.source_record_ids) || p.source_record_ids.length === 0) {
        errors.push("payload.source_record_ids 必须是非空数组，合成数据必须可追到真实记录");
      }
      if (!isNumber01(p.ratio_in_version)) {
        errors.push("payload.ratio_in_version 必须在 [0,1]");
      }
      return errors;
    },
  },
  DATASET_VERSION_PUBLISHED: {
    aggregate: AGG.DATASET,
    description: "数据集版本冻结：真实记录、合成批次、来源与合成占比一并固定",
    validate(p) {
      const errors = requireKeys(p, ["dataset_version_id", "real_record_ids", "synthetic_batch_ids"]);
      if (!isStringArray(p.real_record_ids) || p.real_record_ids.length === 0) {
        errors.push("payload.real_record_ids 必须是非空数组");
      }
      if (!Array.isArray(p.synthetic_batch_ids)) {
        errors.push("payload.synthetic_batch_ids 必须是数组");
      }
      if (!isNumber01(p.synthetic_ratio)) {
        errors.push("payload.synthetic_ratio 必须在 [0,1]");
      }
      return errors;
    },
  },
  DATASET_APPROVED: {
    // [契约事件] 数据集治理放行：授权覆盖、撤回排除、脱敏验证、争议清零后才允许训练
    aggregate: AGG.DATASET,
    description: "[契约] 数据集版本通过治理放行，可被指定训练运行使用",
    validate(p) {
      const errors = requireKeys(p, ["dataset_version_id", "approved_by"]);
      if (!isStringArray(p.allowed_run_purpose)) {
        errors.push("payload.allowed_run_purpose 必须是字符串数组（用途边界）");
      }
      return errors;
    },
  },

  // ── 第二层：model_build（训练运行 / 包校验值）──────────────────────────
  TRAINING_RUN_STARTED: {
    aggregate: AGG.BUILD,
    description: "训练运行登记：绑定冻结的数据集版本",
    validate(p) {
      const errors = requireKeys(p, ["run_id", "dataset_version_id", "started_by"]);
      if (p.synthetic_ratio !== undefined && !isNumber01(p.synthetic_ratio)) {
        errors.push("payload.synthetic_ratio 必须在 [0,1]");
      }
      return errors;
    },
  },
  MODEL_PACKAGE_REGISTERED: {
    aggregate: AGG.BUILD,
    description: "模型包登记：sha256 不可变，运行时调用必须复核同一校验值",
    validate(p) {
      const errors = requireKeys(p, ["package_id", "run_id", "sha256"]);
      if (!SHA256.test(p.sha256 || "")) errors.push("payload.sha256 必须是 64 位小写十六进制");
      const scopeErrors = validateScope(p.intended_use, "payload.intended_use");
      if (scopeErrors.length) errors.push(...scopeErrors);
      return errors;
    },
  },
  MODEL_TRAINED: {
    // [契约事件] 训练完成：模型构建层关闭，等待研究、伦理与技术验证
    aggregate: AGG.BUILD,
    description: "[契约] 训练运行完成，模型包与训练数据版本的关联固定",
    validate(p) {
      const errors = requireKeys(p, ["run_id", "package_id", "dataset_version_id", "sha256"]);
      if (!SHA256.test(p.sha256 || "")) errors.push("payload.sha256 必须是 64 位小写十六进制");
      if (!isNumber01(p.synthetic_ratio)) errors.push("payload.synthetic_ratio 必须在 [0,1]");
      return errors;
    },
  },

  // ── 第三层：validation_study（跨院跨设备 / 群体偏差 / 前三道决定）──────
  VALIDATION_COMPLETED: {
    // [契约事件] 单项验证研究完成（可按医院 × 厂商设备 × 人群亚组分别登记）
    aggregate: AGG.STUDY,
    description: "[契约] 一项院内/设备上的验证完成，必须携带亚组指标与置信区间",
    validate(p) {
      const errors = requireKeys(p, [
        "study_id",
        "package_id",
        "site_id",
        "device_vendor",
        "device_model",
        "threshold",
        "strata",
      ]);
      if (!Array.isArray(p.strata) || p.strata.length === 0) {
        errors.push("payload.strata 必须是非空数组");
      } else {
        for (const [i, s] of p.strata.entries()) {
          const path = `payload.strata[${i}]`;
          if (!isNonEmptyString(s.group_key)) errors.push(`${path}.group_key 必填`);
          if (!Number.isInteger(s.n) || s.n < 1) errors.push(`${path}.n 必须是正整数`);
          for (const m of ["sensitivity", "specificity", "ci_low", "ci_high"]) {
            if (!isNumber01(s[m])) errors.push(`${path}.${m} 必须在 [0,1]`);
          }
          if (isNumber01(s.ci_low) && isNumber01(s.ci_high) && s.ci_low > s.ci_high) {
            errors.push(`${path} 置信区间方向错误（ci_low > ci_high）`);
          }
          if (isNumber01(s.ci_low) && isNumber01(s.sensitivity) && (s.sensitivity < s.ci_low || s.sensitivity > s.ci_high)) {
            errors.push(`${path} 灵敏度点估计必须落在置信区间内`);
          }
        }
      }
      if (p.threshold !== undefined && !(typeof p.threshold === "number" && p.threshold > 0 && p.threshold < 1)) {
        errors.push("payload.threshold 必须在 (0,1)");
      }
      return errors;
    },
  },
  SUBGROUP_BIAS_ASSESSED: {
    aggregate: AGG.STUDY,
    description: "群体偏差评估：儿童/老年人/罕见病等亚组灵敏度差距不得超过非劣界值",
    validate(p) {
      const errors = requireKeys(p, ["assessment_id", "package_id", "reference_group", "worst_group"]);
      if (!isNumber01(p.worst_sensitivity_gap)) {
        errors.push("payload.worst_sensitivity_gap 必须在 [0,1]");
      }
      if (!isNumber01(p.non_inferiority_margin)) {
        errors.push("payload.non_inferiority_margin 必须在 [0,1]");
      }
      if (typeof p.passed !== "boolean") errors.push("payload.passed 必须是布尔值");
      if (p.passed && p.worst_sensitivity_gap > p.non_inferiority_margin) {
        errors.push("passed=true 时最差亚组差距不得超过非劣界值");
      }
      return errors;
    },
  },
  RESEARCH_COMPLETED: {
    aggregate: AGG.STUDY,
    description: "决定一：研究完成（研发医院）——不代表伦理通过、技术验证或院内启用",
    validate(p) {
      const errors = requireKeys(p, ["package_id", "study_ids", "principal_investigator"]);
      if (!isStringArray(p.study_ids) || p.study_ids.length === 0) {
        errors.push("payload.study_ids 必须是非空数组");
      }
      return errors;
    },
  },
  ETHICS_APPROVAL_GRANTED: {
    aggregate: AGG.STUDY,
    description: "决定二：伦理委员会通过，附条件与有效期",
    validate(p) {
      const errors = requireKeys(p, ["package_id", "committee_id", "approval_id", "decided_by"]);
      if (p.valid_until && Number.isNaN(Date.parse(p.valid_until))) {
        errors.push("payload.valid_until 必须是合法时间");
      }
      if (!Array.isArray(p.conditions)) errors.push("payload.conditions 必须是数组");
      if (p.covers_override_non_punitive !== true) {
        errors.push("payload.covers_override_non_punitive 必须为 true：医生覆盖不得成为个人绩效惩罚");
      }
      return errors;
    },
  },
  TECHNICAL_VALIDATION_ACCEPTED: {
    aggregate: AGG.STUDY,
    description: "决定三：联盟技术验证接受——跨院跨设备复现、群体偏差、校验值全部达标",
    validate(p) {
      const errors = requireKeys(p, ["package_id", "accepted_by", "assessment_id"]);
      if (!isStringArray(p.required_device_vendors) || p.required_device_vendors.length === 0) {
        errors.push("payload.required_device_vendors 必须是非空数组（必须证明跨厂商）");
      }
      if (!isStringArray(p.required_populations) || p.required_populations.length === 0) {
        errors.push("payload.required_populations 必须是非空数组（儿童/老年人/罕见病等）");
      }
      if (typeof p.package_sha256_verified !== "boolean" || p.package_sha256_verified === false) {
        errors.push("payload.package_sha256_verified 必须为 true");
      }
      return errors;
    },
  },

  // ── 第四层：clinical_release（启用/调用/覆盖/监测/处置/撤回影响）────────
  RELEASE_ACTIVATED: {
    // [契约事件] 决定四：某机构院内启用，scope 只能是已验证范围的子集
    aggregate: AGG.RELEASE,
    description: "[契约] 机构按适用病种、人群、设备与阈值局部启用模型版本",
    validate(p) {
      const errors = requireKeys(p, [
        "release_id",
        "package_id",
        "institution_id",
        "activated_by",
        "scope",
        "decision_refs",
        "snapshot_fingerprint",
      ]);
      errors.push(...validateScope(p.scope, "payload.scope"));
      const refs = p.decision_refs;
      if (!refs || typeof refs !== "object") {
        errors.push("payload.decision_refs 必须是对象");
      } else {
        for (const d of ["research_event_id", "ethics_event_id", "technical_event_id"]) {
          if (!isNonEmptyString(refs[d])) errors.push(`payload.decision_refs.${d} 必填（前三道决定）`);
        }
      }
      if (p.package_sha256 && !SHA256.test(p.package_sha256)) {
        errors.push("payload.package_sha256 必须是 64 位小写十六进制");
      }
      return errors;
    },
  },
  MODEL_INVOKED: {
    aggregate: AGG.RELEASE,
    description: "临床发起检查：登记适用性判定结果，越界即留痕",
    validate(p) {
      const errors = requireKeys(p, [
        "invocation_id",
        "release_id",
        "institution_id",
        "indication",
        "population_group",
        "device",
        "eligibility",
      ]);
      if (p.eligibility && !["APPLICABLE", "NOT_APPLICABLE", "ESCALATION_REQUIRED"].includes(p.eligibility)) {
        errors.push("payload.eligibility 必须是 APPLICABLE/NOT_APPLICABLE/ESCALATION_REQUIRED");
      }
      if (!isNonEmptyString(p.device?.vendor) || !isNonEmptyString(p.device?.model)) {
        errors.push("payload.device 必须含 vendor 与 model");
      }
      return errors;
    },
  },
  MODEL_PREDICTION_RECORDED: {
    aggregate: AGG.RELEASE,
    description: "预测落库：调用时复核包校验值；原预测永久不可变，回滚也保留",
    validate(p) {
      const errors = requireKeys(p, [
        "invocation_id",
        "prediction_id",
        "package_id",
        "package_sha256_at_call",
        "score",
        "threshold",
        "prediction",
      ]);
      if (!SHA256.test(p.package_sha256_at_call || "")) {
        errors.push("payload.package_sha256_at_call 必须是 64 位小写十六进制");
      }
      if (!isNumber01(p.score)) errors.push("payload.score 必须在 [0,1]");
      if (!(typeof p.threshold === "number" && p.threshold > 0 && p.threshold < 1)) {
        errors.push("payload.threshold 必须在 (0,1)");
      }
      if (!["positive", "negative"].includes(p.prediction)) {
        errors.push("payload.prediction 必须是 positive/negative");
      }
      return errors;
    },
  },
  CLINICIAN_ESCALATION_PERFORMED: {
    aggregate: AGG.RELEASE,
    description: "人工升级已执行：灰区或强制升级情形下由临床人员接手判定",
    validate(p) {
      const errors = requireKeys(p, ["invocation_id", "clinician_id", "reason"]);
      if (!["gray_zone", "mandatory", "clinician_judgment"].includes(p.reason_kind || "")) {
        errors.push("payload.reason_kind 必须是 gray_zone/mandatory/clinician_judgment");
      }
      return errors;
    },
  },
  CLINICIAN_OVERRIDE_RECORDED: {
    aggregate: AGG.RELEASE,
    description:
      "医生覆盖模型判断：必须留临床理由；由接诊医生负责，明确不得用于个人绩效惩罚；不改写原预测",
    validate(p) {
      const errors = requireKeys(p, [
        "invocation_id",
        "prediction_id",
        "clinician_id",
        "clinical_rationale",
        "model_prediction",
        "final_decision",
      ]);
      if (typeof p.clinical_rationale === "string" && p.clinical_rationale.trim().length < 10) {
        errors.push("payload.clinical_rationale 至少 10 个字符：临床理由必须具体");
      }
      if (p.responsibility !== "attending_clinician") {
        errors.push("payload.responsibility 必须是 attending_clinician（覆盖后责任在接诊医生）");
      }
      if (p.performance_penalty_applied !== false) {
        errors.push("payload.performance_penalty_applied 必须为 false（伦理条件）");
      }
      return errors;
    },
  },
  OUT_OF_SCOPE_CALL_RECORDED: {
    aggregate: AGG.RELEASE,
    description: "越界调用留痕：超出启用 scope 的调用被记录，计入该机构该版本的越界次数",
    validate(p) {
      const errors = requireKeys(p, ["invocation_id", "release_id", "institution_id", "violated_dimensions"]);
      if (!isStringArray(p.violated_dimensions) || p.violated_dimensions.length === 0) {
        errors.push("payload.violated_dimensions 必须是非空数组");
      }
      return errors;
    },
  },
  MONITORING_SIGNAL_RAISED: {
    aggregate: AGG.RELEASE,
    description: "启用后持续监测：输入漂移、关键指标、安全事件三类信号",
    validate(p) {
      const errors = requireKeys(p, ["signal_id", "release_id", "institution_id", "kind", "observed", "bound"]);
      if (!["input_drift", "key_metric", "safety"].includes(p.kind || "")) {
        errors.push("payload.kind 必须是 input_drift/key_metric/safety");
      }
      if (typeof p.breached !== "boolean") errors.push("payload.breached 必须是布尔值");
      return errors;
    },
  },
  SAFETY_EVENT_REPORTED: {
    aggregate: AGG.RELEASE,
    description: "安全事件登记，可关联到具体预测用于反向追溯",
    validate(p) {
      const errors = requireKeys(p, ["safety_event_id", "release_id", "institution_id", "reported_by", "severity", "description"]);
      if (!["low", "moderate", "serious", "critical"].includes(p.severity || "")) {
        errors.push("payload.severity 必须是 low/moderate/serious/critical");
      }
      return errors;
    },
  },
  MODEL_SUSPENDED: {
    // [契约事件] 局部暂停：仅针对某机构 × 某模型版本，其他机构不受影响
    aggregate: AGG.RELEASE,
    description: "[契约] 阈值失守、安全事件或越界超标：按机构+模型版本局部暂停",
    validate(p) {
      const errors = requireKeys(p, ["release_id", "institution_id", "package_id", "suspended_by", "reason"]);
      if (!isStringArray(p.trigger_event_ids)) {
        errors.push("payload.trigger_event_ids 必须是数组（暂停必须能指回触发证据；手动暂停可为空但须写明 reason）");
      }
      if (!["threshold_breach", "safety_event", "out_of_scope_quota", "input_drift", "data_withdrawal", "manual"].includes(p.reason || "")) {
        errors.push("payload.reason 取值非法");
      }
      return errors;
    },
  },
  RELEASE_RESUMED: {
    aggregate: AGG.RELEASE,
    description: "暂停解除：信号回到界内并经责任人确认",
    validate(p) {
      const errors = requireKeys(p, ["release_id", "resumed_by", "reason"]);
      if (!isStringArray(p.resolved_signal_ids)) errors.push("payload.resolved_signal_ids 必须是数组");
      return errors;
    },
  },
  RELEASE_ROLLED_BACK: {
    aggregate: AGG.RELEASE,
    description: "版本回滚：切回旧版本或纯人工；历史原预测与校验值全部保留",
    validate(p) {
      const errors = requireKeys(p, ["release_id", "institution_id", "rolled_back_by", "reason"]);
      if (!isNonEmptyString(p.from_package_id)) errors.push("payload.from_package_id 必填");
      // to_package_id 允许为 null，表示回退到纯人工流程
      if (p.to_package_id !== null && p.to_package_id !== undefined && !isNonEmptyString(p.to_package_id)) {
        errors.push("payload.to_package_id 必须是非空字符串或 null（纯人工）");
      }
      if (!isStringArray(p.trigger_event_ids)) {
        errors.push("payload.trigger_event_ids 必须是数组");
      }
      return errors;
    },
  },
  WITHDRAWAL_IMPACT_ASSESSED: {
    aggregate: AGG.RELEASE,
    description:
      "撤回影响评估：沿记录→版本→合成批次→训练→包→验证→放行追溯；既往研究保留，约束未来使用",
    validate(p) {
      const errors = requireKeys(p, ["withdrawal_event_id", "record_id", "assessed_by"]);
      if (!isStringArray(p.affected_dataset_versions)) errors.push("payload.affected_dataset_versions 必须是数组");
      if (!isStringArray(p.affected_run_ids)) errors.push("payload.affected_run_ids 必须是数组");
      if (!isStringArray(p.affected_package_ids)) errors.push("payload.affected_package_ids 必须是数组");
      if (!isStringArray(p.affected_release_ids)) errors.push("payload.affected_release_ids 必须是数组");
      if (p.historical_research_preserved !== true) {
        errors.push("payload.historical_research_preserved 必须为 true：撤回不删除既往研究");
      }
      if (!["block_new_use", "no_future_use_affected"].includes(p.disposition || "")) {
        errors.push("payload.disposition 必须是 block_new_use/no_future_use_affected");
      }
      return errors;
    },
  },
});

export const ALL_EVENT_TYPES = Object.freeze(Object.keys(EVENT_CATALOG));

export function catalogEntry(eventType) {
  return EVENT_CATALOG[eventType] ?? null;
}

/** 校验业务事件：信封合法 + 事件已登记 + payload 结构合法。 */
export function validateDomainEvent(event) {
  // 信封校验由调用方（store）负责组合，这里只做目录与 payload 部分。
  const entry = EVENT_CATALOG[event.event_type];
  if (!entry) return [`未登记的业务事件类型：${event.event_type}`];
  if (entry.aggregate !== event.aggregate_type) {
    return [
      `事件 ${event.event_type} 必须挂在聚合 ${entry.aggregate}，实际为 ${event.aggregate_type}`,
    ];
  }
  const payload = event.payload ?? {};
  return entry.validate(payload).map((m) => `${event.event_type}: ${m}`);
}

export { AGG, CONTRACT_AGGREGATE_TYPES };
