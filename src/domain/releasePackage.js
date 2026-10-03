// 放行包评估：把"平均指标报告"升级为"可执行放行包"的核心策略。
//
// 四道决定彼此独立，任何一道都不能由其他道推定：
//   1) RESEARCH_COMPLETED        研究完成（研发医院）
//   2) ETHICS_APPROVAL_GRANTED   伦理通过（附条件、有效期、非惩罚条款）
//   3) TECHNICAL_VALIDATION_ACCEPTED 技术验证（跨院跨厂商 + 群体偏差 + 校验值）
//   4) RELEASE_ACTIVATED         院内启用（某机构，scope 必须是已验证范围的子集）
//
// 本模块只负责 1~3 与全链路门禁，并对第 4 道决定的 scope 请求做子集判定；
// 是否写入 RELEASE_ACTIVATED 由应用服务在门禁全绿后执行。
import { createHash } from "node:crypto";

export const DEFAULT_POLICY = Object.freeze({
  minSites: 2, // 至少两家医院，避免"研发医院单中心达标"
  minSensitivity: 0.9, // 每个必需亚组的灵敏度点估计下限
  minSensitivityCiLow: 0.8, // 灵敏度 95%CI 下限不得低于该值
  minSubgroupN: 30, // 亚组最小样本量（罕见病可由政策另行放宽）
  maxSyntheticRatio: 0.5, // 合成数据在训练集中的占比上限
  requiredPopulations: ["children", "elderly", "rare_disease"],
});

const ok = (id, name) => ({ id, name, ok: true, findings: [] });
const fail = (id, name, findings) => ({ id, name, ok: false, findings });

function stratumPass(s, policy) {
  return (
    s.n >= policy.minSubgroupN &&
    s.sensitivity >= policy.minSensitivity &&
    s.ci_low >= policy.minSensitivityCiLow
  );
}

/**
 * 评估一个模型包是否具备在某机构按某 scope 启用的条件。
 * @param {ReadModel} model
 * @param {object} input { packageId, institutionId, scope, at, policy }
 */
