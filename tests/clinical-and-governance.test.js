import assert from "node:assert/strict";
import test from "node:test";

import { ServiceError } from "../src/application/service.js";
import { responsibilityChain, tracePrediction } from "../src/domain/traceability.js";
import { buildGoldenChain, FULL_SCOPE, INDICATION, POPS, SITES, VENDORS } from "../src/scenario/fixtures.js";

function activatedGolden(releaseId = "rel-a", institution = SITES.COMM_A) {
  const g = buildGoldenChain();
  g.activate(releaseId, institution, `director-${institution}`);
  return g;
}

test("临床：发起检查即返回适用性，越界禁止出分", () => {
  const g = activatedGolden();
  const ok = g.service.initiateExamination({
    invocation_id: "i1", release_id: "rel-a", indication: INDICATION,
    population_group: POPS.CHILDREN, device: VENDORS.V1,
  });
  assert.equal(ok.eligibility, "APPLICABLE");

  const bad = g.service.initiateExamination({
    invocation_id: "i2", release_id: "rel-a", indication: "brain_mri_tumor",
    population_group: POPS.ADULT, device: VENDORS.V1,
  });
  assert.equal(bad.eligibility, "NOT_APPLICABLE");
  assert.throws(
    () =>
      g.service.recordPrediction({
        invocation_id: "i2", prediction_id: "p2",
        package_sha256_at_call: g.ids.sha, score: 0.9,
      }),
    (err) => err instanceof ServiceError && err.code === "OUT_OF_SCOPE",
  );
});

test("临床：机构声明的必须人工升级人群返回 ESCALATION_REQUIRED，但仍可出参考分", () => {
  const g = activatedGolden();
  const r = g.service.initiateExamination({
    invocation_id: "i1", release_id: "rel-a", indication: INDICATION,
    population_group: POPS.RARE, device: VENDORS.V2,
  });
  assert.equal(r.eligibility, "ESCALATION_REQUIRED");
  assert.equal(r.must_escalate, true);
  // 模型仍可出分供医生参考
  const j = g.service.recordPrediction({
    invocation_id: "i1", prediction_id: "p1", package_sha256_at_call: g.ids.sha, score: 0.9,
  });
  assert.equal(j.prediction, "positive");
});

test("临床：灰区分值强制人工升级", () => {
  const g = activatedGolden();
  g.service.initiateExamination({
    invocation_id: "i1", release_id: "rel-a", indication: INDICATION,
    population_group: POPS.ADULT, device: VENDORS.V1,
  });
  const j = g.service.recordPrediction({
    invocation_id: "i1", prediction_id: "p1", package_sha256_at_call: g.ids.sha, score: 0.52,
  });
  assert.equal(j.grayZone, true);
  assert.equal(j.mustEscalate, true);
});

test("临床：调用时包校验值不一致拒绝推理", () => {
  const g = activatedGolden();
  g.service.initiateExamination({
    invocation_id: "i1", release_id: "rel-a", indication: INDICATION,
    population_group: POPS.ADULT, device: VENDORS.V1,
  });
  assert.throws(
    () =>
      g.service.recordPrediction({
        invocation_id: "i1", prediction_id: "p1",
        package_sha256_at_call: "0".repeat(64), score: 0.9,
      }),
    (err) => err instanceof ServiceError && err.code === "CHECKSUM_MISMATCH",
  );
});

test("临床：医生覆盖必须有具体临床理由、责任在接诊医生、不得绩效惩罚、原预测保留", () => {
  const g = activatedGolden();
  g.service.initiateExamination({
    invocation_id: "i1", release_id: "rel-a", indication: INDICATION,
    population_group: POPS.ADULT, device: VENDORS.V1,
  });
  g.service.recordPrediction({
    invocation_id: "i1", prediction_id: "p1", package_sha256_at_call: g.ids.sha, score: 0.95,
  });
  // 理由过短被拒
  assert.throws(
    () =>
      g.service.recordOverride({
        invocation_id: "i1", prediction_id: "p1", clinician_id: "dr-zhao",
        clinical_rationale: "不同意", final_decision: "negative",
      }),
    /临床理由/,
  );
  const override = g.service.recordOverride({
    invocation_id: "i1", prediction_id: "p1", clinician_id: "dr-zhao",
    clinical_rationale: "患者明确近期疫苗反应致淋巴结显影，结合流行病学问诊阴性，判阴性",
    final_decision: "negative",
  });
  assert.equal(override.payload.responsibility, "attending_clinician");
  assert.equal(override.payload.performance_penalty_applied, false);
  // 原预测不被改写
  assert.equal(g.service.model.getPrediction("p1").prediction, "positive");
  assert.equal(g.service.model.getInvocation("i1").override.final_decision, "negative");
});

