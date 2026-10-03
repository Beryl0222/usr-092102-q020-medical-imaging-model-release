// HTTP 传输层：把应用服务用例暴露为 JSON API（仅依赖 node:http）。
// 所有写接口返回新追加的事件（或用例结果）；所有失败使用稳定错误码。
import { EventValidationError } from "../domain/eventStore.js";
import { releaseMonitoringStatus } from "../domain/monitoring.js";
import { evaluateReleasePackage } from "../domain/releasePackage.js";
import { responsibilityChain, tracePrediction, traceSafetyEvent } from "../domain/traceability.js";
import { ServiceError } from "../application/service.js";

export function createApp(service) {
  const routes = defineRoutes(service);

  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, events: service.store.length });
    }
    if (req.method === "GET" && url.pathname === "/integrity") {
      return send(res, 200, service.store.verifyIntegrity());
    }

    const match = matchRoute(routes, req.method, url.pathname);
    if (!match) return send(res, 404, { error: "not_found", path: url.pathname });

    let body = {};
    if (req.method !== "GET") {
      try {
        body = await readJson(req);
      } catch (err) {
        return send(res, 400, { error: "bad_json", message: err.message });
      }
    }
    try {
      const result = await match.route.handle({ body, params: match.params, query: url.searchParams, service });
      return send(res, 200, result);
    } catch (err) {
      return sendError(res, err);
    }
  };
}

function sendError(res, err) {
  if (err instanceof ServiceError) {
    const notFound = err.code === "NOT_FOUND" || err.code.startsWith("UNKNOWN_");
    return send(res, notFound ? 404 : 422, {
      error: err.code,
      message: err.message,
      details: err.details,
    });
  }
  if (err instanceof EventValidationError) {
    return send(res, 422, { error: "event_validation_failed", message: err.message, details: err.errors });
  }
  return send(res, 500, { error: "internal_error", message: err.message });
}

