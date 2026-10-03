import assert from "node:assert/strict";
import test from "node:test";

import {
  datasetApprovedEvent,
  modelTrainedEvent,
  releaseActivatedEvent,
  validationCompletedEvent,
} from "../examples/scenario.js";
import { startServer } from "../src/server.js";

async function post(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

test("HTTP API：事件入口、放行包、适用性、预测、追溯、错误映射", async () => {
  const { server, port } = await startServer({ port: 0 });
  try {
    assert.deepEqual((await get(port, "/health")).body, { status: "ok" });

    for (const event of [datasetApprovedEvent(), modelTrainedEvent(), validationCompletedEvent(), releaseActivatedEvent()]) {
      const result = await post(port, "/events", event);
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }

    const badEvent = await post(port, "/events", { event_id: "x" });
    assert.equal(badEvent.status, 400);
    assert.match(badEvent.body.error, /不符合领域契约/);

    const pkg = await get(port, "/releases/rel-hospital-b-120/package");
    assert.equal(pkg.status, 200);
    assert.equal(pkg.body.lineage_ok, true);
    assert.equal(pkg.body.validation.group_metrics.pediatric.ci_lower, 0.85);
    assert.equal(pkg.body.responsibility.data_steward, "数据办-王");

    const applicable = await post(port, "/applicability/checks", {
      institution_id: "hospital-b",
      exam: { disease: "nodule", population: "elderly", device_vendor: "Siemens" },
    });
    assert.equal(applicable.body.applicable, true);

    const outOfBoundary = await post(port, "/applicability/checks", {
      institution_id: "hospital-b",
      exam: { disease: "fracture", population: "adult", device_vendor: "GE" },
    });
    assert.equal(outOfBoundary.body.applicable, false);

    const prediction = await post(port, "/predictions", {
      institution_id: "hospital-b",
      exam: { disease: "pneumonia", population: "adult", device_vendor: "GE" },
      output: { label: "pneumonia", score: 0.88 },
      confidence: 0.88,
      clinician_id: "dr-01",
    });
    assert.equal(prediction.status, 200);

    const trace = await get(port, `/trace/predictions/${prediction.body.prediction_id}`);
    assert.equal(trace.status, 200);
    assert.equal(trace.body.model.model_version, "cxr-model@1.2.0");

    const missing = await get(port, "/trace/predictions/no-such-id");
    assert.equal(missing.status, 404);

    const noRoute = await get(port, "/no-such-route");
    assert.equal(noRoute.status, 404);

    const stats = await get(port, "/overrides/stats");
    assert.equal(stats.status, 200);
    assert.equal(stats.body.total, 0);
  } finally {
    server.close();
  }
});
