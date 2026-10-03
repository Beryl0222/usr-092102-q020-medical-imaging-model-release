const CHECKSUM_RE = /^sha256:[0-9a-f]{64}$/i;

export const SUSPEND_REASONS = [
  "OUT_OF_BOUNDARY_CALL",
  "THRESHOLD_BREACH",
  "SAFETY_EVENT",
  "DATA_WITHDRAWAL_IMPACT",
  "MANUAL",
];

export const DECISION_KEYS = [
  "research_completed",
  "ethics_approved",
  "technical_validated",
  "site_activated",
];

const DECISION_LABELS = {
  research_completed: "研究完成",
  ethics_approved: "伦理通过",
  technical_validated: "技术验证",
  site_activated: "院内启用",
};

const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isRatio = (value) => typeof value === "number" && value >= 0 && value <= 1;
const isDateTime = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isTextArray = (value) => Array.isArray(value) && value.length > 0 && value.every(isText);

/**
 * 五类领域事件的放行载荷规则。信封格式由 contracts/domain.schema.json 保证，
 * 这里校验“可执行放行包”所需的逐层关联：授权/脱敏/标注/合成 → 训练运行与
 * 校验值 → 跨院跨设备复现与群体指标 → 四个决定、用途边界、责任分工 → 局部暂停。
 */
export function validatePayloadRules(event, projections) {
  const rule = RULES[event.event_type];
  return rule ? rule(event, projections) : [];
}

const RULES = {
  DATASET_APPROVED: datasetApproved,
  MODEL_TRAINED: modelTrained,
  VALIDATION_COMPLETED: validationCompleted,
  RELEASE_ACTIVATED: releaseActivated,
  MODEL_SUSPENDED: modelSuspended,
};

function datasetApproved(event, projections) {
  const errors = [];
  if (event.dataset_version_id !== event.aggregate_id) {
    errors.push("dataset_version_id 必须与 aggregate_id 一致");
  }
  if (projections.datasets.has(event.aggregate_id)) {
    errors.push(`数据集版本已获批：${event.aggregate_id}`);
  }

  const authorization = event.authorization;
  if (!authorization || typeof authorization !== "object") {
    errors.push("缺少数据授权 authorization");
  } else {
    for (const field of ["authorization_id", "granted_by", "granted_at", "withdrawal_terms"]) {
      if (!isText(authorization[field])) errors.push(`数据授权缺少 ${field}`);
    }
    if (!isTextArray(authorization.purposes)) errors.push("数据授权必须声明用途 purposes");
    if (isText(authorization.granted_at) && !isDateTime(authorization.granted_at)) {
      errors.push("数据授权 granted_at 必须是日期时间");
    }
    if (isText(authorization.authorization_id) && projections.authorizations.has(authorization.authorization_id)) {
      errors.push(`授权编号已登记：${authorization.authorization_id}`);
    }
  }

  const deidentification = event.deidentification;
  if (!deidentification || typeof deidentification !== "object") {
    errors.push("缺少脱敏验证 deidentification");
  } else {
    for (const field of ["method", "verified_by", "verified_at"]) {
      if (!isText(deidentification[field])) errors.push(`脱敏验证缺少 ${field}`);
    }
    if (deidentification.passed !== true) errors.push("脱敏验证未通过，数据集不得获批");
    if (!["low", "medium"].includes(deidentification.residual_risk)) {
      errors.push("残余再识别风险 residual_risk 必须为 low 或 medium");
    }
  }

  const annotation = event.annotation;
  if (!annotation || typeof annotation !== "object") {
    errors.push("缺少标注信息 annotation");
  } else {
    if (!isText(annotation.schema_version)) errors.push("标注缺少 schema_version");
    if (!isText(annotation.adjudication)) errors.push("标注缺少仲裁方式 adjudication");
    if (!Number.isInteger(annotation.open_disputes) || annotation.open_disputes < 0) {
      errors.push("open_disputes 必须是非负整数");
    } else if (annotation.open_disputes > 0) {
      errors.push(`尚有 ${annotation.open_disputes} 条标注争议未裁决，数据集不得获批`);
    }
  }

  const synthetic = event.synthetic;
  if (!synthetic || typeof synthetic !== "object") {
    errors.push("缺少合成数据说明 synthetic");
  } else {
    if (!isRatio(synthetic.ratio)) errors.push("合成占比 synthetic.ratio 必须是 0..1 的数值");
    if (isRatio(synthetic.ratio) && synthetic.ratio > 0) {
      if (!isText(synthetic.generator)) errors.push("使用合成数据必须登记生成器 generator");
      if (!isText(synthetic.provenance)) errors.push("使用合成数据必须说明来源 provenance");
    }
  }

  if (!isTextArray(event.institutions)) errors.push("必须登记来源机构 institutions");
  return errors;
}

