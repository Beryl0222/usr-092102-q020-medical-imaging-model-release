/**
 * 联调用中文样例：一套内部一致的放行链路（数据集 → 训练 → 验证 → 放行），
 * 供演示脚本与测试复用。所有函数返回完整事件对象，可用 overrides 覆盖字段。
 */
export const IDS = {
  dataset: "ds-chest-ct-v3",
  auth: "auth-chest-001",
  modelV110: "cxr-model@1.1.0",
  modelV120: "cxr-model@1.2.0",
  study110: "study-2026-110",
  study120: "study-2026-120",
  releaseB110: "rel-hospital-b-110",
  releaseB120: "rel-hospital-b-120",
  releaseA120: "rel-hospital-a-120",
};

export function checksum(char = "a") {
  return `sha256:${char.repeat(64)}`;
}

export function datasetApprovedEvent(overrides = {}) {
  return {
    event_id: "evt-dataset-001",
    event_type: "DATASET_APPROVED",
    aggregate_type: "imaging_dataset",
    aggregate_id: IDS.dataset,
    occurred_at: "2026-09-01T09:00:00+08:00",
    version: 1,
    summary: "胸部CT数据集v3获批",
    dataset_version_id: IDS.dataset,
    authorization: {
      authorization_id: IDS.auth,
      purposes: ["model_training", "validation"],
      granted_by: "联盟数据委员会",
      granted_at: "2026-08-20T10:00:00+08:00",
      withdrawal_terms: "提前30天通知并触发影响评估",
    },
    deidentification: {
      method: "DICOM标签清除+面部结构重采样",
      verified_by: "脱敏质控员-周",
      verified_at: "2026-08-25T10:00:00+08:00",
      residual_risk: "low",
      passed: true,
    },
    annotation: {
      schema_version: "labels-v2.1",
      adjudication: "expert_review",
      open_disputes: 0,
      resolved_disputes: 23,
    },
    synthetic: {
      ratio: 0.2,
      generator: "ct-synth-gan-v1",
      provenance: "基于授权队列分布合成，不含可回溯个体",
    },
    institutions: ["hospital-a", "hospital-b", "hospital-c"],
    ...overrides,
  };
}

export function modelTrainedEvent(overrides = {}) {
  return {
    event_id: "evt-model-120",
    event_type: "MODEL_TRAINED",
    aggregate_type: "model_build",
    aggregate_id: IDS.modelV120,
    occurred_at: "2026-09-05T09:00:00+08:00",
    version: 1,
    summary: "胸片模型1.2.0训练完成",
    model_version: IDS.modelV120,
    training_run_id: "run-2026-0905-01",
    dataset_version_ids: [IDS.dataset],
    package_checksum: checksum("b"),
    synthetic_ratio: 0.2,
    code_ref: "git://train/cxr@f31d2a",
    ...overrides,
  };
}

export function validationCompletedEvent(overrides = {}) {
  return {
    event_id: "evt-study-120",
    event_type: "VALIDATION_COMPLETED",
    aggregate_type: "validation_study",
    aggregate_id: IDS.study120,
    occurred_at: "2026-09-12T09:00:00+08:00",
    version: 1,
    summary: "1.2.0跨院跨设备验证完成",
    study_id: IDS.study120,
    model_version: IDS.modelV120,
    package_checksum: checksum("b"),
    reproduction: {
      sites: [
        { institution_id: "hospital-a", vendor: "GE", sensitivity: 0.93, specificity: 0.88, n: 500 },
        { institution_id: "hospital-b", vendor: "Siemens", sensitivity: 0.91, specificity: 0.9, n: 420 },
        { institution_id: "hospital-c", vendor: "GE", sensitivity: 0.92, specificity: 0.89, n: 310 },
      ],
    },
    group_metrics: {
      adult: { sensitivity: 0.93, specificity: 0.89, ci_lower: 0.9, n: 800 },
      pediatric: { sensitivity: 0.9, specificity: 0.88, ci_lower: 0.85, n: 120 },
      elderly: { sensitivity: 0.91, specificity: 0.87, ci_lower: 0.86, n: 200 },
      rare_disease: { sensitivity: 0.88, specificity: 0.86, ci_lower: 0.8, n: 40 },
    },
    thresholds: { operating_point: 0.5 },
    coverage: {
      diseases: ["pneumonia", "nodule"],
      populations: ["adult", "pediatric", "elderly", "rare_disease"],
      device_vendors: ["GE", "Siemens"],
    },
    ...overrides,
  };
}

