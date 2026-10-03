// 端到端场景构造：构建一条"逐层关联、全部达标"的金标准证据链，
// 以及一个对照用的"只有研发医院单中心单厂商平均指标"包（重申请被拒场景）。
import { createHash } from "node:crypto";

import { createReleaseService } from "../application/service.js";

export const SITES = Object.freeze({
  DEV: "site-dev-hospital", // 研发医院
  COMM_A: "site-community-a", // 基层医院 A
  COMM_B: "site-community-b", // 基层医院 B
});
export const VENDORS = Object.freeze({
  V1: { vendor: "Xinguang Medical", model: "XR-100" },
  V2: { vendor: "Beichen Imaging", model: "BC-2000" },
});
export const POPS = Object.freeze({
  ADULT: "adult",
  CHILDREN: "children",
  ELDERLY: "elderly",
  RARE: "rare_disease",
});
export const INDICATION = "chest_xray_tuberculosis";
export const THRESHOLD = 0.5;

export function fakeSha(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

function stratum(groupKey, { n = 120, sens = 0.95, ciLow = 0.9, ciHigh = 0.99, spec = 0.92 } = {}) {
  return { group_key: groupKey, n, sensitivity: sens, specificity: spec, ci_low: ciLow, ci_high: ciHigh };
}

export const FULL_SCOPE = Object.freeze({
  indications: [INDICATION],
  populations: [POPS.ADULT, POPS.CHILDREN, POPS.ELDERLY, POPS.RARE],
  devices: [VENDORS.V1, VENDORS.V2],
  threshold: THRESHOLD,
  mandatory_escalation_populations: [POPS.RARE],
});

/**
 * 构建完整合规链并返回 service 与所有关键 ID。
 *  opts: { store, now, idGen, disputeAndResolve?, packageId? }
 */
export function buildGoldenChain(opts = {}) {
  const service = createReleaseService({ store: opts.store, now: opts.now, idGen: opts.idGen });
  const svc = service;
  const pkgId = opts.packageId ?? "pkg-chest-v1";
  const dvId = "ds-chest-v1";
  const runId = "run-chest-001";

  // 真实记录授权（8 条，覆盖不同人群；授权方可以是患者本人或机构）
  const recordIds = [];
  for (let i = 1; i <= 8; i += 1) {
    const id = `rec-${String(i).padStart(3, "0")}`;
    recordIds.push(id);
    svc.grantData({
      record_id: id,
      granted_by: i % 2 === 0 ? "patient-guardian" : "institution-steward",
      purpose: "chest_xray_tuberculosis_model",
      expires_at: "2028-12-31T23:59:59+08:00",
    });
  }

  // 合成数据批次：20%，必须写明生成器、种子与真实来源
  svc.registerSyntheticBatch({
    batch_id: "syn-001",
    generator_run_id: "generator-gans-2026-09",
    seed: "20260901-gans-seed",
    source_record_ids: ["rec-001", "rec-002"],
    provenance: "GAN 基于 rec-001/rec-002 生成，经放射科与统计专家双重复核",
    ratio_in_version: 0.2,
  });

  // 冻结数据集版本：合成占比 20%
  svc.publishDatasetVersion({
    dataset_version_id: dvId,
    real_record_ids: recordIds,
    synthetic_batch_ids: ["syn-001"],
    synthetic_ratio: 0.2,
    notes: "胸片结核筛查数据集 v1（真实 8 + 合成 2，占比 20%）",
  });

  // 独立脱敏验证：零直接标识残留
  svc.verifyDeidentification({
    dataset_version_id: dvId,
    verifier: "privacy-office-li",
    method: "DICOM 标签清扫 + k-匿名 + 人工复核 200 张抽样",
    report_id: "DEID-2026-017",
    residual_direct_identifiers: 0,
    reidentification_risk: 0.004,
  });

  // 标注争议：先提出，再由第三方裁决（默认裁决后清零；leaveDisputeOpen 时保持未裁决）
  svc.raiseAnnotationDispute({
    dispute_id: "disp-001",
    dataset_version_id: dvId,
    item_ref: "rec-004#frame-12",
    raised_by: "radiologist-wang",
    reason: "结节与陈旧钙化难辨，初标阳性存疑",
  });
  if (!opts.leaveDisputeOpen) {
    svc.resolveAnnotationDispute({
      dispute_id: "disp-001",
      dataset_version_id: dvId,
      resolved_by: "third-party-radiology-panel",
      resolution: "corrected",
      adjudicated_label: "negative",
    });
  }

  // 数据治理放行（契约事件）
  svc.approveDataset({
    dataset_version_id: dvId,
    approved_by: "data-governance-zhou",
    allowed_run_purpose: ["chest_xray_tuberculosis_model"],
  });

  // 训练运行 + 模型包（sha256 不可变）
  svc.startTrainingRun({
    run_id: runId,
    dataset_version_id: dvId,
    started_by: "ml-engineer-chen",
    purpose: "chest_xray_tuberculosis_model",
  });
  const sha = fakeSha(pkgId);
  svc.registerPackage({
    package_id: pkgId,
    run_id: runId,
    sha256: sha,
    intended_use: FULL_SCOPE,
  });
  svc.completeTraining({ run_id: runId, package_id: pkgId, sha256: sha });

  // 跨 2 家医院 × 2 个厂商设备的研究，每个研究逐一报告四个亚组（含 CI）
  const studyMatrix = [
    { site: SITES.DEV, device: VENDORS.V1 },
    { site: SITES.DEV, device: VENDORS.V2 },
    { site: SITES.COMM_A, device: VENDORS.V1 },
    { site: SITES.COMM_A, device: VENDORS.V2 },
  ];
  const studyIds = [];
  studyMatrix.forEach((cell, i) => {
    const studyId = `study-${String(i + 1).padStart(2, "0")}`;
    studyIds.push(studyId);
    svc.recordValidation({
      study_id: studyId,
      package_id: pkgId,
      site_id: cell.site,
      device_vendor: cell.device.vendor,
      device_model: cell.device.model,
      indications: [INDICATION],
      threshold: THRESHOLD,
      strata: [
        stratum(POPS.ADULT, { n: 220, sens: 0.96, ciLow: 0.92 }),
        stratum(POPS.CHILDREN, { n: 64, sens: 0.93, ciLow: 0.85 }),
        stratum(POPS.ELDERLY, { n: 88, sens: 0.94, ciLow: 0.87 }),
        stratum(POPS.RARE, { n: 40, sens: 0.92, ciLow: 0.82 }),
      ],
    });
  });

  // 群体偏差评估：最差亚组差距 0.04，非劣界值 0.10
  svc.assessSubgroupBias({
    assessment_id: "bias-001",
    package_id: pkgId,
    reference_group: "adult",
    worst_group: POPS.RARE,
    worst_sensitivity_gap: 0.04,
    non_inferiority_margin: 0.1,
  });

  // 决定一：研究完成
  svc.completeResearch({
    package_id: pkgId,
    study_ids: studyIds,
    principal_investigator: "dr-principal-sun",
  });
  // 决定二：伦理通过（非惩罚条款为必备条件）
  svc.grantEthics({
    package_id: pkgId,
    committee_id: "irb-alliance",
    approval_id: "IRB-2026-1001",
    decided_by: "irb-chairperson",
    valid_until: "2027-12-31T23:59:59+08:00",
    conditions: ["基层使用须保留人工升级通道", "每季度提交监测报告"],
    covers_override_non_punitive: true,
  });
  // 决定三：联盟技术验证接受
  svc.acceptTechnical({
    package_id: pkgId,
    accepted_by: "alliance-tech-board",
    assessment_id: "bias-001",
    required_device_vendors: [VENDORS.V1.vendor, VENDORS.V2.vendor],
    required_populations: [POPS.CHILDREN, POPS.ELDERLY, POPS.RARE],
    verified_sha256: sha,
  });

  return {
    service,
    ids: { pkgId, dvId, runId, recordIds, studyIds, sha },
    activate: (releaseId, institutionId, activatedBy, scope = FULL_SCOPE, policy) =>
      service.activateRelease({
        release_id: releaseId,
        package_id: pkgId,
        institution_id: institutionId,
        activated_by: activatedBy,
        scope,
        policy,
      }),
  };
}

/**
 * 对照链：只在研发医院、单一厂商上验证，且只有整体平均指标（无儿童/老年/罕见病亚组）。
 * 用于复现伦理委员会首次暂缓的理由。
 */
export function buildSingleCenterChain(opts = {}) {
  const service = createReleaseService({ store: opts.store, now: opts.now, idGen: opts.idGen });
  const svc = service;
  const pkgId = "pkg-chest-pilot";
  const dvId = "ds-pilot-v1";
  const runId = "run-pilot-001";
  const id = "rec-pilot-001";
  svc.grantData({ record_id: id, granted_by: "institution-steward", purpose: "pilot" });
  svc.publishDatasetVersion({
    dataset_version_id: dvId,
    real_record_ids: [id],
    synthetic_batch_ids: [],
    synthetic_ratio: 0,
  });
  svc.verifyDeidentification({
    dataset_version_id: dvId,
    verifier: "privacy-office-li",
    method: "DICOM 标签清扫",
    report_id: "DEID-PILOT-1",
    residual_direct_identifiers: 0,
    reidentification_risk: 0.01,
  });
  svc.approveDataset({ dataset_version_id: dvId, approved_by: "data-governance-zhou", allowed_run_purpose: ["pilot"] });
  svc.startTrainingRun({ run_id: runId, dataset_version_id: dvId, started_by: "ml-engineer-chen", purpose: "pilot" });
  const sha = fakeSha(pkgId);
  svc.registerPackage({ package_id: pkgId, run_id: runId, sha256: sha, intended_use: FULL_SCOPE });
  svc.completeTraining({ run_id: runId, package_id: pkgId, sha256: sha });

  // 仅研发医院、仅厂商 V1，且只报成人混合"平均灵敏度 0.95"
  svc.recordValidation({
    study_id: "study-pilot-01",
    package_id: pkgId,
    site_id: SITES.DEV,
    device_vendor: VENDORS.V1.vendor,
    device_model: VENDORS.V1.model,
    indications: [INDICATION],
    threshold: THRESHOLD,
    strata: [stratum(POPS.ADULT, { n: 300, sens: 0.95, ciLow: 0.91 })],
  });
  svc.completeResearch({
    package_id: pkgId,
    study_ids: ["study-pilot-01"],
    principal_investigator: "dr-principal-sun",
  });
  svc.grantEthics({
    package_id: pkgId,
    committee_id: "irb-alliance",
    approval_id: "IRB-PILOT",
    decided_by: "irb-chairperson",
    conditions: [],
    covers_override_non_punitive: true,
  });
  // 技术验证接受也不存在：缺跨厂商、缺亚组证据
  return { service, ids: { pkgId, sha } };
}
