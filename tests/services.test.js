import assert from "node:assert/strict";
import test from "node:test";

import { IDS, releaseActivatedEvent, seedBaseline } from "../examples/scenario.js";
import { createReleaseSystem } from "../src/system.js";

const exam = (overrides = {}) => ({
  disease: "pneumonia",
  population: "adult",
  device_vendor: "GE",
  ...overrides,
});

test("适用性：边界内可调用并给出阈值；罕见病人群必须人工升级；低置信度必须人工升级", async () => {
  const sys = await system();
  await seedBaseline(sys);

  const ok = await sys.services.applicability.check({ institution_id: "hospital-b", exam: exam() });
  assert.equal(ok.applicable, true);
  assert.equal(ok.escalation.must_escalate, false);
  assert.deepEqual(ok.thresholds, { operating_point: 0.5, min_sensitivity: 0.8 });
  assert.equal(ok.responsibility.clinical_owner, "影像科-李");

  const rare = await sys.services.applicability.check({
    institution_id: "hospital-b",
    exam: exam({ population: "rare_disease" }),
  });
  assert.equal(rare.applicable, true);
  assert.equal(rare.escalation.must_escalate, true);
  assert.match(rare.escalation.reasons[0], /必须人工复核/);

  const lowConfidence = await sys.services.applicability.check({
    institution_id: "hospital-b",
    exam: exam(),
    confidence: 0.4,
  });
  assert.equal(lowConfidence.escalation.must_escalate, true);
  assert.match(lowConfidence.escalation.reasons[0], /置信度 0\.4 低于 0\.6/);
});

test("适用性：病种/人群/设备越界与无放行、已暂停的情形", async () => {
  const sys = await system();
  await seedBaseline(sys);

  const badDisease = await sys.services.applicability.check({
    institution_id: "hospital-b",
    exam: exam({ disease: "fracture" }),
  });
  assert.equal(badDisease.applicable, false);
  assert.match(badDisease.missing_requirements[0], /病种不在用途边界：fracture/);

  const badVendor = await sys.services.applicability.check({
    institution_id: "hospital-b",
    exam: exam({ device_vendor: "Philips" }),
  });
  assert.equal(badVendor.applicable, false);
  assert.match(badVendor.missing_requirements[0], /设备厂商不在用途边界/);

  const none = await sys.services.applicability.check({ institution_id: "hospital-z", exam: exam() });
  assert.equal(none.applicable, false);
  assert.equal(none.status, "none");

  await sys.suspendRelease({ release_id: IDS.releaseB120, reason: "MANUAL", detail: "例行复核" });
  const suspended = await sys.services.applicability.check({ institution_id: "hospital-b", exam: exam() });
  assert.equal(suspended.applicable, false);
  assert.equal(suspended.status, "suspended");
  assert.match(suspended.missing_requirements[0], /例行复核/);
});

test("预测：边界内记录成功；必须人工升级而未升级被拒绝", async () => {
  const sys = await system();
  await seedBaseline(sys);

  const prediction = await sys.services.predictions.record({
    institution_id: "hospital-b",
    exam: exam(),
    output: { label: "pneumonia", score: 0.87 },
    confidence: 0.87,
    clinician_id: "dr-01",
  });
  assert.equal(prediction.release_id, IDS.releaseB120);
  assert.equal(prediction.model_version, IDS.modelV120);

  await assert.rejects(
    () =>
      sys.services.predictions.record({
        institution_id: "hospital-b",
        exam: exam({ population: "rare_disease" }),
        confidence: 0.9,
      }),
    /必须人工升级后才能调用模型/,
  );

  const escalated = await sys.services.predictions.record({
    institution_id: "hospital-b",
    exam: exam({ population: "rare_disease" }),
    confidence: 0.9,
    escalated_to_human: true,
  });
  assert.equal(escalated.escalated_to_human, true);
});

test("越界调用：被拒绝并按机构+版本局部暂停，其他机构不受影响", async () => {
  const sys = await system();
  await seedBaseline(sys);
  await sys.appendEvent(
    releaseActivatedEvent({
      event_id: "evt-release-a120",
      aggregate_id: IDS.releaseA120,
      release_id: IDS.releaseA120,
      institution_id: "hospital-a",
      summary: "医院A启用胸片模型1.2.0",
    }),
  );

  await assert.rejects(
    () =>
      sys.services.predictions.record({
        institution_id: "hospital-b",
        exam: exam({ disease: "fracture" }),
        clinician_id: "dr-02",
      }),
    /越界调用被拒绝/,
  );
  assert.equal(sys.projections.releases.get(IDS.releaseB120).status, "suspended");
  assert.equal(sys.projections.releases.get(IDS.releaseA120).status, "active");
  assert.equal(sys.operational.recordsOf("violation").length, 1);
});

test("医生覆盖：必须留临床理由；记录受保护，拒绝个人绩效维度统计", async () => {
  const sys = await system();
  await seedBaseline(sys);
  const prediction = await sys.services.predictions.record({
    institution_id: "hospital-b",
    exam: exam(),
    output: { label: "normal", score: 0.62 },
    confidence: 0.62,
    clinician_id: "dr-01",
  });

  await assert.rejects(
    () => sys.services.overrides.record({ prediction_id: prediction.prediction_id, clinician_id: "dr-01" }),
    /必须留下临床理由/,
  );

  const override = await sys.services.overrides.record({
    prediction_id: prediction.prediction_id,
    clinician_id: "dr-01",
    clinical_rationale: "影像见典型磨玻璃影，模型阴性结果与临床不符",
  });
  assert.equal(override.performance_protected, true);

  const stats = sys.services.overrides.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.by_release[IDS.releaseB120], 1);
  assert.match(stats.note, /不得用于个人绩效/);
  assert.throws(() => sys.services.overrides.statsByClinician(), /不得用于个人绩效评价/);
});

const system = () => createReleaseSystem();
