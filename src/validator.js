import { loadContractSchema, validateAgainstSchema } from "./schema-validator.js";

/**
 * 以 contracts/domain.schema.json 为唯一入口校验事件信封。
 * 返回中文错误信息数组，空数组表示通过。
 */
export function validateEvent(record) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return ["事件必须是对象"];
  }
  return validateAgainstSchema(loadContractSchema(), record);
}
