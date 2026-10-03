import assert from "node:assert/strict";
import test from "node:test";

import {
  IDS,
  checksum,
  datasetApprovedEvent,
  modelTrainedEvent,
  releaseActivatedEvent,
  seedBaseline,
  validationCompletedEvent,
} from "../examples/scenario.js";
import { createReleaseSystem } from "../src/system.js";

const system = () => createReleaseSystem();

async function appendAndGetErrors(sys, event) {
  try {
    await sys.appendEvent(event);
    return [];
  } catch (error) {
    return [error.message, ...(error.details ?? [])].join("\n");
  }
}

test("数据集获批：脱敏未通过 / 标注争议未裁决 / 高风险 / 合成来源缺失 均被拒绝", async () => {
  const sys = await system();
  const deid = datasetApprovedEvent({
    deidentification: { method: "m", verified_by: "v", verified_at: "2026-08-25T10:00:00+08:00", residual_risk: "low", passed: false },
  });
  assert.match(await appendAndGetErrors(sys, deid), /脱敏验证未通过/);

  const disputes = datasetApprovedEvent({ annotation: { schema_version: "v", adjudication: "expert_review", open_disputes: 2 } });
  assert.match(await appendAndGetErrors(sys, disputes), /2 条标注争议未裁决/);

  const risky = datasetApprovedEvent({
    deidentification: { method: "m", verified_by: "v", verified_at: "2026-08-25T10:00:00+08:00", residual_risk: "high", passed: true },
  });
  assert.match(await appendAndGetErrors(sys, risky), /residual_risk/);

  const noProvenance = datasetApprovedEvent({ synthetic: { ratio: 0.3 } });
  assert.match(await appendAndGetErrors(sys, noProvenance), /生成器 generator/);
});

test("数据集获批：合法载荷通过，重复获批被拒绝", async () => {
  const sys = await system();
  await sys.appendEvent(datasetApprovedEvent());
  assert.match(await appendAndGetErrors(sys, datasetApprovedEvent({ event_id: "evt-x", version: 2 })), /已获批/);
});

test("训练登记：未知数据集 / 校验值格式 / 合成占比越界 均被拒绝", async () => {
  const sys = await system();
  await sys.appendEvent(datasetApprovedEvent());

  assert.match(
    await appendAndGetErrors(sys, modelTrainedEvent({ dataset_version_ids: ["ds-unknown"] })),
    /未获批：ds-unknown/,
  );
  assert.match(
    await appendAndGetErrors(sys, modelTrainedEvent({ package_checksum: "md5:abc" })),
    /sha256:<64位十六进制>/,
  );
  assert.match(
    await appendAndGetErrors(sys, modelTrainedEvent({ synthetic_ratio: 0.5 })),
    /超出所引数据集占比范围 \[0\.2, 0\.2\]/,
  );
  await sys.appendEvent(modelTrainedEvent());
  assert.ok(sys.projections.models.has(IDS.modelV120));
});

test("验证研究：校验值不一致 / 单机构 / 单厂商 / 覆盖人群缺指标 均被拒绝", async () => {
  const sys = await system();
  await sys.appendEvent(datasetApprovedEvent());
  await sys.appendEvent(modelTrainedEvent());

  assert.match(
    await appendAndGetErrors(sys, validationCompletedEvent({ package_checksum: checksum("f") })),
    /校验值与训练登记不一致/,
  );
  const oneSite = validationCompletedEvent({
    reproduction: { sites: [{ institution_id: "hospital-a", vendor: "GE", sensitivity: 0.9, specificity: 0.9, n: 100 }] },
  });
  assert.match(await appendAndGetErrors(sys, oneSite), /至少需要 2 家机构/);

  const oneVendor = validationCompletedEvent({
    reproduction: {
      sites: [
        { institution_id: "hospital-a", vendor: "GE", sensitivity: 0.9, specificity: 0.9, n: 100 },
        { institution_id: "hospital-b", vendor: "GE", sensitivity: 0.9, specificity: 0.9, n: 100 },
      ],
    },
  });
  assert.match(await appendAndGetErrors(sys, oneVendor), /至少需要 2 家厂商/);

  const missingGroup = validationCompletedEvent({
    coverage: { diseases: ["pneumonia"], populations: ["adult", "pediatric"], device_vendors: ["GE", "Siemens"] },
    group_metrics: { adult: { sensitivity: 0.9, specificity: 0.9, ci_lower: 0.85, n: 100 } },
  });
  assert.match(await appendAndGetErrors(sys, missingGroup), /覆盖人群 pediatric 缺少分群指标/);
});