export function evaluateReleasePackage(model, input) {
  const policy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) };
  const at = input.at ?? new Date().toISOString();
  const pkg = model.getPackage(input.packageId);
  const gates = [];
  const blockers = [];
  const addGate = (gate) => {
    gates.push(gate);
    if (!gate.ok) blockers.push(...gate.findings);
  };

  if (!pkg) {
    return {
      packageId: input.packageId,
      eligible: false,
      gates: [fail("package", "模型包", ["模型包未登记"])],
      blockers: ["模型包未登记"],
      validatedScope: null,
      requestedScope: input.scope ?? null,
      snapshotFingerprint: null,
      decisions: emptyDecisions(),
    };
  }

  // ── 门禁 0：血缘存在（包 → 训练运行 → 冻结数据集版本）──────────────────
  const lineage = model.packageLineage(pkg.package_id);
  const lineageFindings = [];
  if (!lineage.run) lineageFindings.push("缺少训练运行登记");
  if (!lineage.datasetVersion) lineageFindings.push("训练运行未绑定冻结的数据集版本");
  if (pkg.trained && pkg.trained.sha256 !== pkg.sha256) {
    lineageFindings.push("MODEL_TRAINED 记录的 sha256 与包登记值不一致");
  }
  addGate(
    lineageFindings.length
      ? fail("lineage", "血缘关联（包→运行→数据集）", lineageFindings)
      : ok("lineage", "血缘关联（包→运行→数据集）"),
  );

  // ── 门禁 1：数据治理（授权/撤回/脱敏/争议/合成占比）────────────────────
  const dataFindings = [];
  const dvStatus = lineage.datasetVersion
    ? model.datasetVersionStatus(lineage.datasetVersion.dataset_version_id)
    : null;
  if (dvStatus) dataFindings.push(...dvStatus.problems);
  const ratio =
    lineage.syntheticRatio ?? dvStatus?.datasetVersion?.synthetic_ratio;
  if (typeof ratio === "number" && ratio > policy.maxSyntheticRatio) {
    dataFindings.push(`合成数据占比 ${(ratio * 100).toFixed(1)}% 超过上限 ${policy.maxSyntheticRatio * 100}%`);
  }
  if (dvStatus && !dvStatus.approved) {
    dataFindings.push("数据集版本缺少 DATASET_APPROVED 治理放行");
  }
  addGate(
    dataFindings.length
      ? fail("data_governance", "数据授权/撤回/脱敏/争议/合成", dataFindings)
      : ok("data_governance", "数据授权/撤回/脱敏/争议/合成"),
  );

  // ── 门禁 2：跨院跨设备复现 ────────────────────────────────────────────
  const evidence = model.packageEvidence(pkg.package_id);
  const reproFindings = [];
  if (evidence.studies.length === 0) {
    reproFindings.push("没有任何 VALIDATION_COMPLETED 研究证据");
  }
  if (evidence.sites.length < policy.minSites) {
    reproFindings.push(`仅在 ${evidence.sites.length} 家医院验证，至少需要 ${policy.minSites} 家`);
  }
  addGate(
    reproFindings.length
      ? fail("reproducibility", "跨医院复现", reproFindings)
      : ok("reproducibility", "跨医院复现"),
  );

  // ── 门禁 3：群体偏差（儿童/老年人/罕见病等亚组逐一过关，含厂商维度）────
  const subgroupFindings = [];
  // 每个 (人群) 在每家厂商设备上都要有达标的亚组证据。
  const vendorCoverage = new Map(); // vendor -> {studied, failed:[msg]}
  const passedGroupVendor = new Set(); // "group|vendor"
  const failedGroupVendor = new Map(); // "group|vendor" -> reasons
  for (const study of evidence.studies) {
    for (const s of study.strata) {
      const key = `${s.group_key}|${study.device_vendor}`;
      vendorCoverage.set(study.device_vendor, true);
      if (stratumPass(s, policy)) {
        passedGroupVendor.add(key);
      } else {
        const reasons = [];
        if (s.n < policy.minSubgroupN) reasons.push(`n=${s.n} < ${policy.minSubgroupN}`);
        if (s.sensitivity < policy.minSensitivity) reasons.push(`灵敏度=${s.sensitivity} < ${policy.minSensitivity}`);
        if (s.ci_low < policy.minSensitivityCiLow) reasons.push(`CI下限=${s.ci_low} < ${policy.minSensitivityCiLow}`);
        failedGroupVendor.set(key, reasons.join("；"));
      }
    }
  }
  const requiredVendors =
    model.technicalByPackage.get(pkg.package_id)?.required_device_vendors ??
    evidence.vendors; // 技术决定未登记时以实际覆盖为准并在后续门禁报错
  for (const group of policy.requiredPopulations) {
    for (const vendor of requiredVendors) {
      const key = `${group}|${vendor}`;
      if (failedGroupVendor.has(key)) {
        subgroupFindings.push(`亚组 ${group} 在厂商 ${vendor} 设备上未达标（${failedGroupVendor.get(key)}）`);
      } else if (!passedGroupVendor.has(key)) {
        subgroupFindings.push(`缺少亚组 ${group} 在厂商 ${vendor} 设备上的达标证据`);
      }
    }
  }
  addGate(
    subgroupFindings.length
      ? fail("subgroup_bias", "群体偏差（儿童/老年人/罕见病 × 厂商）", subgroupFindings)
      : ok("subgroup_bias", "群体偏差（儿童/老年人/罕见病 × 厂商）"),
  );

  // ── 决定一：研究完成 ──────────────────────────────────────────────────
  const research = model.researchByPackage.get(pkg.package_id);
  const researchFindings = [];
  if (!research) researchFindings.push("缺少 RESEARCH_COMPLETED 事件");
  else if (!research.study_ids.every((id) => model.studies.has(id))) {
    researchFindings.push("研究完成事件引用了不存在的 validation_study");
  }
  if (research && research.study_ids.some((id) => model.studies.get(id)?.package_id !== pkg.package_id)) {
    researchFindings.push("研究完成事件引用了其他模型包的研究");
  }
  addGate(
    researchFindings.length
      ? fail("decision_research", "决定一：研究完成", researchFindings)
      : ok("decision_research", "决定一：研究完成"),
  );

  // ── 决定二：伦理通过 ──────────────────────────────────────────────────
  const ethics = model.ethicsByPackage.get(pkg.package_id);
  const ethicsFindings = [];
  if (!ethics) ethicsFindings.push("缺少 ETHICS_APPROVAL_GRANTED 事件");
  else {
    if (ethics.valid_until && Date.parse(ethics.valid_until) < Date.parse(at)) {
      ethicsFindings.push(`伦理批件已于 ${ethics.valid_until} 过期`);
    }
    if (ethics.covers_override_non_punitive !== true) {
      ethicsFindings.push("伦理条件未承诺：医生覆盖不得成为个人绩效惩罚");
    }
  }
  addGate(
    ethicsFindings.length
      ? fail("decision_ethics", "决定二：伦理通过", ethicsFindings)
      : ok("decision_ethics", "决定二：伦理通过"),
  );

  // ── 决定三：技术验证接受 ──────────────────────────────────────────────
  const technical = model.technicalByPackage.get(pkg.package_id);
  const techFindings = [];
  if (!technical) techFindings.push("缺少 TECHNICAL_VALIDATION_ACCEPTED 事件");
  else {
    if (technical.package_sha256_verified !== true) techFindings.push("技术验证未复核包校验值");
    if (technical.verified_sha256 && technical.verified_sha256 !== pkg.sha256) {
      techFindings.push("技术验证复核的 sha256 与登记包不一致");
    }
    const missingVendors = technical.required_device_vendors.filter(
      (v) => !evidence.vendors.includes(v),
    );
    if (missingVendors.length) techFindings.push(`技术要求的厂商缺少研究证据：${missingVendors.join(", ")}`);
    const missingPops = technical.required_populations.filter(
      (g) => !evidence.populations.includes(g),
    );
    if (missingPops.length) techFindings.push(`技术要求的人群缺少研究证据：${missingPops.join(", ")}`);
  }
  addGate(
    techFindings.length
      ? fail("decision_technical", "决定三：技术验证接受", techFindings)
      : ok("decision_technical", "决定三：技术验证接受"),
  );

  // ── 已验证范围（亚组达标后才进入）──────────────────────────────────────
  const validatedScope = computeValidatedScope(model, pkg.package_id, policy);

  // ── 请求 scope 必须是已验证范围的子集（病种/人群/设备/阈值全部满足）─────
  const scopeFindings = [];
  const requested = input.scope;
  if (!requested) {
    scopeFindings.push("启用请求必须声明 scope（病种、人群、设备、阈值）");
  } else {
    for (const ind of requested.indications ?? []) {
      if (!validatedScope.indications.includes(ind)) scopeFindings.push(`病种 ${ind} 不在已验证范围`);
    }
    for (const pop of requested.populations ?? []) {
      if (!validatedScope.populations.includes(pop)) scopeFindings.push(`人群 ${pop} 无达标亚组证据`);
    }
    for (const dev of requested.devices ?? []) {
      const hit = validatedScope.devices.some((d) => d.vendor === dev.vendor && d.model === dev.model);
      if (!hit) scopeFindings.push(`设备 ${dev.vendor}/${dev.model} 不在跨设备验证范围`);
    }
    if (requested.threshold === undefined) {
      scopeFindings.push("启用请求必须固定阈值");
    } else if (!validatedScope.thresholds.includes(requested.threshold)) {
      scopeFindings.push(
        `阈值 ${requested.threshold} 未经验证（已验证阈值：${validatedScope.thresholds.join(", ")}）`,
      );
    }
  }
  addGate(
    scopeFindings.length
      ? fail("activation_scope", "决定四前置：启用 scope ⊆ 已验证范围", scopeFindings)
      : ok("activation_scope", "决定四前置：启用 scope ⊆ 已验证范围"),
  );

  // ── 证据快照指纹：激活时冻结，事后可证明"当时依据了什么"────────────────
  const evidenceEventIds = [
    pkg.package_event_id,
    pkg.trained?.event_id,
    lineage.run?.started_event_id,
    ...(dvStatus?.approvals.map((a) => a.event_id) ?? []),
    ...(dvStatus?.deid ? [dvStatus.deid.event_id] : []),
    ...evidence.studies.map((s) => s.event_id),
    ...evidence.biasAssessments.map((a) => a.event_id),
    research?.event_id,
    ethics?.event_id,
    technical?.event_id,
  ].filter(Boolean);
  const snapshotFingerprint = createHash("sha256")
    .update([pkg.sha256, ...evidenceEventIds].sort().join("\n"), "utf8")
    .digest("hex");

  return {
    packageId: pkg.package_id,
    eligible: gates.every((g) => g.ok),
    gates,
    blockers,
    validatedScope,
    requestedScope: requested ?? null,
    snapshotFingerprint,
    decisions: {
      research: research
        ? { made: true, event_id: research.event_id, principal_investigator: research.principal_investigator }
        : { made: false },
      ethics: ethics
        ? { made: true, event_id: ethics.event_id, committee_id: ethics.committee_id, valid_until: ethics.valid_until }
        : { made: false },
      technical: technical
        ? { made: true, event_id: technical.event_id, accepted_by: technical.accepted_by }
        : { made: false },
      activation: { made: false }, // 由服务在 eligible=true 且写入 RELEASE_ACTIVATED 后补齐
    },
  };
}

/** 由达标的亚组证据反查"真正被证明可靠"的适用范围。 */
export function computeValidatedScope(model, packageId, policy) {
  const evidence = model.packageEvidence(packageId);
  const indications = new Set();
  const populations = new Set();
  const devices = new Map(); // vendor|model -> {vendor,model}
  const thresholds = new Set();
  for (const study of evidence.studies) {
    const allStrataPass = study.strata.every((s) => stratumPass(s, policy));
    if (!allStrataPass) continue; // 该研究任一必需报告亚组不达标，则不把该设备组合计入
    for (const ind of study.indications ?? []) indications.add(ind);
    for (const s of study.strata) populations.add(s.group_key);
    devices.set(`${study.device_vendor}|${study.device_model}`, {
      vendor: study.device_vendor,
      model: study.device_model,
    });
    thresholds.add(study.threshold);
  }
  return {
    indications: [...indications].sort(),
    populations: [...populations].sort(),
    devices: [...devices.values()],
    thresholds: [...thresholds].sort(),
  };
}

function emptyDecisions() {
  return {
    research: { made: false },
    ethics: { made: false },
    technical: { made: false },
    activation: { made: false },
  };
}
