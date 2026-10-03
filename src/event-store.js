import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ConflictError, DomainError } from "./errors.js";

const aggregateKey = (event) => `${event.aggregate_type}:${event.aggregate_id}`;

/**
 * 追加式事件存储：事件不可改不可删。
 * - 信封必须满足 contracts/domain.schema.json（由 validateEnvelope 注入）；
 * - event_id 全局唯一；
 * - 每个聚合（aggregate_type + aggregate_id）的 version 必须从 1 开始连续递增；
 * - 可选 JSONL 文件持久化，启动时回放。
 */
export class EventStore {
  #events = [];
  #byId = new Map();
  #versions = new Map();
  #subscribers = [];
  #validateEnvelope;
  #persistenceFile;

  constructor({ validateEnvelope, persistenceFile = null } = {}) {
    this.#validateEnvelope = validateEnvelope ?? (() => []);
    this.#persistenceFile = persistenceFile;
  }

  static async open(options = {}) {
    const store = new EventStore(options);
    if (store.#persistenceFile) {
      await mkdir(dirname(store.#persistenceFile), { recursive: true });
      let text = "";
      try {
        text = await readFile(store.#persistenceFile, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const line of text.split("\n")) {
        if (line.trim()) store.#commit(JSON.parse(line));
      }
    }
    return store;
  }

  async append(event) {
    const errors = this.#validateEnvelope(event);
    if (errors.length) throw new DomainError("事件不符合领域契约", errors);
    if (this.#byId.has(event.event_id)) {
      throw new ConflictError(`事件已存在：${event.event_id}`);
    }
    const key = aggregateKey(event);
    const expected = (this.#versions.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      throw new ConflictError(`聚合 ${key} 的版本不连续：期望 ${expected}，收到 ${event.version}`);
    }
    if (this.#persistenceFile) {
      await appendFile(this.#persistenceFile, `${JSON.stringify(event)}\n`);
    }
    this.#commit(event);
    return event;
  }

  #commit(event) {
    this.#events.push(event);
    this.#byId.set(event.event_id, event);
    this.#versions.set(aggregateKey(event), event.version);
    for (const subscriber of this.#subscribers) subscriber(event);
  }

  subscribe(subscriber) {
    this.#subscribers.push(subscriber);
  }

  get(eventId) {
    return this.#byId.get(eventId) ?? null;
  }

  list({ aggregateType = null, aggregateId = null } = {}) {
    return this.#events.filter(
      (event) =>
        (!aggregateType || event.aggregate_type === aggregateType) &&
        (!aggregateId || event.aggregate_id === aggregateId),
    );
  }

  nextVersion(aggregateType, aggregateId) {
    return (this.#versions.get(`${aggregateType}:${aggregateId}`) ?? 0) + 1;
  }
}
