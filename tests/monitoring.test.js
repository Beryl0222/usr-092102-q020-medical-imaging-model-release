import assert from "node:assert/strict";
import test from "node:test";

import { IDS, releaseActivatedEvent, seedBaseline } from "../examples/scenario.js";
import { createReleaseSystem } from "../src/system.js";

const system = () => createReleaseSystem();

async function seedTwoSites() {
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
  return sys;
}

test("监控样本：正常样本不触发动作", async () => {
  const sys = await system();
  await seedBaseline(sys);
  const result = await sys.services.monitoring.recordSample({
    institution_id: "hospital-b",
    drift: { psi: 0.1 },
    metrics: { sensitivity: 0.9 },
    n: 200,
  });
  assert.equal(result.status, "ok");
  assert.equal(sys.projections.releases.get(IDS.releaseB120).status, "active");
});

test("监控样本：输入漂移越限按机构+版本局部暂停，其他机构不受影响", async () => {
  const sys = await seedTwoSites();
  const result = await sys.services.monitoring.recordSample({
    institution_id: "hospital-b",
    drift: { psi: 0.35 },
    metrics: { sensitivity: 0.9 },
    n: 200,
  });
  assert.equal(result.status, "suspended");
  assert.match(result.breaches[0], /PSI 0\.35 超过上限 0\.2/);
  assert.equal(sys.projections.releases.get(IDS.releaseB120).status, "suspended");
  assert.equal(sys.projections.releases.get(IDS.releaseA120).status, "active");

  const suspension = sys.projections.releases.get(IDS.releaseB120).suspensions.at(-1);
  assert.equal(suspension.reason, "THRESHOLD_BREACH");
  assert.deepEqual(suspension.scope, { institution_id: "hospital-b", model_version: IDS.modelV120 });
});

test("监控样本：关键指标失守触发暂停", async () => {
  const sys = await system();
  await seedBaseline(sys);
  const result = await sys.services.monitoring.recordSample({
    institution_id: "hospital-b",
    drift: { psi: 0.05 },
    metrics: { sensitivity: 0.72 },
    n: 300,
  });
  assert.equal(result.status, "suspended");
  assert.match(result.breaches[0], /灵敏度 0\.72 低于下限 0\.8/);
});

test("安全事件：高严重度触发暂停，低严重度仅记录", async () => {
  const sys = await seedTwoSites();
  const low = await sys.services.monitoring.recordSafetyEvent({
    institution_id: "hospital-b",
    severity: "low",
    description: "界面提示文案错误",
  });
  assert.equal(low.status, "recorded");
  assert.equal(sys.projections.releases.get(IDS.releaseB120).status, "active");

  const high = await sys.services.monitoring.recordSafetyEvent({
    institution_id: "hospital-b",
    severity: "high",
    description: "两例漏诊疑似与模型阴性相关",
  });
  assert.equal(high.status, "suspended");
  assert.equal(sys.projections.releases.get(IDS.releaseB120).status, "suspended");
  assert.equal(sys.projections.releases.get(IDS.releaseA120).status, "active");
});
