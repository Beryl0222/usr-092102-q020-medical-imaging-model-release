import { NotFoundError } from "../errors.js";

/**
 * 可执行放行包：把数据授权/撤回、脱敏验证、标注争议、数据集版本、合成来源、
 * 训练运行、模型包校验值、跨院跨设备复现、群体偏差、用途边界、责任分工
 * 逐层关联成一份机器可核查的 bundle，而不是一份平均指标报告。
 */
export class ReleasePackageService {
  constructor(context) {
    this.context = context;
  }

  getPackage(releaseId) {
    const { projections, now } = this.context;
    const release = projections.releases.get(releaseId);
    if (!release) throw new NotFoundError(`放行不存在：${releaseId}`);

    const study = projections.studies.get(release.decisions?.technical_validated?.reference) ?? null;
    const lineage = projections.modelLineage(release.model_version);
    const datasets = (lineage?.datasets ?? []).map((dataset) => {
      const authorization = projections.authorizations.get(dataset.authorization.authorization_id);
      return {
        dataset_version_id: dataset.dataset_version_id,
        institutions: dataset.institutions,
        authorization: {
          ...dataset.authorization,
          status: authorization?.status ?? "unknown",
          withdrawal: authorization?.withdrawal ?? null,
        },
        deidentification: dataset.deidentification,
        annotation: dataset.annotation,
        synthetic: dataset.synthetic,
      };
    });

    return {
      release_id: release.release_id,
      status: release.status,
      institution_id: release.institution_id,
      model_version: release.model_version,
      activation_kind: release.activation_kind,
      decisions: release.decisions,
      boundary: release.boundary,
      responsibility: release.responsibility,
      monitoring: release.monitoring,
      validation: study && {
        study_id: study.study_id,
        package_checksum: study.package_checksum,
        coverage: study.coverage,
        group_metrics: study.group_metrics,
        reproduction: study.reproduction,
        thresholds: study.thresholds,
      },
      model: lineage?.model && {
        model_version: lineage.model.model_version,
        training_run_id: lineage.model.training_run_id,
        package_checksum: lineage.model.package_checksum,
        synthetic_ratio: lineage.model.synthetic_ratio,
        code_ref: lineage.model.code_ref,
        dataset_version_ids: lineage.model.dataset_version_ids,
      },
      datasets,
      lineage_ok: datasets.length > 0 && datasets.every((d) => d.authorization.status === "active"),
      suspensions: release.suspensions,
      generated_at: now(),
    };
  }
}
