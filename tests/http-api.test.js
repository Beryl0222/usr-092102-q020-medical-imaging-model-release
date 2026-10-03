import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { EventStore } from "../src/domain/eventStore.js";
import { buildGoldenChain, buildSingleCenterChain, FULL_SCOPE, INDICATION, POPS, SITES, VENDORS } from "../src/scenario/fixtures.js";
import { createApp } from "../src/transport/http.js";

// try/finally 保证断言失败时服务器也被关闭，不泄漏监听句柄。
async function withServer(service, fn) {
  const server = createServer(createApp(service));
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const jsonPost = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function seeded() {
  const store = new EventStore();
  const g = buildGoldenChain({ store });
  return { service: g.service, g };
}

test("HTTP：健康检查与完整性", async () => {
  const { service } = seeded();
  await withServer(service, async (base) => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.ok(health.events >= 25);
    const integrity = await fetch(`${base}/integrity`).then((r) => r.json());
    assert.equal(integrity.ok, true);
    assert.equal(integrity.events, health.events);
  });
});

test("HTTP：放行评估 → 启用 → 发起检查 → 出分 → 追溯 全流程", async () => {
  const { service, g } = seeded();
  await withServer(service, async (base) => {
    const evalRes = await jsonPost(base, "/api/releases/evaluate", {
      package_id: g.ids.pkgId, institution_id: SITES.COMM_A, scope: FULL_SCOPE,
    }).then((r) => r.json());
    assert.equal(evalRes.eligible, true);

    const actRes = await jsonPost(base, "/api/releases", {
      release_id: "rel-http", package_id: g.ids.pkgId, institution_id: SITES.COMM_A,
      activated_by: "director", scope: FULL_SCOPE,
    });
    assert.equal(actRes.status, 200);

    const exam = await jsonPost(base, "/api/examinations", {
      invocation_id: "inv-http", release_id: "rel-http", indication: INDICATION,
      population_group: POPS.CHILDREN, device: VENDORS.V1,
    }).then((r) => r.json());
    assert.equal(exam.eligibility, "APPLICABLE");

    const pred = await jsonPost(base, "/api/examinations/inv-http/predictions", {
      prediction_id: "pred-http", package_sha256_at_call: g.ids.sha, score: 0.52,
    }).then((r) => r.json());
    assert.equal(pred.grayZone, true);

    const trace = await fetch(`${base}/api/trace/predictions/pred-http`).then((r) => r.json());
    assert.equal(trace.trace.package.sha256, g.ids.sha);
    assert.ok(trace.responsibilities.length >= 6);
  });
});

test("HTTP：门禁失败返回 422 与阻断项", async () => {
  const store = new EventStore();
  const pilot = buildSingleCenterChain({ store });
  await withServer(pilot.service, async (base) => {
    const res = await jsonPost(base, "/api/releases", {
      release_id: "rel-x", package_id: pilot.ids.pkgId, institution_id: SITES.COMM_A,
      activated_by: "d", scope: FULL_SCOPE,
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, "RELEASE_GATE_FAILED");
    assert.ok(body.details.blockers.length >= 5);
  });
});

test("HTTP：暂停后监测视图反映状态，事件流可按类型过滤", async () => {
  const { service } = seeded();
  service.activateRelease({
    release_id: "rel-m", package_id: "pkg-chest-v1", institution_id: SITES.COMM_A,
    activated_by: "d", scope: FULL_SCOPE,
  });
  service.raiseMonitoringSignal({
    signal_id: "sig-m", release_id: "rel-m", institution_id: SITES.COMM_A,
    kind: "input_drift", observed: { psi: 0.31 }, bound: { max_psi: 0.2 }, breached: true,
  });
  await withServer(service, async (base) => {
    const mon = await fetch(`${base}/api/releases/rel-m/monitoring`).then((r) => r.json());
    assert.equal(mon.status, "suspended");
    assert.equal(mon.breached_signals[0].kind, "input_drift");

    const events = await fetch(`${base}/api/events?type=MODEL_SUSPENDED`).then((r) => r.json());
    assert.ok(events.count >= 1);
    assert.ok(events.events.every((e) => e.event_type === "MODEL_SUSPENDED"));
  });
});

test("HTTP：未知资源返回 404，错误 JSON 稳定", async () => {
  const { service } = seeded();
  await withServer(service, async (base) => {
    const res = await fetch(`${base}/api/releases/no-such-release/monitoring`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "UNKNOWN_RELEASE");
  });
});
