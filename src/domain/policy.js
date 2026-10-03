// 临床调用策略：临床人员在"发起检查时"即可知道
//   1) 模型是否适用于当前病种/人群/设备；
//   2) 什么情况下必须人工升级（灰区、强制升级人群、暂停状态）。
// 规则只读取用 scope（RELEASE_ACTIVATED 冻结的范围）与模型返回分值，不做任何隐式放宽。

export const OUT_OF_SCOPE_QUOTA = 3; // 同一机构 × 同一模型版本越界调用累计上限

export const DEFAULT_INVOCATION_POLICY = Object.freeze({
  grayZoneMargin: 0.05, // |score - threshold| ≤ 0.05 视为灰区，强制人工升级
  // 即便模型在这些人群已验证可靠，机构仍可在用 scope 内声明"必须人工复核"的人群
  mandatoryEscalationPopulations: [],
});

/**
 * 发起检查时的适用性判定。
 * @returns {{eligibility: string, reasons: string[], violatedDimensions: string[], release: object|null}}
 */
export function checkEligibility(model, input, policy = {}) {
  const cfg = { ...DEFAULT_INVOCATION_POLICY, ...policy };
  const release = model.getRelease(input.releaseId);
  if (!release) {
    return {
      eligibility: "NOT_APPLICABLE",
      reasons: ["放行记录不存在"],
      violatedDimensions: ["release"],
      release: null,
    };
  }
  if (release.status === "suspended") {
    return {
      eligibility: "NOT_APPLICABLE",
      reasons: ["该机构此模型版本已局部暂停，禁止调用，走人工流程"],
      violatedDimensions: ["release_status=suspended"],
      release,
    };
  }
  if (release.status === "rolled_back") {
    return {
      eligibility: "NOT_APPLICABLE",
      reasons: ["该机构此模型版本已回滚，禁止调用"],
      violatedDimensions: ["release_status=rolled_back"],
      release,
    };
  }

  const reasons = [];
  const violated = [];
  const scope = release.scope;

  if (!scope.indications.includes(input.indication)) {
    violated.push("indication");
    reasons.push(`病种 ${input.indication} 超出启用范围（${scope.indications.join("/")}）`);
  }
  if (!scope.populations.includes(input.population_group)) {
    violated.push("population");
    reasons.push(`人群 ${input.population_group} 超出启用范围`);
  }
  const deviceHit = scope.devices.some(
    (d) => d.vendor === input.device.vendor && d.model === input.device.model,
  );
  if (!deviceHit) {
    violated.push("device");
    reasons.push(`设备 ${input.device.vendor}/${input.device.model} 不在跨设备验证范围`);
  }

  if (violated.length) {
    return { eligibility: "NOT_APPLICABLE", reasons, violatedDimensions: violated, release };
  }

  // 在适用范围内，但该人群被机构声明为必须人工升级（输出仅供参考）。
  const mandatoryGroups = [
    ...cfg.mandatoryEscalationPopulations,
    ...(release.scope.mandatory_escalation_populations ?? []),
  ];
  if (mandatoryGroups.includes(input.population_group)) {
    return {
      eligibility: "ESCALATION_REQUIRED",
      reasons: [`人群 ${input.population_group} 按机构规则必须人工升级，模型输出仅作参考`],
      violatedDimensions: [],
      release,
    };
  }

  return {
    eligibility: "APPLICABLE",
    reasons: ["适用：病种、人群、设备与阈值均满足启用条件"],
    violatedDimensions: [],
    release,
  };
}

/**
 * 模型出分后的判定：阈值判定 + 灰区强制升级。
 * 原预测始终如实记录；灰区不改变 prediction，只追加人工升级义务。
 */
export function evaluatePrediction(score, threshold, policy = {}) {
  const cfg = { ...DEFAULT_INVOCATION_POLICY, ...policy };
  const prediction = score >= threshold ? "positive" : "negative";
  const distance = Math.abs(score - threshold);
  const grayZone = distance <= cfg.grayZoneMargin;
  return {
    prediction,
    score,
    threshold,
    grayZone,
    mustEscalate: grayZone,
    reason: grayZone
      ? `分值 ${score} 距阈值 ${threshold} 仅 ${distance.toFixed(3)}，进入灰区，必须人工升级`
      : null,
  };
}