test("放行四决定：缺决定 / 时序颠倒 / 技术验证引用不存在 均被拒绝", async () => {
  const sys = await system();
  await seedBaselineDataOnly(sys);

  const noDecisions = releaseActivatedEvent({ decisions: undefined });
  assert.match(await appendAndGetErrors(sys, noDecisions), /四个决定/);

  const base = releaseActivatedEvent();
  const reversed = releaseActivatedEvent({
    decisions: {
      ...base.decisions,
      ethics_approved: { decided_by: "伦理委员会-吴", decided_at: "2026-09-05T09:00:00+08:00", reference: "eth-2026-118" },
    },
  });
  assert.match(await appendAndGetErrors(sys, reversed), /时序必须是 研究完成 ≤ 伦理通过 ≤ 技术验证 ≤ 院内启用/);

  const badRef = releaseActivatedEvent({
    decisions: {
      ...base.decisions,
      technical_validated: { decided_by: "技术验证组-郑", decided_at: "2026-09-18T09:00:00+08:00", reference: "study-none" },
    },
  });
  assert.match(await appendAndGetErrors(sys, badRef), /研究不存在：study-none/);
});

test("放行边界：病种/人群/厂商超出验证覆盖、人群阈值失守、机构未复现 均被拒绝", async () => {
  const sys = await system();
  await seedBaselineDataOnly(sys);

  const badDisease = releaseActivatedEvent({
    boundary: { ...releaseActivatedEvent().boundary, diseases: ["pneumonia", "fracture"] },
  });
  assert.match(await appendAndGetErrors(sys, badDisease), /病种超出验证覆盖：fracture/);

  const badPopulation = releaseActivatedEvent({
    boundary: { ...releaseActivatedEvent().boundary, populations: ["adult", "infant"] },
  });
  assert.match(await appendAndGetErrors(sys, badPopulation), /人群超出验证覆盖：infant/);

  const badVendor = releaseActivatedEvent({
    boundary: { ...releaseActivatedEvent().boundary, device_vendors: ["GE", "Philips"] },
  });
  assert.match(await appendAndGetErrors(sys, badVendor), /设备厂商超出验证覆盖：Philips/);

  const highFloor = releaseActivatedEvent({
    boundary: {
      ...releaseActivatedEvent().boundary,
      thresholds: { operating_point: 0.5, min_sensitivity: 0.9 },
    },
  });
  assert.match(await appendAndGetErrors(sys, highFloor), /人群 rare_disease 灵敏度置信下限 0\.8 低于放行阈值 0\.9/);

  const wrongPoint = releaseActivatedEvent({
    boundary: {
      ...releaseActivatedEvent().boundary,
      thresholds: { operating_point: 0.7, min_sensitivity: 0.8 },
    },
  });
  assert.match(await appendAndGetErrors(sys, wrongPoint), /工作点必须采用验证研究确定的值/);

  const notReproduced = releaseActivatedEvent({ institution_id: "hospital-x" });
  assert.match(await appendAndGetErrors(sys, notReproduced), /未覆盖启用机构 hospital-x 的复现/);
});

test("放行责任与监测：缺角色 / 缺监测方案 被拒绝；合法放行通过", async () => {
  const sys = await system();
  await seedBaselineDataOnly(sys);

  const noOfficer = releaseActivatedEvent({
    responsibility: { model_owner: "m", clinical_owner: "c", data_steward: "d" },
  });
  assert.match(await appendAndGetErrors(sys, noOfficer), /责任分工缺少 safety_officer/);

  const noMonitoring = releaseActivatedEvent({ monitoring: undefined });
  assert.match(await appendAndGetErrors(sys, noMonitoring), /缺少监测方案/);

  await sys.appendEvent(releaseActivatedEvent());
  assert.equal(sys.projections.releases.get(IDS.releaseB120).status, "active");
});

test("暂停：范围必须匹配机构+版本，已暂停不可再暂停", async () => {
  const sys = await system();
  await seedBaseline(sys);
  const suspension = {
    event_id: "evt-susp-1",
    event_type: "MODEL_SUSPENDED",
    aggregate_type: "clinical_release",
    aggregate_id: IDS.releaseB120,
    occurred_at: "2026-09-25T09:00:00+08:00",
    version: 2,
    summary: "局部暂停",
    release_id: IDS.releaseB120,
    scope: { institution_id: "hospital-b", model_version: IDS.modelV120 },
    reason: "MANUAL",
    detail: "例行复核",
    effective_at: "2026-09-25T09:00:00+08:00",
  };
  const wrongScope = { ...suspension, scope: { institution_id: "hospital-a", model_version: IDS.modelV120 } };
  assert.match(await appendAndGetErrors(sys, wrongScope), /局部暂停/);

  await sys.appendEvent(suspension);
  assert.equal(sys.projections.releases.get(IDS.releaseB120).status, "suspended");
  assert.match(
    await appendAndGetErrors(sys, { ...suspension, event_id: "evt-susp-2", version: 3 }),
    /仅可暂停处于启用状态的放行/,
  );
});

async function seedBaselineDataOnly(sys) {
  await sys.appendEvent(datasetApprovedEvent());
  await sys.appendEvent(modelTrainedEvent());
  await sys.appendEvent(validationCompletedEvent());
}