export function releaseActivatedEvent(overrides = {}) {
  return {
    event_id: "evt-release-b120",
    event_type: "RELEASE_ACTIVATED",
    aggregate_type: "clinical_release",
    aggregate_id: IDS.releaseB120,
    occurred_at: "2026-09-20T09:00:00+08:00",
    version: 1,
    summary: "医院B启用胸片模型1.2.0",
    release_id: IDS.releaseB120,
    activation_kind: "initial",
    institution_id: "hospital-b",
    model_version: IDS.modelV120,
    decisions: {
      research_completed: { decided_by: "科研处-陈", decided_at: "2026-09-10T09:00:00+08:00", reference: "res-2026-041" },
      ethics_approved: { decided_by: "伦理委员会-吴", decided_at: "2026-09-15T09:00:00+08:00", reference: "eth-2026-118" },
      technical_validated: { decided_by: "技术验证组-郑", decided_at: "2026-09-18T09:00:00+08:00", reference: IDS.study120 },
      site_activated: { decided_by: "信息科-孙", decided_at: "2026-09-20T08:00:00+08:00", reference: "act-2026-090" },
    },
    boundary: {
      diseases: ["pneumonia", "nodule"],
      populations: ["adult", "pediatric", "elderly", "rare_disease"],
      device_vendors: ["GE", "Siemens"],
      thresholds: { operating_point: 0.5, min_sensitivity: 0.8 },
      escalation: {
        low_confidence_below: 0.6,
        always_escalate_populations: ["rare_disease"],
        escalate_on_drift: true,
      },
    },
    responsibility: {
      model_owner: "AI实验室-张",
      clinical_owner: "影像科-李",
      data_steward: "数据办-王",
      safety_officer: "质控办-赵",
    },
    monitoring: {
      drift: { psi_max: 0.2 },
      metric_floors: { sensitivity_min: 0.8 },
      evaluation_window_days: 30,
    },
    ...overrides,
  };
}

/** 1.1.0 版本三件套（用于回滚场景）：模型、验证、医院B放行。 */
export function v110Events() {
  const model = modelTrainedEvent({
    event_id: "evt-model-110",
    aggregate_id: IDS.modelV110,
    summary: "胸片模型1.1.0训练完成",
    model_version: IDS.modelV110,
    training_run_id: "run-2026-0902-01",
    package_checksum: checksum("c"),
    occurred_at: "2026-09-02T09:00:00+08:00",
  });
  const study = validationCompletedEvent({
    event_id: "evt-study-110",
    aggregate_id: IDS.study110,
    summary: "1.1.0跨院跨设备验证完成",
    study_id: IDS.study110,
    model_version: IDS.modelV110,
    package_checksum: checksum("c"),
    occurred_at: "2026-09-06T09:00:00+08:00",
  });
  const release = releaseActivatedEvent({
    event_id: "evt-release-b110",
    aggregate_id: IDS.releaseB110,
    summary: "医院B启用胸片模型1.1.0",
    release_id: IDS.releaseB110,
    model_version: IDS.modelV110,
    occurred_at: "2026-09-08T09:00:00+08:00",
    decisions: {
      ...releaseActivatedEvent().decisions,
      research_completed: { decided_by: "科研处-陈", decided_at: "2026-09-02T08:00:00+08:00", reference: "res-2026-033" },
      ethics_approved: { decided_by: "伦理委员会-吴", decided_at: "2026-09-04T09:00:00+08:00", reference: "eth-2026-102" },
      technical_validated: { decided_by: "技术验证组-郑", decided_at: "2026-09-06T09:00:00+08:00", reference: IDS.study110 },
      site_activated: { decided_by: "信息科-孙", decided_at: "2026-09-08T08:00:00+08:00", reference: "act-2026-071" },
    },
  });
  return { model, study, release };
}

/** 追加一条数据集 + 1.2.0 模型 + 验证 + 指定机构放行的完整链路。 */
export async function seedBaseline(system, { institution = "hospital-b", releaseId = IDS.releaseB120 } = {}) {
  await system.appendEvent(datasetApprovedEvent());
  await system.appendEvent(modelTrainedEvent());
  await system.appendEvent(validationCompletedEvent());
  await system.appendEvent(
    releaseActivatedEvent({
      aggregate_id: releaseId,
      release_id: releaseId,
      institution_id: institution,
      summary: `${institution}启用胸片模型1.2.0`,
    }),
  );
  return { releaseId, modelVersion: IDS.modelV120, studyId: IDS.study120, datasetId: IDS.dataset, authId: IDS.auth };
}
