import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventStore } from "../src/event-store.js";
import { validateEvent } from "../src/validator.js";

const envelope = (overrides = {}) => ({
  event_id: "evt-1",
  event_type: "DATASET_APPROVED",
  aggregate_type: "imaging_dataset",
  aggregate_id: "ds-1",
  occurred_at: "2026-09-01T09:00:00+08:00",
  version: 1,
  summary: "测试事件",
  ...overrides,
});

test("信封校验由契约驱动：缺字段、枚举越界、时间格式、版本下界", () => {
  assert.deepEqual(validateEvent(envelope()), []);
  assert.ok(validateEvent({}).some((e) => e.includes("event_id")));
  assert.ok(validateEvent(envelope({ event_type: "SOMETHING" })).some((e) => e.includes("event_type")));
  assert.ok(validateEvent(envelope({ aggregate_type: "other" })).some((e) => e.includes("aggregate_type")));
  assert.ok(validateEvent(envelope({ occurred_at: "不是时间" })).some((e) => e.includes("occurred_at")));
  assert.ok(validateEvent(envelope({ version: 0 })).some((e) => e.includes("version")));
});

test("事件存储：event_id 唯一、版本按聚合连续递增", async () => {
  const store = await EventStore.open({ validateEnvelope: validateEvent });
  await store.append(envelope());
  await assert.rejects(() => store.append(envelope()), /事件已存在/);
  await assert.rejects(
    () => store.append(envelope({ event_id: "evt-2", version: 1 })),
    /版本不连续：期望 2，收到 1/,
  );
  await store.append(envelope({ event_id: "evt-2", version: 2, event_type: "DATASET_APPROVED" }));
  // 不同聚合各自从 1 开始
  await store.append(envelope({ event_id: "evt-3", aggregate_id: "ds-2" }));
  assert.equal(store.nextVersion("imaging_dataset", "ds-1"), 3);
  assert.equal(store.nextVersion("imaging_dataset", "ds-2"), 2);
  assert.equal(store.list({ aggregateId: "ds-1" }).length, 2);
});

test("事件存储：JSONL 持久化后回放", async () => {
  const dir = await mkdtemp(join(tmpdir(), "event-store-"));
  try {
    const file = join(dir, "events.jsonl");
    const first = await EventStore.open({ validateEnvelope: validateEvent, persistenceFile: file });
    await first.append(envelope());
    await first.append(envelope({ event_id: "evt-2", version: 2 }));

    const replayed = await EventStore.open({ validateEnvelope: validateEvent, persistenceFile: file });
    assert.equal(replayed.list().length, 2);
    assert.equal(replayed.nextVersion("imaging_dataset", "ds-1"), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
