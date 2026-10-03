import { NotFoundError } from "../errors.js";

/**
 * 治理追溯：从一条（异常）预测出发，追到数据授权与撤回、脱敏与标注、
 * 训练运行与校验值、跨院跨设备验证与群体指标、放行决定与责任分工、
 * 暂停与影响评估，并给出处置责任与待办。
 */
export class TraceabilityService {
  constructor(context) {
    this.context = context;
  }

  tracePrediction(predictionId) {
    const { operational, projections } = this.context;
    const prediction = operational.predictionById(predictionId);
    if (!prediction) throw new NotFoundError(`预测不存在：${predictionId}`);

    const release = projections.releases.get(prediction.release_id) ?? null;
    const study = release
      ? projections.studies.get(release.decisions?.technical_validated?.reference) ?? null
      : null;
    const lineage = release ? projections.modelLineage(release.model_version) : null;

    const datasets = (lineage?.datasets ?? []).map((dataset) => ({
      dataset_version_id: dataset.dataset_version_id,
      institutions: dataset.institutions,
      deidentification: dataset.deidentification,
      annotation: dataset.annotation,
      synthetic: dataset.synthetic,
    }));
    const authorizations = (lineage?.authorizations ?? []).map((authorization) => ({
      authorization_id: authorization.authorization_id,
      dataset_version_id: authorization.dataset_version_id,
      status: authorization.status,
      granted_by: authorization.granted_by,
      purposes: authorization.purposes,
      withdrawal: authorization.withdrawal,
    }));

    const overrides = operational.overridesForPrediction(predictionId);
    const assessments = operational
      .recordsOf("withdrawal")
      .map((record) => record.assessment)
      .filter((assessment) => assessment.affected.releases.includes(prediction.release_id));

    const openActions = [];
    if (release?.status === "suspended" && release.responsibility) {
      openActions.push(`放行已暂停，由安全负责人 ${release.responsibility.safety_officer} 组织复核`);
    }
    for (const authorization of authorizations) {
      if (authorization.status === "withdrawn" && release?.responsibility) {
        openActions.push(
          `数据授权 ${authorization.authorization_id} 已撤回，由数据管家 ${release.responsibility.data_steward} 跟进影响评估`,
        );
      }
    }

    return {
      prediction,
      applicability: prediction.applicable_snapshot,
      release: release && {
        release_id: release.release_id,
        institution_id: release.institution_id,
        model_version: release.model_version,
        status: release.status,
        decisions: release.decisions,
        boundary: release.boundary,
        responsibility: release.responsibility,
        monitoring: release.monitoring,
      },
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
      },
      datasets,
      authorizations,
      overrides,
      suspensions: release?.suspensions ?? [],
      impact_assessments: assessments,
      disposition: {
        responsibility: release?.responsibility ?? null,
        open_actions: openActions,
      },
    };
  }
}