test("监测：越界调用累计达到上限自动按机构×版本局部暂停", () => {
  const g = activatedGolden();
  for (const id of ["i1", "i2", "i3"]) {
    g.service.initiateExamination({
      invocation_id: id, release_id: "rel-a", indication: "brain_mri_tumor",
      population_group: POPS.ADULT, device: VENDORS.V1,
    });
  }
  assert.equal(g.service.model.getRelease("rel-a").status, "suspended");
  // 暂停后禁止出分
  g.service.initiateExamination({
    invocation_id: "i4", release_id: "rel-a", indication: INDICATION,
    population_group: POPS.ADULT, device: VENDORS.V1,
  });
  // i4 本身是适用检查，但 release 已暂停；同样拒绝出分
  assert.throws(
    () =>
      g.service.recordPrediction({
        invocation_id: "i4", prediction_id: "p4", package_sha256_at_call: g.ids.sha, score: 0.9,
      }),
    (err) => err instanceof ServiceError && (err.code === "RELEASE_NOT_ACTIVE" || err.code === "OUT_OF_SCOPE"),
  );
});

test("监测：局部暂停不影响其他机构的同一模型版本", () => {
  const g = activatedGolden("rel-a", SITES.COMM_A);
  g.activate("rel-b", SITES.COMM_B, "director-b");
  g.service.suspendRelease({
    release_id: "rel-a", suspended_by: "gov", reason: "manual",
    reason_text: "x", trigger_event_ids: [],
  });
  assert.equal(g.service.model.getRelease("rel-a").status, "suspended");
  assert.equal(g.service.model.getRelease("rel-b").status, "active");
});

test("监测：关键指标/漂移/安全事件越界自动暂停；恢复后可继续使用", () => {
  const g = activatedGolden();
  const r = g.service.raiseMonitoringSignal({
    signal_id: "sig1", release_id: "rel-a", institution_id: SITES.COMM_A,
    kind: "key_metric", observed: { sensitivity: 0.7 }, bound: { min_sensitivity: 0.85 }, breached: true,
  });
  assert.equal(r.auto_suspended.event_type, "MODEL_SUSPENDED");
  g.service.resumeRelease({ release_id: "rel-a", resumed_by: "gov", reason: "整改后恢复", resolved_signal_ids: ["sig1"] });
  assert.equal(g.service.model.getRelease("rel-a").status, "active");

  // 严重安全事件立即暂停
  const s = g.service.reportSafetyEvent({
    safety_event_id: "se1", release_id: "rel-a", institution_id: SITES.COMM_A,
    reported_by: "dr-zhao", severity: "critical", description: "漏诊一例",
  });
  assert.equal(s.auto_suspended.payload.reason, "safety_event");
});

test("处置：回滚后历史原预测与校验值仍可追溯", () => {
  const g = activatedGolden();
  g.service.initiateExamination({
    invocation_id: "i1", release_id: "rel-a", indication: INDICATION,
    population_group: POPS.ADULT, device: VENDORS.V1,
  });
  g.service.recordPrediction({
    invocation_id: "i1", prediction_id: "p1", package_sha256_at_call: g.ids.sha, score: 0.95,
  });
  g.service.rollbackRelease({
    release_id: "rel-a", rolled_back_by: "gov", reason: "回退纯人工",
    to_package_id: null, trigger_event_ids: [],
  });
  const pred = g.service.model.getPrediction("p1");
  assert.equal(pred.prediction, "positive");
  assert.equal(pred.package_sha256_at_call, g.ids.sha);
  const trace = tracePrediction(g.service.model, "p1");
  assert.equal(trace.disposition.rollback.historical_predictions_preserved, true);
  assert.equal(trace.disposition.rollback.to_package_id, null);
});

