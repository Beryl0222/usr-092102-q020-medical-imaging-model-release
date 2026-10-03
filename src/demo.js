// 端到端叙事演示：node src/demo.js
// 走完"暂缓 → 补齐可执行放行包 → 基层启用 → 临床调用 → 信号失守局部暂停/回滚 → 撤回影响 → 治理追溯"。
import { EventStore } from "./domain/eventStore.js";
import { buildGoldenChain, buildSingleCenterChain, FULL_SCOPE, INDICATION, POPS, SITES, VENDORS } from "./scenario/fixtures.js";
import { tracePrediction, responsibilityChain } from "./domain/traceability.js";
import { releaseMonitoringStatus } from "./domain/monitoring.js";

const line = (t) => console.log(`\n── ${t} ${`─`.repeat(Math.max(0, 64 - t.length))}`);

function printGate(label, evaluation) {
  console.log(`\n${label}：${evaluation.eligible ? "✅ 可启用（放行包可执行）" : "⛔ 不予启用"}`);
  for (const gate of evaluation.gates) {
    console.log(`  ${gate.ok ? "✅" : "⛔"} ${gate.name}`);
    for (const f of gate.findings) console.log(`       · ${f}`);
  }
  if (!evaluation.eligible) console.log(`  阻断项共 ${evaluation.blockers.length} 条`);
}

// 第一幕：第一次申请——只有研发医院平均指标
line("第一幕 首次申请被伦理暂缓：单中心、单厂商、平均指标");
const pilot = buildSingleCenterChain();
const pilotEval = pilot.service.evaluateActivation({
  package_id: pilot.ids.pkgId,
  institution_id: SITES.COMM_A,
  scope: FULL_SCOPE,
});
printGate("基层医院 A 申请启用 pkg-chest-pilot", pilotEval);

// 第二幕：重新申请——可执行放行包
line("第二幕 重新申请：逐层关联的放行包，四道决定分开做出");
const g = buildGoldenChain();
const evalBefore = g.service.evaluateActivation({
  package_id: g.ids.pkgId,
  institution_id: SITES.COMM_A,
  scope: FULL_SCOPE,
});
printGate("证据链补齐后（含跨院跨厂商与儿童/老年/罕见病亚组）", evalBefore);
console.log("  已验证范围：", JSON.stringify({
  indications: evalBefore.validatedScope.indications,
  populations: evalBefore.validatedScope.populations,
  devices: evalBefore.validatedScope.devices,
  threshold: evalBefore.validatedScope.thresholds,
}));
const activation = g.activate("rel-community-a", SITES.COMM_A, "medical-director-a");
console.log(`\n决定四·院内启用 RELEASE_ACTIVATED：${activation.event.event_id}`);
console.log(`  证据快照指纹：${activation.event.payload.snapshot_fingerprint}`);
console.log("  前三道决定引用：", activation.event.payload.decision_refs);

// 第三幕：临床人员发起检查即知适用性
line("第三幕 发起检查即知适用性，何时必须人工升级");
const c1 = g.service.initiateExamination({
  invocation_id: "inv-child-01", release_id: "rel-community-a",
  indication: INDICATION, population_group: POPS.CHILDREN, device: VENDORS.V1,
});
console.log("儿童/V1：", c1.eligibility, "|", c1.reasons[0]);
const c2 = g.service.initiateExamination({
  invocation_id: "inv-rare-01", release_id: "rel-community-a",
  indication: INDICATION, population_group: POPS.RARE, device: VENDORS.V2,
});
console.log("罕见病/V2：", c2.eligibility, "|", c2.reasons[0]);
const c3 = g.service.initiateExamination({
  invocation_id: "inv-oos-01", release_id: "rel-community-a",
  indication: "brain_mri_tumor", population_group: POPS.ADULT, device: VENDORS.V1,
});
console.log("脑肿瘤MRI（越界）：", c3.eligibility, "|", c3.reasons[0]);

