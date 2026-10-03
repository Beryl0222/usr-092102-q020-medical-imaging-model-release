import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { DomainError } from "./errors.js";
import { createReleaseSystem } from "./system.js";

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("请求体不是合法 JSON");
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function matchRoute(method, pathname, methodPattern, pathPattern) {
  if (method !== methodPattern) return null;
  const actual = pathname.split("/").filter(Boolean);
  const expected = pathPattern.split("/").filter(Boolean);
  if (actual.length !== expected.length) return null;
  const params = {};
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].startsWith(":")) params[expected[index].slice(1)] = decodeURIComponent(actual[index]);
    else if (expected[index] !== actual[index]) return null;
  }
  return params;
}

const ROUTES = [
  ["GET", "/health", () => ({ status: "ok" })],
  ["POST", "/events", (system, { body }) => system.appendEvent(body)],
  ["GET", "/events", (system, { query }) =>
    system.store.list({
      aggregateType: query.get("aggregate_type"),
      aggregateId: query.get("aggregate_id"),
    }),
  ],
  ["GET", "/releases", (system) => [...system.projections.releases.values()]],
  ["GET", "/releases/:id/package", (system, { params }) =>
    system.services.packages.getPackage(params.id),
  ],
  ["POST", "/releases/rollback", (system, { body }) => system.services.rollback.rollback(body)],
  ["POST", "/applicability/checks", (system, { body }) => system.services.applicability.check(body)],
  ["POST", "/predictions", (system, { body }) => system.services.predictions.record(body)],
  ["POST", "/predictions/:id/overrides", (system, { params, body }) =>
    system.services.overrides.record({ ...body, prediction_id: params.id }),
  ],
  ["GET", "/overrides/stats", (system, { query }) =>
    system.services.overrides.stats({ release_id: query.get("release_id") }),
  ],
  ["POST", "/monitoring/samples", (system, { body }) => system.services.monitoring.recordSample(body)],
  ["POST", "/monitoring/safety-events", (system, { body }) =>
    system.services.monitoring.recordSafetyEvent(body),
  ],
  ["POST", "/datasets/withdrawals", (system, { body }) => system.services.withdrawals.withdraw(body)],
  ["GET", "/impact-assessments/:id", (system, { params }) =>
    system.services.withdrawals.getAssessment(params.id),
  ],
  ["GET", "/trace/predictions/:id", (system, { params }) =>
    system.services.traceability.tracePrediction(params.id),
  ],
];

async function route(system, method, url, body) {
  for (const [methodPattern, pathPattern, handler] of ROUTES) {
    const params = matchRoute(method, url.pathname, methodPattern, pathPattern);
    if (!params) continue;
    return handler(system, { params, query: url.searchParams, body });
  }
  return undefined;
}

export async function startServer({ port = 8080, dataDir = null } = {}) {
  const system = await createReleaseSystem({ dataDir });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
      const result = await route(system, req.method, url, body);
      if (result === undefined) return send(res, 404, { error: "接口不存在" });
      return send(res, 200, result);
    } catch (error) {
      if (error instanceof DomainError) {
        return send(res, error.status, { error: error.message, details: error.details });
      }
      console.error(error);
      return send(res, 500, { error: "服务内部错误" });
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return { server, system, port: server.address().port };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = process.env.DATA_DIR ?? null;
  const started = await startServer({ port, dataDir });
  console.log(`医学影像模型放行后端已启动：http://localhost:${started.port}`);
}
