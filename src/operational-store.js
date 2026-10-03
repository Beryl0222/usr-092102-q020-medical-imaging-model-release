import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const KINDS = [
  "prediction",
  "override",
  "withdrawal",
  "sample",
  "safety_event",
  "violation",
  "applicability",
];

/**
 * 操作型记录存储：预测、医生覆盖、授权撤回与影响评估、监控样本、
 * 安全事件、越界调用、适用性检查审计。记录只增不改，可选 JSONL 持久化。
 * 这些不是领域事件（契约枚举之外），但与事件日志并列构成完整证据链。
 */
export class OperationalStore {
  #records = Object.fromEntries(KINDS.map((kind) => [kind, []]));
  #file = null;

  static async open({ file = null } = {}) {
    const store = new OperationalStore();
    store.#file = file;
    if (file) {
      await mkdir(dirname(file), { recursive: true });
      let text = "";
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const { kind, record } = JSON.parse(line);
        if (store.#records[kind]) store.#records[kind].push(record);
      }
    }
    return store;
  }

  async add(kind, record) {
    if (!this.#records[kind]) throw new Error(`未知记录类型：${kind}`);
    this.#records[kind].push(record);
    if (this.#file) await appendFile(this.#file, `${JSON.stringify({ kind, record })}\n`);
    return record;
  }

  recordsOf(kind) {
    return this.#records[kind] ?? [];
  }

  get predictions() {
    return this.#records.prediction;
  }

  get overrides() {
    return this.#records.override;
  }

  predictionById(predictionId) {
    return this.#records.prediction.find((p) => p.prediction_id === predictionId) ?? null;
  }

  overridesForPrediction(predictionId) {
    return this.#records.override.filter((o) => o.prediction_id === predictionId);
  }

  withdrawalByAuthorization(authorizationId) {
    return this.#records.withdrawal.find((w) => w.authorization_id === authorizationId) ?? null;
  }

  assessmentById(assessmentId) {
    const found = this.#records.withdrawal.find(
      (w) => w.assessment.impact_assessment_id === assessmentId,
    );
    return found ? found.assessment : null;
  }
}
