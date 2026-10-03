// 仅追加事件存储：领域事件的唯一事实来源。
// - 每个聚合（aggregate_id）拥有独立的严格递增版本序列 1,2,3…；
// - 事件通过 sha256 哈希链首尾相扣，任何历史改写都会在重放时被发现；
// - 事件一经写入不可修改、不可删除（撤回/回滚都只能追加新事件）；
// - 可持久化到 JSONL，重放时重建哈希链并校验。
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import { validateDomainEvent } from "./catalog.js";
import { validateEnvelope } from "./envelope.js";

export class EventValidationError extends Error {
  constructor(errors) {
    super(`事件校验失败：\n - ${errors.join("\n - ")}`);
    this.name = "EventValidationError";
    this.errors = errors;
  }
}

function stableStringify(value) {
  function sort(value) {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, sort(value[k])]),
      );
    }
    return value;
  }
  return JSON.stringify(sort(value));
}

/** 计算事件内容指纹：覆盖信封字段与 payload/metadata，不含指纹自身。 */
export function hashEvent(event) {
  const { event_hash: _e, prev_event_hash: _p, ...metadataRest } = event.metadata ?? {};
  const material = {
    event_id: event.event_id,
    event_type: event.event_type,
    aggregate_type: event.aggregate_type,
    aggregate_id: event.aggregate_id,
    occurred_at: event.occurred_at,
    version: event.version,
    summary: event.summary,
    payload: event.payload ?? {},
    metadata: metadataRest,
  };
  return createHash("sha256").update(stableStringify(material), "utf8").digest("hex");
}

export class EventStore {
  #events = [];
  #aggregateState = new Map(); // aggregate_id -> {version, lastHash, lastTime}
  #eventIds = new Set();
  #listeners = new Set();
  #file = null;

  constructor({ now, idGen, file } = {}) {
    this.clock = now ?? (() => new Date().toISOString());
    this.idGen = idGen ?? (() => randomUUID());
    this.#file = file ?? null;
    if (this.#file && existsSync(this.#file)) {
      this.#replay();
    }
  }

  get length() {
    return this.#events.length;
  }

