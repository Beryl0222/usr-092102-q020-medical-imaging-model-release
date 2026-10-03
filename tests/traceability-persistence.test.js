import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { IDS, seedBaseline } from "../examples/scenario.js";
import { createReleaseSystem } from "../src/system.js";

const exam = { disease: "pneumonia", population: "adult", device_vendor: "GE" };

test("追溯：从异常预测追到数据、验证、发布与处置责任", async () => {
  const sys = await createReleaseSystem();
  await seedBaseline(sys);
  const prediction = await sys.services.predictions.record({
    institution_id: "hospital-b",
    exam,
    output: { label: "pneumonia", score: 0.95 },
    confidence: 0.95,
    clinician_id: "dr-01",
  });
  await sys.services.overrides.record({
    prediction_id: prediction.prediction_id,
    clinician_id: "dr-02",
    clinical_rationale: "结合病史判断为阴性，不采纳模型阳性",
  });
  await sys.services.monitoring.recordSafetyEvent({
    institution_id: "hospital-b",
    severity: "high",
    description: "该预测与最终诊断不符",
  });

  const trace = sys.services.traceability.tracePrediction(prediction.prediction_id);
  assert.equal(trace.prediction.prediction_id, prediction.prediction_id);
  assert.equal(trace.release.release_id, IDS.releaseB120);
  assert.equal(trace.release.responsibility.safety_officer, "质控办-赵");
  assert.equal(trace.validation.study_id, IDS.study120);
  assert.equal(trace.validation.group_metrics.rare_disease.n, 40);
  assert.equal(trace.model.package_checksum, `sha256:${"b".repeat(64)}`);
  assert.equal(trace.model.synthetic_ratio, 0.2);
  assert.equal(trace.datasets[0].deidentification.passed, true);
  assert.equal(trace.datasets[0].annotation.open_disputes, 0);
  assert.equal(trace.authorizations[0].authorization_id, IDS.auth);
  assert.equal(trace.overrides.length, 1);
  assert.equal(trace.suspensions.at(-1).reason, "SAFETY_EVENT");
  assert.match(trace.disposition.open_actions[0], /质控办-赵/);
});

test("持久化：事件与操作记录落盘后，重启系统状态完整重建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-system-"));
  try {
    const first = await createReleaseSystem({ dataDir: dir });
    await seedBaseline(first);
    const prediction = await first.services.predictions.record({
      institution_id: "hospital-b",
      exam,
      output: { label: "pneumonia", score: 0.9 },
      confidence: 0.9,
    });
    const assessment = await first.services.withdrawals.withdraw({
      authorization_id: IDS.auth,
      reason: "患者行使撤回权",
      requested_by: "数据办-王",
    });

    const second = await createReleaseSystem({ dataDir: dir });
    const release = second.projections.releases.get(IDS.releaseB120);
    assert.equal(release.status, "suspended");
    assert.equal(release.suspensions.at(-1).reason, "DATA_WITHDRAWAL_IMPACT");
    assert.equal(second.projections.authorizations.get(IDS.auth).status, "withdrawn");

    const restored = second.services.withdrawals.getAssessment(assessment.impact_assessment_id);
    assert.deepEqual(restored.affected.releases, [IDS.releaseB120]);

    const trace = second.services.traceability.tracePrediction(prediction.prediction_id);
    assert.equal(trace.prediction.release_id, IDS.releaseB120);
    assert.equal(trace.authorizations[0].status, "withdrawn");
    assert.equal(second.store.list().length, 5); // 4 基线事件 + 1 暂停事件
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