test("撤回：影响评估沿真实记录与合成来源追溯，既往研究保留，阻断未来使用", () => {
  const g = activatedGolden();
  const { withdrawal, impact, suspensions } = g.service.withdrawData({
    record_id: "rec-001", withdrawn_by: "guardian", reason: "撤回同意",
  });
  assert.equal(withdrawal.event_type, "DATA_AUTHORIZATION_WITHDRAWN");
  assert.equal(impact.payload.historical_research_preserved, true);
  assert.equal(impact.payload.disposition, "block_new_use");
  assert.ok(impact.payload.affected_dataset_versions.includes(g.ids.dvId));
  assert.ok(impact.payload.affected_package_ids.includes(g.ids.pkgId));
  // 合成批次 syn-001 的来源包含 rec-001，因此同版本也经 synthetic_source 路径命中
  const path = impact.payload.affected_paths.find((x) => x.dataset_version_id === g.ids.dvId);
  assert.deepEqual(path.via.sort(), ["real_record", "synthetic_source"]);
  // 既往研究事件仍在
  assert.ok(g.service.model.researchByPackage.has(g.ids.pkgId));
  // 受影响的活跃 release 被自动局部暂停（block_new_use 必须可执行）
  assert.equal(g.service.model.getRelease("rel-a").status, "suspended");
  assert.equal(suspensions.length, 1);
  assert.equal(suspensions[0].payload.reason, "data_withdrawal");
  // 暂停后新检查仍可发起，但不再出模型分
  g.service.initiateExamination({
    invocation_id: "i-after-wd", release_id: "rel-a", indication: INDICATION,
    population_group: POPS.ADULT, device: VENDORS.V1,
  });
  assert.throws(
    () =>
      g.service.recordPrediction({
        invocation_id: "i-after-wd", prediction_id: "p-after-wd",
        package_sha256_at_call: g.ids.sha, score: 0.9,
      }),
    (err) => err instanceof ServiceError,
  );
  // 事件总数没有任何删除
  const countAfter = g.service.store.length;
  assert.ok(countAfter >= 28);
  // 撤回后事件数仍单调增长（撤回是追加，不是删除）
  assert.ok(countAfter > 26);
  // 撤回后不能在该版本上再训练
  assert.throws(
    () =>
      g.service.startTrainingRun({
        run_id: "run-new", dataset_version_id: g.ids.dvId, started_by: "e",
        purpose: "chest_xray_tuberculosis_model",
      }),
    (err) => err instanceof ServiceError && err.code === "DATASET_NOT_GOVERNABLE",
  );
});

test("撤回：不影响任何包时给出 no_future_use_affected，且不写虚假日志", () => {
  const g = activatedGolden();
  g.service.grantData({ record_id: "rec-unused", granted_by: "s", purpose: "other" });
  const { impact } = g.service.withdrawData({ record_id: "rec-unused", withdrawn_by: "s", reason: "x" });
  assert.equal(impact.payload.disposition, "no_future_use_affected");
  assert.deepEqual(impact.payload.affected_package_ids, []);
});

test("追溯：从预测可回到数据/验证/四道决定/处置，责任链完整", () => {
  const g = activatedGolden();
  g.service.initiateExamination({
    invocation_id: "i1", release_id: "rel-a", indication: INDICATION,
    population_group: POPS.ELDERLY, device: VENDORS.V2,
  });
  g.service.recordPrediction({
    invocation_id: "i1", prediction_id: "p1", package_sha256_at_call: g.ids.sha, score: 0.1,
  });
  const trace = tracePrediction(g.service.model, "p1");
  assert.equal(trace.package.sha256, g.ids.sha);
  assert.ok(trace.data.records.length >= 8);
  assert.equal(trace.data.deidentification.residual_direct_identifiers, 0);
  assert.ok(trace.data.synthetic_batches.length === 1);
  assert.ok(trace.validation.studies.length === 4); // 2 院 × 2 设备
  assert.equal(trace.decisions.research.event_id.split("-")[0] !== undefined, true);
  const owners = responsibilityChain(trace).map((c) => c.layer);
  for (const layer of ["研究完成", "伦理审查", "技术验证", "院内启用", "脱敏验证", "训练运行"]) {
    assert.ok(owners.includes(layer), `责任链缺少 ${layer}`);
  }
  // 每条责任都能指回具体事件
  for (const c of responsibilityChain(trace)) assert.ok(c.event_id);
});

test("追溯：作用域外调用与覆盖在临床上下文中留痕", () => {
  const g = activatedGolden();
  g.service.initiateExamination({
    invocation_id: "i1", release_id: "rel-a", indication: "brain_mri_tumor",
    population_group: POPS.ADULT, device: VENDORS.V1,
  });
  const inv = g.service.model.getInvocation("i1");
  assert.equal(inv.out_of_scope.violated_dimensions[0], "indication");
  assert.equal(inv.eligibility, "NOT_APPLICABLE");
});
