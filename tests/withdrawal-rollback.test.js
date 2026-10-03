import assert from "node:assert/strict";
import test from "node:test";

import {
  IDS,
  modelTrainedEvent,
  seedBaseline,
  v110Events,
} from "../examples/scenario.js";
import { createReleaseSystem } from "../src/system.js";
import { rejectsMatching } from "./helpers.js";

const system = () => createReleaseSystem();

const exam = { disease: "pneumonia", population: "adult", device_vendor: "GE" };

test("数据撤回：触发影响评估并局部暂停，既往研究、验证与预测全部保留", async () => {
  const sys = await system();
  await seedBaseline(sys);
  const prediction = await sys.services.predictions.record({
    institution_id: "hospital-b",
    exam,
    output: { label: "pneumonia", score: 0.9 },
    confidence: 0.9,
  });

  const assessment = await sys.services.withdrawals.withdraw({
    authorization_id: IDS.auth,
    reason: "患者行使撤回权",
    requested_by: "数据办-王",
  });
  assert.deepEqual(assessment.affected.dataset_versions, [IDS.dataset]);
  assert.deepEqual(assessment.affected.model_builds, [IDS.modelV120]);
  assert.deepEqual(assessment.affected.validation_studies, [IDS.study120]);
  assert.deepEqual(assessment.affected.releases, [IDS.releaseB120]);
  assert.equal(assessment.suspensions.length, 1);
  assert.match(assessment.policy, /全部保留/);

  const release = sys.projections.releases.get(IDS.releaseB120);
  assert.equal(release.status, "suspended");
  assert.equal(release.suspensions.at(-1).reason, "DATA_WITHDRAWAL_IMPACT");

  // 既往研究与预测仍可追溯，未被删除
  assert.ok(sys.projections.studies.has(IDS.study120));
  assert.ok(sys.operational.predictionById(prediction.prediction_id));
  const trace = sys.services.traceability.tracePrediction(prediction.prediction_id);
  assert.equal(trace.authorizations[0].status, "withdrawn");
  assert.ok(trace.impact_assessments.length === 1);

  // 撤回后不得用于新训练、不得重新启用
  await rejectsMatching(
    sys.appendEvent(
      modelTrainedEvent({
        event_id: "evt-model-130",
        aggregate_id: "cxr-model@1.3.0",
        model_version: "cxr-model@1.3.0",
        training_run_id: "run-2026-1001-01",
      }),
    ),
    /授权已撤回，不得用于新的训练/,
  );
  await rejectsMatching(
    sys.services.withdrawals.withdraw({ authorization_id: IDS.auth, reason: "重复撤回" }),
    /已撤回/,
  );
});

test("回滚：旧版本重新启用，原预测保留并归属原版本", async () => {
  const sys = await system();
  await seedBaseline(sys);
  const v110 = v110Events();
  await sys.appendEvent(v110.model);
  await sys.appendEvent(v110.study);
  await sys.appendEvent(v110.release);

  // 1.1.0 的预测（在 1.2.0 启用前产生）
  const oldPrediction = await sys.services.predictions.record({
    institution_id: "hospital-b",
    model_version: IDS.modelV110,
    exam,
    output: { label: "nodule", score: 0.66 },
    confidence: 0.66,
  });
  assert.equal(oldPrediction.release_id, IDS.releaseB110);

  // 版本更替：暂停 1.1.0，启用 1.2.0 的预测
  await sys.suspendRelease({ release_id: IDS.releaseB110, reason: "MANUAL", detail: "版本更替" });
  const newPrediction = await sys.services.predictions.record({
    institution_id: "hospital-b",
    model_version: IDS.modelV120,
    exam,
    output: { label: "pneumonia", score: 0.91 },
    confidence: 0.91,
  });

  // 1.2.0 阈值失守 → 局部暂停 → 回滚到 1.1.0
  await sys.services.monitoring.recordSample({
    institution_id: "hospital-b",
    model_version: IDS.modelV120,
    drift: { psi: 0.5 },
    metrics: { sensitivity: 0.9 },
  });
  assert.equal(sys.projections.releases.get(IDS.releaseB120).status, "suspended");

  const rollbackEvent = await sys.services.rollback.rollback({
    institution_id: "hospital-b",
    to_model_version: IDS.modelV110,
    decided_by: "信息科-孙",
    reason: "1.2.0 漂移越限",
  });
  assert.equal(rollbackEvent.activation_kind, "rollback");
  assert.equal(rollbackEvent.retains_predictions, true);
  assert.equal(sys.projections.releases.get(IDS.releaseB110).status, "active");

  // 回滚后新旧预测都保留，归属各自版本
  assert.equal(sys.operational.predictionById(oldPrediction.prediction_id).model_version, IDS.modelV110);
  assert.equal(sys.operational.predictionById(newPrediction.prediction_id).model_version, IDS.modelV120);

  // 回滚后的适用性默认指向最新启用的 1.1.0
  const check = await sys.services.applicability.check({ institution_id: "hospital-b", exam });
  assert.equal(check.applicable, true);
  assert.equal(check.release_id, IDS.releaseB110);
});

test("回滚：目标未暂停或不存在时被拒绝", async () => {
  const sys = await system();
  await seedBaseline(sys);
  await rejectsMatching(
    sys.services.rollback.rollback({ institution_id: "hospital-b", to_model_version: "cxr-model@9.9.9", decided_by: "x" }),
    /未找到放行/,
  );
  // 1.2.0 处于启用状态，不能对其回滚
  await rejectsMatching(
    sys.services.rollback.rollback({ institution_id: "hospital-b", to_model_version: IDS.modelV120, decided_by: "信息科-孙" }),
    /仅可对已暂停的放行/,
  );
});
