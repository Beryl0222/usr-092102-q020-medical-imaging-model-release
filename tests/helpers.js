import assert from "node:assert/strict";

/** assert.rejects 的增强版：正则同时匹配 error.message 与 error.details。 */
export async function rejectsMatching(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    const text = [error.message, ...(error.details ?? [])].join("\n");
    assert.match(text, pattern);
    return error;
  }
  assert.fail(`期望抛出匹配 ${pattern} 的错误，但成功返回了`);
}
