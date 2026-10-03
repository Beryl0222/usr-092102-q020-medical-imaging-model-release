// 事件信封：以 contracts/domain.schema.json 为不可变事件入口。
// 该 schema 文件被视为只读契约，本模块只读取、不修改；新增事件只能扩展事件目录，
// 不能改动既有信封字段与稳定枚举。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCHEMA_PATH = fileURLToPath(
  new URL("../../contracts/domain.schema.json", import.meta.url),
);

let cachedSchema = null;

export function loadDomainSchema() {
  if (cachedSchema) return cachedSchema;
  const text = readFileSync(SCHEMA_PATH, "utf8");
  const schema = JSON.parse(text);
  // 契约自检：入口必须是我们承诺兼容的那一个。
  const required = [
    "event_id",
    "event_type",
    "aggregate_type",
    "aggregate_id",
    "occurred_at",
    "version",
    "summary",
  ];
  for (const field of required) {
    if (!schema.required.includes(field)) {
      throw new Error(`领域契约损坏：缺少不可变字段 ${field}`);
    }
  }
  cachedSchema = schema;
  return schema;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * 校验事件信封（领域 schema 约束的交换格式）。
 *
 * contracts/domain.schema.json 是不可变事件入口：它固定了七个必填字段、四种聚合与
 * 五个契约级事件类型，同时以 additionalProperties:true 为扩展留出空间。因此本函数
 * 严格校验字段与类型，但不把 event_type 限制死在契约五件套上——扩展事件类型由
 * catalog.js 的事件目录登记并约束其聚合归属（这是"不改写契约的扩展"方式）。
 *
 * @param {object} event
 * @param {{strictContract?: boolean}} [options] strictContract=true 时要求 event_type
 *        必须是契约枚举本身（用于校验外部系统按原契约发来的事件）。
 * @returns {string[]} 错误信息列表，空数组表示通过。
 */
export function validateEnvelope(event, options = {}) {
  const schema = loadDomainSchema();
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return ["事件必须是对象"];
  }
  const errors = [];
  for (const field of schema.required) {
    if (!(field in event)) errors.push(`缺少字段：${field}`);
  }
  if ("event_id" in event && (typeof event.event_id !== "string" || event.event_id.length === 0)) {
    errors.push("event_id 必须是非空字符串");
  }
  if ("event_type" in event) {
    if (typeof event.event_type !== "string" || event.event_type.length === 0) {
      errors.push("event_type 必须是非空字符串");
    } else if (
      options.strictContract &&
      !schema.properties.event_type.enum.includes(event.event_type)
    ) {
      errors.push(`event_type 不在契约枚举内：${event.event_type}`);
    }
  }
  if (
    "aggregate_type" in event &&
    !schema.properties.aggregate_type.enum.includes(event.aggregate_type)
  ) {
    errors.push(`aggregate_type 不在契约枚举内：${event.aggregate_type}`);
  }
  if ("aggregate_id" in event && (typeof event.aggregate_id !== "string" || event.aggregate_id.length === 0)) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if ("occurred_at" in event && (typeof event.occurred_at !== "string" || !ISO_DATE_TIME.test(event.occurred_at))) {
    errors.push("occurred_at 必须是 ISO 8601 date-time");
  }
  if ("version" in event && (!Number.isInteger(event.version) || event.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("summary" in event && (typeof event.summary !== "string" || event.summary.length === 0)) {
    errors.push("summary 必须是非空字符串");
  }
  // 契约允许 additionalProperties：扩展载荷放在 payload，保证跨版本兼容。
  if ("payload" in event && (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload))) {
    errors.push("payload 必须是对象");
  }
  if ("metadata" in event && (event.metadata === null || typeof event.metadata !== "object" || Array.isArray(event.metadata))) {
    errors.push("metadata 必须是对象");
  }
  return errors;
}

/** 契约允许的全部事件类型（不可变五件套）。 */
export const CONTRACT_EVENT_TYPES = Object.freeze(
  loadDomainSchema().properties.event_type.enum.slice(),
);
/** 契约允许的全部聚合类型。 */
export const CONTRACT_AGGREGATE_TYPES = Object.freeze(
  loadDomainSchema().properties.aggregate_type.enum.slice(),
);

export function isContractEventType(type) {
  return CONTRACT_EVENT_TYPES.includes(type);
}
