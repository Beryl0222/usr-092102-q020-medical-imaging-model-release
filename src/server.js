// 服务入口：node src/server.js [--file data/eventlog.jsonl] [--port 8080]
// 事件日志为仅追加 JSONL；重启后重放并校验哈希链，任何篡改都会导致启动失败。
import { createServer } from "node:http";

import { createReleaseService } from "./application/service.js";
import { createApp } from "./transport/http.js";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const port = Number(argValue("--port", process.env.PORT ?? 8080));
const file = argValue("--file", process.env.EVENT_LOG ?? "data/eventlog.jsonl");
const seed = args.includes("--seed");

const service = createReleaseService({ eventFile: file });
if (seed) {
  // 仅在空库时播种一条金标准链，便于手工联调。
  const { buildGoldenChain } = await import("./scenario/fixtures.js");
  if (service.store.length === 0) {
    buildGoldenChain({ store: service.store });
    console.log(`[seed] 已播种金标准证据链（${service.store.length} 个事件）`);
  }
}

const app = createApp(service);
const server = createServer(app);
server.listen(port, () => {
  console.log(`医学影像模型放行后端已启动`);
  console.log(`  事件日志：${file}（已重放 ${service.store.length} 个事件）`);
  console.log(`  监听：http://localhost:${port}`);
  console.log(`  健康检查：GET /health  完整性：GET /integrity`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
