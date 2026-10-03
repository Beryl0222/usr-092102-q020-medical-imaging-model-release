import { readFileSync } from "node:fs";

const FORMAT_CHECKERS = {
  "date-time": (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
};

let cachedContract = null;

/** 读取不可变的领域事件契约（contracts/domain.schema.json）。 */
export function loadContractSchema() {
  if (!cachedContract) {
    cachedContract = JSON.parse(readFileSync(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  }
  return cachedContract;
}

/**
 * 契约所需的 JSON Schema 子集校验：type / required / properties / items /
 * enum / minLength / minimum / maximum / format(date-time)。
 * 返回中文错误信息数组，空数组表示通过。
 */
export function validateAgainstSchema(schema, value, path = "$") {
  const errors = [];
  if (schema.type && !checkType(schema.type, value)) {
    errors.push(`${path} 应为 ${schema.type}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} 必须是 ${schema.enum.join(" / ")} 之一`);
  }
  if (schema.type === "string") {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path} 长度不能小于 ${schema.minLength}`);
    }
    const formatCheck = schema.format && FORMAT_CHECKERS[schema.format];
    if (formatCheck && !formatCheck(value)) {
      errors.push(`${path} 不是合法的 ${schema.format}`);
    }
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} 不能小于 ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} 不能大于 ${schema.maximum}`);
  }
  if (schema.type === "object") {
    for (const name of schema.required ?? []) {
      if (!(name in value)) errors.push(`${path} 缺少字段：${name}`);
    }
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (name in value) errors.push(...validateAgainstSchema(sub, value[name], `${path}.${name}`));
    }
  }
  if (schema.type === "array" && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateAgainstSchema(schema.items, item, `${path}[${index}]`));
    });
  }
  return errors;
}

function checkType(type, value) {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}