  /**
   * 追加一个事件。draft 只需提供 event_type、aggregate_id、summary、payload；
   * version、event_id、occurred_at、哈希链由存储统一分配。
   */
  append(draft) {
    if (draft === null || typeof draft !== "object") {
      throw new EventValidationError(["追加内容必须是对象"]);
    }
    const event = {
      event_id: draft.event_id ?? this.idGen(draft),
      event_type: draft.event_type,
      aggregate_type: draft.aggregate_type,
      aggregate_id: draft.aggregate_id,
      occurred_at: draft.occurred_at ?? this.clock(),
      version: draft.version,
      summary: draft.summary,
      payload: draft.payload ?? {},
      metadata: { ...(draft.metadata ?? {}) },
    };

    const state = this.#aggregateState.get(event.aggregate_id);
    event.version = state ? state.version + 1 : 1;
    event.metadata.prev_event_hash = state?.lastHash ?? null;
    event.metadata.event_hash = hashEvent(event);

    const errors = [...validateEnvelope(event), ...validateDomainEvent(event)];
    if (this.#eventIds.has(event.event_id)) errors.push(`event_id 重复：${event.event_id}`);
    if (state && Number.isNaN(Date.parse(event.occurred_at)) === false) {
      const t = Date.parse(event.occurred_at);
      if (state.lastTime !== null && t < state.lastTime) {
        errors.push("同一聚合的事件时间不得早于上一事件（保持因果顺序）");
      }
    }
    if (errors.length) throw new EventValidationError(errors);

    this.#commit(event);
    return event;
  }

  #commit(event) {
    this.#events.push(event);
    this.#eventIds.add(event.event_id);
    const prev = this.#aggregateState.get(event.aggregate_id);
    this.#aggregateState.set(event.aggregate_id, {
      version: event.version,
      lastHash: event.metadata.event_hash,
      lastTime: Date.parse(event.occurred_at),
    });
    if (this.#file) {
      if (!existsSync(dirname(this.#file))) mkdirSync(dirname(this.#file), { recursive: true });
      appendFileSync(this.#file, `${JSON.stringify(event)}\n`, "utf8");
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        // 投影失败不应破坏存储；由订阅方自行记录。治理场景下直接抛出更安全，这里打印。
        console.error("[event-store] 订阅者处理失败：", err);
      }
    }
    void prev;
  }

  /** 从 JSONL 重放：严格校验版本连续性与哈希链，发现篡改即失败。 */
  #replay() {
    const lines = readFileSync(this.#file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const event = JSON.parse(line);
      const errors = [...validateEnvelope(event), ...validateDomainEvent(event)];
      const state = this.#aggregateState.get(event.aggregate_id);
      const expectedVersion = state ? state.version + 1 : 1;
      if (event.version !== expectedVersion) {
        errors.push(
          `聚合 ${event.aggregate_id} 版本断裂：期望 v${expectedVersion}，实际 v${event.version}`,
        );
      }
      if (this.#eventIds.has(event.event_id)) errors.push(`event_id 重复：${event.event_id}`);
      const expectedPrev = state?.lastHash ?? null;
      if ((event.metadata?.prev_event_hash ?? null) !== expectedPrev) {
        errors.push(`事件 ${event.event_id} 哈希链断裂（prev_event_hash 不匹配）`);
      }
      if (event.metadata?.event_hash !== hashEvent(event)) {
        errors.push(`事件 ${event.event_id} 内容指纹不匹配：历史事件被篡改或日志损坏`);
      }
      if (errors.length) throw new EventValidationError(errors);
      this.#events.push(event);
      this.#eventIds.add(event.event_id);
      this.#aggregateState.set(event.aggregate_id, {
        version: event.version,
        lastHash: event.metadata.event_hash,
        lastTime: Date.parse(event.occurred_at),
      });
      for (const listener of this.#listeners) listener(event);
    }
  }

  /** 完整性自检：重算整条链（供审计与测试调用）。 */
  verifyIntegrity() {
    const state = new Map();
    for (const event of this.#events) {
      if (event.metadata?.event_hash !== hashEvent(event)) {
        return { ok: false, reason: `指纹不匹配：${event.event_id}` };
      }
      const s = state.get(event.aggregate_id);
      if ((event.metadata?.prev_event_hash ?? null) !== (s?.lastHash ?? null)) {
        return { ok: false, reason: `哈希链断裂：${event.event_id}` };
      }
      if (event.version !== (s ? s.version + 1 : 1)) {
        return { ok: false, reason: `版本断裂：${event.event_id}` };
      }
      state.set(event.aggregate_id, {
        version: event.version,
        lastHash: event.metadata.event_hash,
      });
    }
    return { ok: true, events: this.#events.length, aggregates: state.size };
  }

  allEvents() {
    return this.#events.slice();
  }

  eventsForAggregate(aggregateId) {
    return this.#events.filter((e) => e.aggregate_id === aggregateId);
  }

  byType(type) {
    return this.#events.filter((e) => e.event_type === type);
  }

  getEvent(eventId) {
    return this.#events.find((e) => e.event_id === eventId) ?? null;
  }

  aggregateVersion(aggregateId) {
    return this.#aggregateState.get(aggregateId)?.version ?? 0;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 将当前日志固化到新文件（归档/审计导出）。事件存储本身不提供删除接口。
   */
  snapshotTo(targetFile) {
    const body = this.#events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const tmp = `${targetFile}.tmp`;
    if (!existsSync(dirname(targetFile))) mkdirSync(dirname(targetFile), { recursive: true });
    appendFileSync(tmp, body, "utf8");
    renameSync(tmp, targetFile);
    return { file: targetFile, events: this.#events.length };
  }
}