function defineRoutes(service) {
  const s = service;
  // 简单路由表：[METHOD, pattern-segments, handler]；":x" 为路径参数。
  return [
    route("POST", ["api", "data", "grants"], (b) => s.grantData(b)),
    route("POST", ["api", "data", "withdrawals"], (b) => s.withdrawData(b)),
    route("POST", ["api", "data", "deidentification"], (b) => s.verifyDeidentification(b)),
    route("POST", ["api", "data", "disputes"], (b) => s.raiseAnnotationDispute(b)),
    route("POST", ["api", "data", "disputes", "resolve"], (b) => s.resolveAnnotationDispute(b)),
    route("POST", ["api", "data", "synthetic-batches"], (b) => s.registerSyntheticBatch(b)),
    route("POST", ["api", "datasets", "versions"], (b) => s.publishDatasetVersion(b)),
    route("POST", ["api", "datasets", "approval"], (b) => s.approveDataset(b)),
    route("POST", ["api", "training", "runs"], (b) => s.startTrainingRun(b)),
    route("POST", ["api", "training", "packages"], (b) => s.registerPackage(b)),
    route("POST", ["api", "training", "complete"], (b) => s.completeTraining(b)),
    route("POST", ["api", "validations"], (b) => s.recordValidation(b)),
    route("POST", ["api", "bias-assessments"], (b) => s.assessSubgroupBias(b)),
    route("POST", ["api", "decisions", "research"], (b) => s.completeResearch(b)),
    route("POST", ["api", "decisions", "ethics"], (b) => s.grantEthics(b)),
    route("POST", ["api", "decisions", "technical"], (b) => s.acceptTechnical(b)),

    route("POST", ["api", "releases", "evaluate"], (b) =>
      s.evaluateActivation({
        package_id: b.package_id,
        institution_id: b.institution_id,
        scope: b.scope,
        policy: b.policy,
      }),
    ),
    route("POST", ["api", "releases"], (b) =>
      s.activateRelease({
        release_id: b.release_id,
        package_id: b.package_id,
        institution_id: b.institution_id,
        activated_by: b.activated_by,
        scope: b.scope,
        policy: b.policy,
      }),
    ),
    route("GET", ["api", "releases", ":id"], (_b, _p, _q, svc) => svc.model.getRelease(_p.id)),
    route("GET", ["api", "releases", ":id", "monitoring"], (_b, _p, _q, svc) => {
      const status = releaseMonitoringStatus(svc.model, _p.id);
      if (!status) throw new ServiceError("UNKNOWN_RELEASE", `放行记录 ${_p.id} 不存在`);
      return status;
    }),
    route("POST", ["api", "releases", ":id", "suspend"], (b, p) =>
      s.suspendRelease({
        release_id: p.id,
        suspended_by: b.suspended_by,
        reason: b.reason,
        reason_text: b.reason_text,
        trigger_event_ids: b.trigger_event_ids,
      }),
    ),
    route("POST", ["api", "releases", ":id", "resume"], (b, p) =>
      s.resumeRelease({
        release_id: p.id,
        resumed_by: b.resumed_by,
        reason: b.reason,
        resolved_signal_ids: b.resolved_signal_ids,
      }),
    ),
    route("POST", ["api", "releases", ":id", "rollback"], (b, p) =>
      s.rollbackRelease({
        release_id: p.id,
        rolled_back_by: b.rolled_back_by,
        reason: b.reason,
        to_package_id: Object.prototype.hasOwnProperty.call(b, "to_package_id") ? b.to_package_id : undefined,
        trigger_event_ids: b.trigger_event_ids,
      }),
    ),

    route("POST", ["api", "examinations"], (b) =>
      s.initiateExamination({
        invocation_id: b.invocation_id,
        release_id: b.release_id,
        indication: b.indication,
        population_group: b.population_group,
        device: b.device,
        policy: b.policy,
      }),
    ),
    route("POST", ["api", "examinations", ":id", "predictions"], (b, p) =>
      s.recordPrediction({
        invocation_id: p.id,
        prediction_id: b.prediction_id,
        package_sha256_at_call: b.package_sha256_at_call,
        score: b.score,
      }),
    ),
    route("POST", ["api", "examinations", ":id", "escalations"], (b, p) =>
      s.performEscalation({
        invocation_id: p.id,
        clinician_id: b.clinician_id,
        reason_kind: b.reason_kind,
        note: b.note,
      }),
    ),
    route("POST", ["api", "examinations", ":id", "overrides"], (b, p) =>
      s.recordOverride({
        invocation_id: p.id,
        prediction_id: b.prediction_id,
        clinician_id: b.clinician_id,
        clinical_rationale: b.clinical_rationale,
        final_decision: b.final_decision,
      }),
    ),

    route("POST", ["api", "monitoring", "signals"], (b) => s.raiseMonitoringSignal(b)),
    route("POST", ["api", "safety-events"], (b) => s.reportSafetyEvent(b)),

    route("GET", ["api", "packages", ":id", "release-package"], (_b, p, q, svc) =>
      evaluateReleasePackage(svc.model, {
        packageId: p.id,
        institutionId: q.get("institution_id"),
        scope: q.has("scope") ? JSON.parse(q.get("scope")) : undefined,
      }),
    ),
    route("GET", ["api", "trace", "predictions", ":id"], (_b, p, _q, svc) => {
      const trace = tracePrediction(svc.model, p.id);
      if (!trace) throw new ServiceError("NOT_FOUND", "预测不存在");
      return { trace, responsibilities: responsibilityChain(trace) };
    }),
    route("GET", ["api", "trace", "safety-events", ":id"], (_b, p, _q, svc) => {
      const trace = traceSafetyEvent(svc.model, p.id);
      if (!trace) throw new ServiceError("NOT_FOUND", "安全事件不存在");
      return { trace, responsibilities: responsibilityChain(trace) };
    }),
    route("GET", ["api", "events"], (_b, _p, q, svc) => {
      let events = svc.store.allEvents();
      if (q.has("aggregate")) events = events.filter((e) => e.aggregate_id === q.get("aggregate"));
      if (q.has("type")) events = events.filter((e) => e.event_type === q.get("type"));
      return { count: events.length, events };
    }),
  ];
}

function route(method, segments, fn) {
  return {
    method,
    segments: segments.filter((s) => s !== ""),
    handle({ body, params, query, service }) {
      return fn(body, params, query, service);
    },
  };
}

function matchRoute(routes, method, pathname) {
  const parts = pathname.split("/").filter((s) => s !== "");
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params = {};
    let okMatch = true;
    for (let i = 0; i < parts.length; i += 1) {
      const seg = r.segments[i];
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) {
        okMatch = false;
        break;
      }
    }
    if (okMatch) return { route: r, params };
  }
  return null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2_000_000) reject(new Error("请求体超过 2MB"));
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text.trim() ? JSON.parse(text) : {});
    });
    req.on("error", reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