function modelTrained(event, projections) {
  const errors = [];
  if (event.model_version !== event.aggregate_id) {
    errors.push("model_version 必须与 aggregate_id 一致");
  }
  if (projections.models.has(event.aggregate_id)) {
    errors.push(`模型版本已登记：${event.aggregate_id}`);
  }
  if (!isText(event.training_run_id)) errors.push("缺少训练运行 training_run_id");
  if (!isText(event.code_ref)) errors.push("缺少训练代码/配置引用 code_ref");
  if (!CHECKSUM_RE.test(event.package_checksum ?? "")) {
    errors.push("模型包校验值 package_checksum 必须是 sha256:<64位十六进制>");
  }
  if (!isRatio(event.synthetic_ratio)) errors.push("synthetic_ratio 必须是 0..1 的数值");

  const datasetIds = event.dataset_version_ids;
  if (!Array.isArray(datasetIds) || datasetIds.length === 0) {
    errors.push("必须引用至少一个已获批的数据集版本 dataset_version_ids");
  } else {
    const ratios = [];
    for (const id of datasetIds) {
      const dataset = projections.datasets.get(id);
      if (!dataset) {
        errors.push(`数据集版本未获批：${id}`);
        continue;
      }
      const authorization = projections.authorizations.get(dataset.authorization.authorization_id);
      if (authorization?.status === "withdrawn") {
        errors.push(`数据集 ${id} 的授权已撤回，不得用于新的训练`);
      }
      ratios.push(dataset.synthetic.ratio);
    }
    if (ratios.length > 0 && isRatio(event.synthetic_ratio)) {
      const low = Math.min(...ratios);
      const high = Math.max(...ratios);
      if (event.synthetic_ratio < low - 1e-9 || event.synthetic_ratio > high + 1e-9) {
        errors.push(`合成占比 ${event.synthetic_ratio} 超出所引数据集占比范围 [${low}, ${high}]`);
      }
    }
  }
  return errors;
}

function validationCompleted(event, projections) {
  const errors = [];
  if (event.study_id !== event.aggregate_id) {
    errors.push("study_id 必须与 aggregate_id 一致");
  }
  if (projections.studies.has(event.aggregate_id)) {
    errors.push(`验证研究已登记：${event.aggregate_id}`);
  }

  const model = projections.models.get(event.model_version);
  if (!model) {
    errors.push(`模型版本不存在：${event.model_version}`);
  } else if (model.package_checksum !== event.package_checksum) {
    errors.push("验证的模型包校验值与训练登记不一致");
  }

  const reproduction = event.reproduction;
  if (!reproduction || !Array.isArray(reproduction.sites) || reproduction.sites.length === 0) {
    errors.push("缺少跨院跨设备复现结果 reproduction.sites");
  } else {
    const institutions = new Set();
    const vendors = new Set();
    reproduction.sites.forEach((site, index) => {
      if (!isText(site.institution_id)) errors.push(`复现站点[${index}]缺少 institution_id`);
      if (!isText(site.vendor)) errors.push(`复现站点[${index}]缺少设备厂商 vendor`);
      for (const metric of ["sensitivity", "specificity"]) {
        if (!isRatio(site[metric])) errors.push(`复现站点[${index}] ${metric} 必须是 0..1 的数值`);
      }
      if (!Number.isInteger(site.n) || site.n < 1) errors.push(`复现站点[${index}] 样本量 n 必须 ≥ 1`);
      institutions.add(site.institution_id);
      vendors.add(site.vendor);
    });
    if (institutions.size < 2) errors.push("跨院复现至少需要 2 家机构");
    if (vendors.size < 2) errors.push("跨设备复现至少需要 2 家厂商");
  }

  const groupMetrics = event.group_metrics;
  if (!groupMetrics || typeof groupMetrics !== "object" || Array.isArray(groupMetrics) || Object.keys(groupMetrics).length === 0) {
    errors.push("缺少分群指标 group_metrics");
  } else {
    for (const [group, metrics] of Object.entries(groupMetrics)) {
      if (!metrics || typeof metrics !== "object") {
        errors.push(`人群 ${group} 指标缺失`);
        continue;
      }
      if (!isRatio(metrics.sensitivity)) errors.push(`人群 ${group} 缺少灵敏度 sensitivity`);
      if (!isRatio(metrics.ci_lower)) {
        errors.push(`人群 ${group} 缺少置信下限 ci_lower`);
      } else if (isRatio(metrics.sensitivity) && metrics.ci_lower > metrics.sensitivity) {
        errors.push(`人群 ${group} 置信下限不能高于点估计`);
      }
      if (!Number.isInteger(metrics.n) || metrics.n < 1) errors.push(`人群 ${group} 样本量 n 必须 ≥ 1`);
    }
  }

  const coverage = event.coverage;
  if (!coverage || typeof coverage !== "object") {
    errors.push("缺少验证覆盖范围 coverage");
  } else {
    for (const field of ["diseases", "populations", "device_vendors"]) {
      if (!isTextArray(coverage[field])) errors.push(`coverage.${field} 必须是非空字符串数组`);
    }
    if (isTextArray(coverage.populations) && groupMetrics && typeof groupMetrics === "object") {
      for (const population of coverage.populations) {
        if (!groupMetrics[population]) errors.push(`覆盖人群 ${population} 缺少分群指标`);
      }
    }
    if (isTextArray(coverage.device_vendors) && Array.isArray(reproduction?.sites)) {
      for (const vendor of coverage.device_vendors) {
        if (!reproduction.sites.some((site) => site.vendor === vendor)) {
          errors.push(`覆盖厂商 ${vendor} 未出现在复现站点中`);
        }
      }
    }
  }

  if (!isRatio(event.thresholds?.operating_point)) {
    errors.push("缺少工作点阈值 thresholds.operating_point");
  }
  return errors;
}

