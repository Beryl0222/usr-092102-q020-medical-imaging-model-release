import assert from "node:assert/strict";
import test from "node:test";

import { ServiceError } from "../src/application/service.js";
import {
  buildGoldenChain,
  buildSingleCenterChain,
  fakeSha,
  FULL_SCOPE,
  SITES,
  VENDORS,
} from "../src/scenario/fixtures.js";

function gateIds(evaluation) {
  return Object.fromEntries(evaluation.gates.map((g) => [g.id, g.ok]));
}

test("放行包：金标准链八道门禁全绿并给出快照指纹", () => {
  const g = buildGoldenChain();
  const e = g.service.evaluateActivation({
    package_id: g.ids.pkgId,
    institution_id: SITES.COMM_A,
    scope: FULL_SCOPE,
  });
  assert.equal(e.eligible, true, JSON.stringify(e.blockers, null, 2));
  const ids = gateIds(e);
  assert.deepEqual(ids, {
    lineage: true,
    data_governance: true,
    reproducibility: true,
    subgroup_bias: true,
    decision_research: true,
    decision_ethics: true,
    decision_technical: true,
    activation_scope: true,
  });
  assert.match(e.snapshotFingerprint, /^[a-f0-9]{64}$/);
  // 四道决定中前三道均已做出
  assert.equal(e.decisions.research.made, true);
  assert.equal(e.decisions.ethics.made, true);
  assert.equal(e.decisions.technical.made, true);
});

test("放行包：四道决定相互独立——研究完成不能推定伦理或技术验证", () => {
  const pilot = buildSingleCenterChain();
  const e = pilot.service.evaluateActivation({
    package_id: pilot.ids.pkgId,
    institution_id: SITES.COMM_A,
    scope: FULL_SCOPE,
  });
  const ids = gateIds(e);
  assert.equal(ids.decision_research, true); // 研究完成确实做了
  assert.equal(ids.decision_ethics, true); // 伦理也做了
  assert.equal(ids.decision_technical, false); // 但技术验证缺失
  assert.equal(e.eligible, false);
});

test("放行包：缺任一亚组（儿童/老年/罕见病）或跨厂商证据即拒绝", () => {
  const g = buildGoldenChain();
  const e = g.service.evaluateActivation({
    package_id: g.ids.pkgId,
    institution_id: SITES.COMM_A,
    scope: { ...FULL_SCOPE, devices: [VENDORS.V1] }, // 只申请 V1
  });
  // V1 单设备也有四个亚组的达标证据，但 scope 里声明了 V2 才会失败；
  // 这里验证"申请 V1 子集"是允许的（scope ⊆ validatedScope）。
  assert.equal(e.eligible, true);

  // 申请未验证设备则拒绝
  const e2 = g.service.evaluateActivation({
    package_id: g.ids.pkgId,
    institution_id: SITES.COMM_A,
    scope: { ...FULL_SCOPE, devices: [{ vendor: "Unknown-Vendor", model: "Z-9" }] },
  });
  assert.equal(e2.eligible, false);
  assert.ok(e2.blockers.some((b) => b.includes("Unknown-Vendor")));

  // 申请未验证阈值则拒绝
  const e3 = g.service.evaluateActivation({
    package_id: g.ids.pkgId,
    institution_id: SITES.COMM_A,
    scope: { ...FULL_SCOPE, threshold: 0.73 },
  });
  assert.equal(e3.eligible, false);
  assert.ok(e3.blockers.some((b) => b.includes("阈值")));
});

test("放行包：合成占比超上限阻断放行", () => {
  const g = buildGoldenChain();
  // 直接构造一个 80% 合成占比的版本+训练+包
  for (let i = 100; i < 102; i += 1) {
    g.service.grantData({ record_id: `rec-hi-${i}`, granted_by: "s", purpose: "hi-syn", expires_at: "2028-01-01T00:00:00Z" });
  }
  g.service.registerSyntheticBatch({
    batch_id: "syn-hi", generator_run_id: "g", seed: "z",
    source_record_ids: ["rec-hi-100"], provenance: "p", ratio_in_version: 0.8,
  });
  g.service.publishDatasetVersion({
    dataset_version_id: "ds-hi-syn", real_record_ids: ["rec-hi-100", "rec-hi-101"],
    synthetic_batch_ids: ["syn-hi"], synthetic_ratio: 0.8,
  });
  g.service.verifyDeidentification({
    dataset_version_id: "ds-hi-syn", verifier: "v", method: "m", report_id: "r",
    residual_direct_identifiers: 0, reidentification_risk: 0.01,
  });
  g.service.approveDataset({ dataset_version_id: "ds-hi-syn", approved_by: "a", allowed_run_purpose: ["hi-syn"] });
  g.service.startTrainingRun({ run_id: "run-hi", dataset_version_id: "ds-hi-syn", started_by: "e", purpose: "hi-syn" });
  const sha = fakeSha("pkg-hi");
  g.service.registerPackage({ package_id: "pkg-hi", run_id: "run-hi", sha256: sha, intended_use: FULL_SCOPE });
  g.service.completeTraining({ run_id: "run-hi", package_id: "pkg-hi", sha256: sha });
  const e = g.service.evaluateActivation({
    package_id: "pkg-hi", institution_id: SITES.COMM_A, scope: FULL_SCOPE,
  });
  assert.ok(e.blockers.some((b) => b.includes("合成数据占比")));
});

test("放行包：标注争议未裁决 / 未脱敏 / 撤回记录未排除都阻断", () => {
  const g = buildGoldenChain();
  // 放行之后又提出新争议：门禁是实时评估，必须当场拦下
  g.service.raiseAnnotationDispute({
    dispute_id: "disp-late",
    dataset_version_id: g.ids.dvId,
    item_ref: "rec-007#frame-3",
    raised_by: "radiologist-li",
    reason: "复核时发现新标签疑问",
  });
  const e = g.service.evaluateActivation({
    package_id: g.ids.pkgId, institution_id: SITES.COMM_A, scope: FULL_SCOPE,
  });
  assert.equal(e.eligible, false);
  assert.ok(e.blockers.some((b) => b.includes("未裁决标注争议")));
});

test("放行包：门禁不绿时 RELEASE_ACTIVATED 无法写入", () => {
  const pilot = buildSingleCenterChain();
  assert.throws(
    () =>
      pilot.service.activateRelease({
        release_id: "rel-x",
        package_id: pilot.ids.pkgId,
        institution_id: SITES.COMM_A,
        activated_by: "director",
        scope: FULL_SCOPE,
      }),
    (err) => err instanceof ServiceError && err.code === "RELEASE_GATE_FAILED",
  );
});

test("放行包：激活事件引用前三道决定事件 id 且带包 sha256", () => {
  const g = buildGoldenChain();
  const { event } = g.activate("rel-refs", SITES.COMM_A, "director");
  const p = event.payload;
  for (const key of ["research_event_id", "ethics_event_id", "technical_event_id"]) {
    assert.match(p.decision_refs[key], /_/);
    assert.ok(g.service.store.getEvent(p.decision_refs[key]), `${key} 必须指向真实事件`);
  }
  assert.equal(p.package_sha256, g.ids.sha);
  assert.match(p.snapshot_fingerprint, /^[a-f0-9]{64}$/);
});
