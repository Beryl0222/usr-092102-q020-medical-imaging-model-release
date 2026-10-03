import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateEnvelope, CONTRACT_EVENT_TYPES } from "../src/domain/envelope.js";
import { EventStore, EventValidationError, hashEvent } from "../src/domain/eventStore.js";

async function tmpFile(label) {
  const dir = await mkdtemp(join(tmpdir(), `rel-${label}-`));
  return join(dir, "events.jsonl");
}

function validDraft(over = {}) {
  return {
    event_type: "DATA_AUTHORIZATION_GRANTED",
    aggregate_type: "imaging_dataset",
    aggregate_id: "record:rec-1",
    summary: "授权",
    payload: { record_id: "rec-1", granted_by: "steward", purpose: "p" },
    ...over,
  };
}

test("信封：必填字段、版本、时间格式校验", () => {
  assert.deepEqual(validateEnvelope({}, { strictContract: true }).length > 0, true);
  const good = {
    event_id: "e1",
    event_type: "DATASET_APPROVED",
    aggregate_type: "imaging_dataset",
    aggregate_id: "d1",
    occurred_at: "2026-09-20T12:00:00+08:00",
    version: 1,
    summary: "x",
  };
  assert.deepEqual(validateEnvelope(good, { strictContract: true }), []);
  assert.deepEqual(
    validateEnvelope({ ...good, occurred_at: "not-a-time" }, { strictContract: true }),
    ["occurred_at 必须是 ISO 8601 date-time"],
  );
  // 扩展事件类型：默认信封校验放行，由事件目录约束
  assert.deepEqual(validateEnvelope({ ...good, event_type: "DATA_AUTHORIZATION_GRANTED" }), []);
  // strictContract 模式下拒绝非契约事件
  assert.ok(
    validateEnvelope({ ...good, event_type: "DATA_AUTHORIZATION_GRANTED" }, { strictContract: true })[0]
      .includes("契约枚举"),
  );
  assert.deepEqual(CONTRACT_EVENT_TYPES.length, 5);
});

test("存储：聚合版本严格递增，event_id 唯一", () => {
  const store = new EventStore();
  const e1 = store.append(validDraft());
  const e2 = store.append(validDraft());
  assert.equal(e1.version, 1);
  assert.equal(e2.version, 2);
  assert.throws(() => store.append(validDraft({ event_id: e1.event_id })), EventValidationError);
  // 不同聚合各自从 v1 开始
  const other = store.append(validDraft({ aggregate_id: "record:rec-2", payload: { record_id: "rec-2", granted_by: "b", purpose: "p" } }));
  assert.equal(other.version, 1);
});

test("存储：payload 目录校验生效（合成批次必须有真实来源）", () => {
  const store = new EventStore();
  assert.throws(
    () =>
      store.append({
        event_type: "SYNTHETIC_BATCH_REGISTERED",
        aggregate_type: "imaging_dataset",
        aggregate_id: "synthetic-batch:s1",
        summary: "x",
        payload: { batch_id: "s1", generator_run_id: "g", seed: "z", source_record_ids: [], provenance: "p", ratio_in_version: 0.2 },
      }),
    /source_record_ids 必须是非空数组/,
  );
});

test("存储：事件类型必须挂在目录声明的聚合上", () => {
  const store = new EventStore();
  assert.throws(
    () =>
      store.append({
        event_type: "MODEL_TRAINED",
        aggregate_type: "clinical_release", // 错误聚合
        aggregate_id: "x",
        summary: "x",
        payload: {},
      }),
    /必须挂在聚合 model_build/,
  );
});

test("存储：哈希链首尾相扣，篡改历史事件在重放时被发现", async () => {
  const file = await tmpFile("tamper");
  const store1 = new EventStore({ file });
  store1.append(validDraft());
  store1.append(validDraft());
  assert.deepEqual(store1.verifyIntegrity(), { ok: true, events: 2, aggregates: 1 });

  // 干净重放成功
  const store2 = new EventStore({ file });
  assert.equal(store2.length, 2);

  // 篡改第一行的 payload（保留哈希），重放必须失败
  const lines = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  lines[0].payload.purpose = "篡改后的用途";
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.throws(() => new EventStore({ file }), /内容指纹不匹配/);

  // 重新写回干净日志，但删掉中间事件 -> 版本/链断裂
  writeFileSync(file, JSON.stringify(lines[1]) + "\n");
  assert.throws(() => new EventStore({ file }), /版本断裂|哈希链/);
});

test("存储：重计算的指纹与内容一致（稳定序列化）", () => {
  const store = new EventStore();
  const e = store.append(validDraft());
  assert.equal(e.metadata.event_hash, hashEvent(e));
  assert.equal(e.metadata.prev_event_hash, null);
  const e2 = store.append(validDraft());
  assert.equal(e2.metadata.prev_event_hash, e.metadata.event_hash);
});
