import { randomUUID } from "node:crypto";

import { ConflictError, DomainError, NotFoundError } from "../errors.js";

/**
 * 数据授权撤回：触发影响评估而非删除既往研究。
 * 沿血缘找到受影响的数据集版本 → 训练运行 → 验证研究 → 启用中的放行，
 * 对启用中的放行按机构+版本局部暂停；历史事件、研究与预测全部保留。
 */
export class WithdrawalService {
  constructor(context) {
    this.context = context;
  }

  async withdraw({ authorization_id, reason, requested_by, effective_at = null }) {
    const { projections, operational, now, suspendRelease } = this.context;
    const authorization = projections.authorizations.get(authorization_id);
    if (!authorization) throw new NotFoundError(`数据授权不存在：${authorization_id}`);
    if (authorization.status === "withdrawn") {
      throw new ConflictError(`数据授权已撤回：${authorization_id}`);
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new DomainError("撤回必须说明理由 reason");
    }
    const effectiveAt = effective_at ?? now();

    authorization.status = "withdrawn";
    authorization.withdrawal = { reason, requested_by: requested_by ?? null, effective_at: effectiveAt };

    const datasets = [...projections.datasets.values()].filter(
      (dataset) => dataset.authorization.authorization_id === authorization_id,
    );
    const datasetIds = new Set(datasets.map((dataset) => dataset.dataset_version_id));
    const models = [...projections.models.values()].filter((model) =>
      model.dataset_version_ids.some((id) => datasetIds.has(id)),
    );
    const modelVersions = new Set(models.map((model) => model.model_version));
    const studies = [...projections.studies.values()].filter((study) => modelVersions.has(study.model_version));
    const releases = [...projections.releases.values()].filter(
      (release) => release.status === "active" && modelVersions.has(release.model_version),
    );

    const assessment = {
      impact_assessment_id: randomUUID(),
      authorization_id,
      reason,
      requested_by: requested_by ?? null,
      effective_at: effectiveAt,
      affected: {
        dataset_versions: [...datasetIds],
        model_builds: [...modelVersions],
        validation_studies: studies.map((study) => study.study_id),
        releases: releases.map((release) => release.release_id),
      },
      suspensions: [],
      policy: "既往研究、验证、预测全部保留，仅停止后续使用",
      created_at: now(),
    };

    for (const release of releases) {
      const event = await suspendRelease({
        release_id: release.release_id,
        reason: "DATA_WITHDRAWAL_IMPACT",
        detail: `数据授权 ${authorization_id} 撤回，影响评估 ${assessment.impact_assessment_id}`,
      });
      if (event) assessment.suspensions.push(event.event_id);
    }

    await operational.add("withdrawal", {
      authorization_id,
      reason,
      requested_by: requested_by ?? null,
      effective_at: effectiveAt,
      assessment,
    });
    return assessment;
  }

  /** 回放操作型记录时恢复授权状态（不重复触发暂停，暂停已在事件日志中）。 */
  restore(record) {
    const authorization = this.context.projections.authorizations.get(record.authorization_id);
    if (authorization) {
      authorization.status = "withdrawn";
      authorization.withdrawal = {
        reason: record.reason,
        requested_by: record.requested_by,
        effective_at: record.effective_at,
      };
    }
  }

  getAssessment(assessmentId) {
    const assessment = this.context.operational.assessmentById(assessmentId);
    if (!assessment) throw new NotFoundError(`影响评估不存在：${assessmentId}`);
    return assessment;
  }
}