// 第四幕：灰区出分 → 强制升级 → 医生覆盖（留理由、非绩效惩罚、原预测保留）
line("第四幕 灰区强制升级；医生覆盖留临床理由且不作绩效惩罚");
const judgment = g.service.recordPrediction({
  invocation_id: "inv-child-01", prediction_id: "pred-child-01",
  package_sha256_at_call: g.ids.sha, score: 0.53,
});
console.log("模型判定：", judgment.prediction, "灰区:", judgment.grayZone, "→", judgment.reason);
g.service.performEscalation({ invocation_id: "inv-child-01", clinician_id: "dr-zhao", reason_kind: "gray_zone", note: "灰区人工复核" });
g.service.recordOverride({
  invocation_id: "inv-child-01", prediction_id: "pred-child-01", clinician_id: "dr-zhao",
  clinical_rationale: "患儿近期卡介苗接种反应可致肺门淋巴结显影，流行病学阴性，判阴性",
  final_decision: "negative",
});
const afterOverride = g.service.model.getPrediction("pred-child-01");
console.log("最终决定：negative（医生覆盖）；原预测仍保留为：", afterOverride.prediction, "；绩效惩罚：", g.service.model.getInvocation("inv-child-01").override.performance_penalty_applied);

// 第五幕：监测越界 → 自动局部暂停 → 回滚，其他机构不受影响
line("第五幕 关键指标失守 → 按机构×版本局部暂停 → 回滚（原预测保留）");
g.activate("rel-community-b", SITES.COMM_B, "medical-director-b");
const sig = g.service.raiseMonitoringSignal({
  signal_id: "sig-sens-01", release_id: "rel-community-a", institution_id: SITES.COMM_A,
  kind: "key_metric", observed: { sensitivity: 0.71 }, bound: { min_sensitivity: 0.85 }, breached: true,
});
console.log("信号越界，自动处置：", sig.auto_suspended.event_type, "-", sig.auto_suspended.payload.reason_text);
console.log("机构A状态：", g.service.model.getRelease("rel-community-a").status,
  "| 机构B状态：", g.service.model.getRelease("rel-community-b").status);
g.service.rollbackRelease({
  release_id: "rel-community-a", rolled_back_by: "governor-ma",
  reason: "灵敏度失守，回退纯人工流程", to_package_id: null,
  trigger_event_ids: [sig.auto_suspended.event_id],
});
console.log("回滚后原预测可查：", !!g.service.model.getPrediction("pred-child-01"));

// 第六幕：撤回触发影响评估，不删既往研究
line("第六幕 数据撤回 → 影响评估（既往研究与历史预测保留）");
const w = g.service.withdrawData({ record_id: "rec-001", withdrawn_by: "patient-guardian", reason: "撤回知情同意" });
console.log("处置：", w.impact.payload.disposition);
console.log("受影响版本：", w.impact.payload.affected_dataset_versions);
console.log("受影响包：", w.impact.payload.affected_package_ids, "；受影响放行：", w.impact.payload.affected_release_ids);
console.log("既往研究保留：", w.impact.payload.historical_research_preserved, "；事件总数只增不减：", g.service.store.length);
console.log(
  "自动局部暂停：",
  w.suspensions.map((e) => `${e.payload.package_id}@${e.payload.institution_id}（${e.payload.reason}）`).join("；") || "（无活跃 release）",
);
console.log(
  "机构A此前已回滚，状态：", g.service.model.getRelease("rel-community-a").status,
  "；机构B受撤回牵连：", g.service.model.getRelease("rel-community-b").status,
);
// 撤回后重新尝试在同一版本上训练会被门禁拒绝
try {
  g.service.startTrainingRun({ run_id: "run-new-after-withdraw", dataset_version_id: g.ids.dvId, started_by: "ml-engineer-chen", purpose: "chest_xray_tuberculosis_model" });
} catch (e) {
  console.log("撤回后再训练被拒：", e.code, "-", e.details?.problems?.[0] ?? e.message);
}

// 第七幕：治理追溯
line("第七幕 从异常结果追到数据/验证/发布/处置与每层责任人");
const trace = tracePrediction(g.service.model, "pred-child-01");
console.log("追溯层级：", ["release", "package(sha256)", "training", "data(授权/脱敏/争议/合成)", "validation(跨院跨设备/亚组)", "decisions(四道决定)", "disposition(暂停/回滚)"].join(" → "));
for (const c of responsibilityChain(trace)) console.log(`  · ${c.layer}：${c.owner}（${c.event_id}）`);

// 完整性自检
line("事件日志完整性自检（哈希链）");
console.log(g.service.store.verifyIntegrity());

console.log("\n演示结束。");
