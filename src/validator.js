// 向后兼容的基础校验入口：保留仓库原有的 validateEvent API，
// 内部委托到以 contracts/domain.schema.json 为入口的信封校验器。
// 对只包含契约五件套的外部交换事件采用 strictContract 模式。
import { validateEnvelope } from "./domain/envelope.js";

export function validateEvent(record) {
  return validateEnvelope(record, { strictContract: true });
}
