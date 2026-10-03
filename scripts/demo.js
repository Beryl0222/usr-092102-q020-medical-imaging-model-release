import {
  IDS,
  datasetApprovedEvent,
  modelTrainedEvent,
  releaseActivatedEvent,
  v110Events,
  validationCompletedEvent,
} from "../examples/scenario.js";
import { createReleaseSystem } from "../src/system.js";

const line = (title) => console.log(`\n=== ${title} ===`);
const show = (label, value) => console.log(label, JSON.stringify(value, null, 2));

const sys = await createReleaseSystem();

line("1. 数据集获批：授权/撤回条款、脱敏验证、标注争议裁决、合成来源");
await sys.appendEvent(datasetApprovedEvent());
console.log("数据集 ds-chest-ct-v3 获批（合成占比 0.2，争议 0 条未决，脱敏通过）");

line("2. 两个版本的训练运行（模型包校验值、合成占比一致性）");
const v110 = v110Events();
await sys.appendEvent(v110.model);
await sys.appendEvent(modelTrainedEvent());
console.log("cxr-model@1.1.0 与 cxr-model@1.2.0 已登记，校验值 sha256 已固定");

line("3. 跨院跨设备验证：3 家机构、2 家厂商、儿童/老年/罕见病分群指标");
await sys.appendEvent(v110.study);
await sys.appendEvent(validationCompletedEvent());
console.log("study-2026-110 / study-2026-120 完成，含群体偏差证据");

line("4. 四个决定齐备后，医院B 先后启用 1.1.0 与 1.2.0，医院A 启用 1.2.0");
await sys.appendEvent(v110.release);
await sys.appendEvent(releaseActivatedEvent());
await sys.appendEvent(
  releaseActivatedEvent({
    event_id: "evt-release-a120",
    aggregate_id: IDS.releaseA120,
    release_id: IDS.releaseA120,
    institution_id: "hospital-a",
    summary: "医院A启用胸片模型1.2.0",
  }),
);
console.log("rel-hospital-b-110 / rel-hospital-b-120 / rel-hospital-a-120 已启用");

line("5. 可执行放行包（机器可核查的逐层关联，而非平均指标）");
const pkg = sys.services.packages.getPackage(IDS.releaseB120);
show("放行包要点：", {
  status: pkg.status,
  decisions: Object.keys(pkg.decisions),
  boundary: pkg.boundary.diseases,
  populations: pkg.boundary.populations,
  checksum: pkg.model.package_checksum.slice(0, 20) + "…",
  synthetic_ratio: pkg.model.synthetic_ratio,
  lineage_ok: pkg.lineage_ok,
});

line("6. 发起检查时的适用性与人工升级规则");
const elderly = await sys.services.applicability.check({
  institution_id: "hospital-b",
  exam: { disease: "pneumonia", population: "elderly", device_vendor: "Siemens" },
});
show("老年 + Siemens：", { applicable: elderly.applicable, must_escalate: elderly.escalation.must_escalate });
const rare = await sys.services.applicability.check({
  institution_id: "hospital-b",
  exam: { disease: "pneumonia", population: "rare_disease", device_vendor: "GE" },
});
show("罕见病 + GE：", { applicable: rare.applicable, reasons: rare.escalation.reasons });
const out = await sys.services.applicability.check({
  institution_id: "hospital-b",
  exam: { disease: "fracture", population: "adult", device_vendor: "GE" },
});
show("骨折（边界外）：", { applicable: out.applicable, missing: out.missing_requirements });

line("7. 记录预测与医生覆盖（临床理由必填，记录受绩效保护）");
const prediction = await sys.services.predictions.record({
  institution_id: "hospital-b",
  exam: { disease: "pneumonia", population: "adult", device_vendor: "GE" },
  output: { label: "pneumonia", score: 0.9 },
  confidence: 0.9,
  clinician_id: "dr-01",
});
await sys.services.overrides.record({
  prediction_id: prediction.prediction_id,
  clinician_id: "dr-02",
  clinical_rationale: "影像表现与临床不符，按阴性处理并复查",
});
show("覆盖统计（仅汇总）:", sys.services.overrides.stats());

line("8. 启用后监控：医院B 输入漂移越限 → 按机构+版本局部暂停");
const drift = await sys.services.monitoring.recordSample({
  institution_id: "hospital-b",
  model_version: IDS.modelV120,
  drift: { psi: 0.42 },
  metrics: { sensitivity: 0.9 },
  n: 260,
});
show("漂移结果：", drift);
console.log(
  "医院A 同版本状态：",
  sys.projections.releases.get(IDS.releaseA120).status,
  "（局部暂停不影响其他机构）",
);

line("9. 1.1.0 曾暂停更替，现回滚至 1.1.0（原预测全部保留）");
await sys.suspendRelease({ release_id: IDS.releaseB110, reason: "MANUAL", detail: "版本更替" });
await sys.services.rollback.rollback({
  institution_id: "hospital-b",
  to_model_version: IDS.modelV110,
  decided_by: "信息科-孙",
  reason: "1.2.0 漂移越限",
});
console.log("rel-hospital-b-110 状态：", sys.projections.releases.get(IDS.releaseB110).status);

line("10. 数据授权撤回 → 影响评估（既往研究与预测保留，不删除）");
const assessment = await sys.services.withdrawals.withdraw({
  authorization_id: IDS.auth,
  reason: "患者行使撤回权",
  requested_by: "数据办-王",
});
show("影响评估：", assessment.affected);
console.log("触发的暂停事件：", assessment.suspensions);

line("11. 治理追溯：从预测追到数据、验证、发布与处置责任");
const trace = sys.services.traceability.tracePrediction(prediction.prediction_id);
show("追溯链：", {
  prediction: trace.prediction.prediction_id,
  release: `${trace.release.release_id}（${trace.release.status}）`,
  study: trace.validation.study_id,
  model: trace.model.model_version,
  datasets: trace.datasets.map((d) => d.dataset_version_id),
  authorization_status: trace.authorizations.map((a) => `${a.authorization_id}:${a.status}`),
  open_actions: trace.disposition.open_actions,
});
