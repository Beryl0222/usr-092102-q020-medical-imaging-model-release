import { DomainError, NotFoundError } from "../errors.js";

/**
 * 回滚：对已暂停的旧版本放行追加一条 RELEASE_ACTIVATED（activation_kind=rollback），
 * 原预测全部保留并继续归属产生它们的版本。
 */
export class RollbackService {
  constructor(context) {
    this.context = context;
  }

  async rollback({ institution_id, to_model_version, decided_by, reason = null }) {
    if (typeof decided_by !== "string" || decided_by.trim().length === 0) {
      throw new DomainError("回滚必须登记 decided_by");
    }
    const target = this.context.projections.byScope(institution_id, to_model_version);
    if (!target) {
      throw new NotFoundError(`未找到放行：${institution_id} / ${to_model_version}`);
    }
    return this.context.emit({
      event_type: "RELEASE_ACTIVATED",
      aggregate_type: "clinical_release",
      aggregate_id: target.release_id,
      summary: `回滚 ${institution_id} 至 ${to_model_version}（保留原预测）`,
      release_id: target.release_id,
      activation_kind: "rollback",
      institution_id,
      model_version: to_model_version,
      retains_predictions: true,
      rollback_reason: reason ?? "版本回退",
      decided_by,
    });
  }
}