function releaseActivated(event, projections) {
  const errors = [];
  if (event.release_id !== event.aggregate_id) {
    errors.push("release_id 必须与 aggregate_id 一致");
  }
  const kind = event.activation_kind;
  if (!["initial", "rollback", "reactivation"].includes(kind)) {
    errors.push("activation_kind 必须是 initial / rollback / reactivation");
  }
  const existing = projections.releases.get(event.aggregate_id);
  if (kind === "initial") {
    if (existing) errors.push(`放行已存在：${event.aggregate_id}`);
    const occupied = projections.byScope(event.institution_id, event.model_version);
    if (occupied?.status === "active") {
      errors.push(`机构 ${event.institution_id} 已启用版本 ${event.model_version}（${occupied.release_id}）`);
    }
  }
  if (kind === "rollback" || kind === "reactivation") {
    if (!existing) {
      errors.push("回滚/再激活的放行不存在");
    } else if (existing.status !== "suspended") {
      errors.push("仅可对已暂停的放行执行回滚/再激活");
    }
  }
  if (kind === "rollback" && event.retains_predictions !== true) {
    errors.push("回滚必须声明 retains_predictions: true（保留原预测）");
  }
  if (existing) {
    if (event.institution_id && event.institution_id !== existing.institution_id) {
      errors.push("放行记录与机构不一致");
    }
    if (event.model_version && event.model_version !== existing.model_version) {
      errors.push("放行记录与模型版本不一致");
    }
  }

  if (!isText(event.institution_id)) errors.push("缺少机构 institution_id");
  if (!isText(event.model_version)) errors.push("缺少模型版本 model_version");
  const model = projections.models.get(event.model_version);
  if (isText(event.model_version) && !model) {
    errors.push(`模型版本不存在：${event.model_version}`);
  }
  if (model) {
    const lineage = projections.modelLineage(event.model_version);
    for (const authorization of lineage.authorizations) {
      if (authorization.status === "withdrawn") {
        errors.push(`训练数据授权已撤回（${authorization.authorization_id}），该版本不得启用`);
      }
    }
  }

  const decisions = event.decisions ?? existing?.decisions;
  if (kind === "initial" && !event.decisions) {
    errors.push("首次启用必须包含四个决定 decisions（研究完成/伦理通过/技术验证/院内启用）");
  }
  let study = null;
  if (decisions) {
    for (const key of DECISION_KEYS) {
      const decision = decisions[key];
      if (!decision || typeof decision !== "object") {
        errors.push(`缺少决定：${DECISION_LABELS[key]}（${key}）`);
        continue;
      }
      if (!isText(decision.decided_by)) errors.push(`决定 ${DECISION_LABELS[key]} 缺少 decided_by`);
      if (!isText(decision.reference)) errors.push(`决定 ${DECISION_LABELS[key]} 缺少依据 reference`);
      if (!isDateTime(decision.decided_at)) errors.push(`决定 ${DECISION_LABELS[key]} 缺少合法时间 decided_at`);
    }
    const times = DECISION_KEYS.map((key) => Date.parse(decisions[key]?.decided_at));
    if (times.every((time) => !Number.isNaN(time))) {
      for (let index = 1; index < times.length; index += 1) {
        if (times[index] < times[index - 1]) {
          errors.push("四个决定的时序必须是 研究完成 ≤ 伦理通过 ≤ 技术验证 ≤ 院内启用");
          break;
        }
      }
    }
    const reference = decisions.technical_validated?.reference;
    if (isText(reference)) {
      study = projections.studies.get(reference) ?? null;
      if (!study) errors.push(`技术验证决定引用的研究不存在：${reference}`);
      else if (study.model_version !== event.model_version) {
        errors.push("技术验证研究与放行模型版本不一致");
      }
    }
  }

  const boundary = event.boundary ?? existing?.boundary;
  if (kind === "initial" && !event.boundary) errors.push("首次启用必须声明用途边界 boundary");
  if (boundary) {
    for (const field of ["diseases", "populations", "device_vendors"]) {
      if (!isTextArray(boundary[field])) errors.push(`boundary.${field} 必须是非空字符串数组`);
    }
    if (!isRatio(boundary.thresholds?.operating_point)) {
      errors.push("boundary.thresholds.operating_point 必须是 0..1 的数值");
    }
    if (!isRatio(boundary.thresholds?.min_sensitivity)) {
      errors.push("boundary.thresholds.min_sensitivity 必须是 0..1 的数值");
    }
    const escalatePopulations = boundary.escalation?.always_escalate_populations;
    if (escalatePopulations != null && !Array.isArray(escalatePopulations)) {
      errors.push("boundary.escalation.always_escalate_populations 必须是数组");
    }
    if (Array.isArray(escalatePopulations) && isTextArray(boundary.populations)) {
      for (const population of escalatePopulations) {
        if (!boundary.populations.includes(population)) {
          errors.push(`强制人工升级人群 ${population} 不在用途边界内`);
        }
      }
    }
    if (study) checkBoundaryWithinCoverage(boundary, study, event.institution_id, errors);
  }

  const responsibility = event.responsibility ?? existing?.responsibility;
  if (!responsibility) {
    errors.push("缺少责任分工 responsibility");
  } else {
    for (const role of ["model_owner", "clinical_owner", "data_steward", "safety_officer"]) {
      if (!isText(responsibility[role])) errors.push(`责任分工缺少 ${role}`);
    }
  }

  const monitoring = event.monitoring ?? existing?.monitoring;
  if (!monitoring) {
    errors.push("缺少监测方案 monitoring");
  } else {
    if (!isRatio(monitoring.drift?.psi_max)) errors.push("监测方案缺少漂移上限 monitoring.drift.psi_max");
    if (!isRatio(monitoring.metric_floors?.sensitivity_min)) {
      errors.push("监测方案缺少指标下限 monitoring.metric_floors.sensitivity_min");
    }
    if (!Number.isInteger(monitoring.evaluation_window_days) || monitoring.evaluation_window_days < 1) {
      errors.push("监测方案缺少评估窗口 monitoring.evaluation_window_days");
    }
  }
  return errors;
}

function checkBoundaryWithinCoverage(boundary, study, institutionId, errors) {
  for (const disease of boundary.diseases ?? []) {
    if (!study.coverage.diseases.includes(disease)) errors.push(`病种超出验证覆盖：${disease}`);
  }
  for (const population of boundary.populations ?? []) {
    if (!study.coverage.populations.includes(population)) {
      errors.push(`人群超出验证覆盖：${population}`);
      continue;
    }
    const metrics = study.group_metrics[population];
    const floor = boundary.thresholds?.min_sensitivity;
    if (metrics && isRatio(floor) && metrics.ci_lower < floor) {
      errors.push(`人群 ${population} 灵敏度置信下限 ${metrics.ci_lower} 低于放行阈值 ${floor}`);
    }
  }
  for (const vendor of boundary.device_vendors ?? []) {
    if (!study.coverage.device_vendors.includes(vendor)) errors.push(`设备厂商超出验证覆盖：${vendor}`);
  }
  if (
    isRatio(boundary.thresholds?.operating_point) &&
    boundary.thresholds.operating_point !== study.thresholds.operating_point
  ) {
    errors.push("工作点必须采用验证研究确定的值");
  }
  if (isText(institutionId) && !study.reproduction.sites.some((site) => site.institution_id === institutionId)) {
    errors.push(`验证研究未覆盖启用机构 ${institutionId} 的复现`);
  }
}

function modelSuspended(event, projections) {
  const errors = [];
  if (event.release_id !== event.aggregate_id) {
    errors.push("release_id 必须与 aggregate_id 一致");
  }
  const release = projections.releases.get(event.aggregate_id);
  if (!release) {
    errors.push(`放行不存在：${event.aggregate_id}`);
    return errors;
  }
  if (release.status !== "active") errors.push("仅可暂停处于启用状态的放行");
  if (!SUSPEND_REASONS.includes(event.reason)) {
    errors.push(`暂停原因 reason 必须是 ${SUSPEND_REASONS.join(" / ")} 之一`);
  }
  if (!isText(event.detail)) errors.push("暂停必须说明 detail");
  if (!isDateTime(event.effective_at)) errors.push("缺少生效时间 effective_at");
  const scope = event.scope;
  if (!scope || scope.institution_id !== release.institution_id || scope.model_version !== release.model_version) {
    errors.push("暂停范围 scope 必须与放行的机构和模型版本一致（局部暂停）");
  }
  return errors;
}
