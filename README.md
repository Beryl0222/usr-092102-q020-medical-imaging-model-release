# 医学影像模型放行后端

面向联盟的医学影像模型基层部署**可执行放行**系统。它拒绝“一份平均指标报告”式申请，
要求证据链从数据授权到启用后处置**逐层关联**，并把伦理暂缓的典型理由直接编码为硬性门禁。

- 研发医院灵敏度达标，但未证明跨厂商设备、儿童、老年人、罕见病患者仍可靠 → **不放行**
- 说不清历史数据如何撤回、合成数据占比多少、覆盖后由谁负责 → **不放行**
- 只有适用病种、人群、设备、阈值**全部满足**才允许调用
- 撤回触发**影响评估**而非删除既往研究；越界/失守按**机构 × 模型版本**局部暂停
- 回滚保留原预测；医生覆盖必须留临床理由且不得成为个人绩效惩罚

## 四道决定彼此独立

研究完成、伦理通过、技术验证、院内启用是四个不同的决定，任何一道都不能由其他道推定：

| 决定 | 事件 | 责任人示例 |
| --- | --- | --- |
| 1 研究完成 | `RESEARCH_COMPLETED` | 首席研究者（PI） |
| 2 伦理通过 | `ETHICS_APPROVAL_GRANTED` | 伦理委员会主席（附条件/有效期/非惩罚承诺） |
| 3 技术验证接受 | `TECHNICAL_VALIDATION_ACCEPTED` | 联盟技术委员会（跨院跨厂商+群体偏差+校验值） |
| 4 院内启用 | `RELEASE_ACTIVATED` | 医疗机构负责人（scope ⊆ 已验证范围） |

只有第 4 道决定写入后模型才可被调用；激活事件固化前三道决定的事件 ID 与证据快照指纹。

## 证据链（每层事件通过显式 ID 引用上一层）

```
授权授予/撤回 ─ 脱敏验证 ─ 标注争议(提出/裁决) ─ 合成批次(生成器/种子/真实来源/占比)
        └─ 数据集版本冻结 ─ DATASET_APPROVED 治理放行
              └─ 训练运行 ─ 模型包登记(sha256) ─ MODEL_TRAINED
                    └─ VALIDATION_COMPLETED（医院×厂商设备×人群亚组，含 n/灵敏度/CI）
                          └─ 群体偏差评估 ─ 研究完成 ─ 伦理通过 ─ 技术验证
                                └─ RELEASE_ACTIVATED（机构、scope、阈值、快照指纹）
                                      ├─ 发起检查(APPLICABLE / ESCALATION_REQUIRED / NOT_APPLICABLE)
                                      │    └─ 预测(调用时复核 sha256) ─ 人工升级 ─ 医生覆盖
                                      └─ 漂移/关键指标/安全事件 ─ MODEL_SUSPENDED ─ 恢复/回滚
撤回授权 ─ WITHDRAWAL_IMPACT_ASSESSED（沿同一条链反查；既往研究与历史预测保留）
```

## 关键规则（全部由测试固化）

- **放行包门禁**：血缘完整；数据授权覆盖且撤回记录已排除；脱敏零直接标识残留；标注争议清零；
  合成占比不超上限；≥2 家医院、每个必需亚组（儿童/老年人/罕见病）在每家必需厂商设备上
  灵敏度点估计与 CI 下限双达标；前三道决定齐备；请求 scope 是已验证范围的**子集**。
- **发起检查即知适用性**：`APPLICABLE` 可出分；`ESCALATION_REQUIRED` 在 scope 内但机构要求人工升级
  （罕见病默认强制），模型仅供参考；`NOT_APPLICABLE` 禁止出分并写越界留痕，同一机构同一版本
  越界累计 3 次自动局部暂停。
- **灰区强制升级**：分值与阈值距离 ≤0.05 时不改变预测，但追加人工升级义务。
- **医生覆盖**：必须填写具体临床理由（≥10 字）；责任在接诊医生；`performance_penalty_applied=false`
  为强制字段；原预测永不改写，覆盖是独立事件。
- **调用时校验值复核**：推理请求携带的包 sha256 与登记值不一致即拒绝。
- **持续监测**：输入漂移、关键指标、安全事件三类信号越界自动按 机构 × 模型版本 暂停；
  严重/危急安全事件立即暂停；其他机构同版本不受影响；可恢复或回滚（含回退纯人工）。
- **回滚保留原预测**：历史 `MODEL_PREDICTION_RECORDED` 及其 sha256 永久可追溯。
- **撤回不是删除**：追加 `DATA_AUTHORIZATION_WITHDRAWN` 后沿 真实记录/合成来源→版本→运行→包→放行
  做影响评估；`block_new_use` 时阻断再训练并对仍活跃的受影响 release 自动局部暂停；
  既往研究事件与历史预测原样保留。
- **治理追溯**：`GET /api/trace/predictions/:id` 可从单个预测回到数据、脱敏、争议、合成来源、
  训练、跨院跨设备与亚组验证、四道决定、暂停/回滚，并逐层给出责任人和事件 ID。

## 事件溯源与不可篡改

`contracts/domain.schema.json` 是**不可变事件入口**（七种信封字段、四种聚合、五个契约事件类型，
均保持原样未修改）。业务扩展通过 `src/domain/catalog.js` 的事件目录登记——这是对
`additionalProperties: true` 扩展位的兼容使用，不改写契约。

- 仅追加 JSONL 日志；每个聚合独立严格递增版本 `1,2,3…`
- 事件以 sha256 哈希链首尾相扣（`metadata.prev_event_hash`）
- 重放时校验版本连续性、prev 链与内容指纹；任何历史改写都会导致启动失败
- `GET /integrity` 随时可做整链自检

## 目录

```
contracts/domain.schema.json   不可变事件契约（未改动）
src/validator.js               原基础校验入口（兼容保留，strictContract）
src/domain/
  envelope.js                  以 schema 为入口的信封校验
  catalog.js                   扩展事件目录 + 每个 payload 的结构规则
  eventStore.js                仅追加存储、版本序列、哈希链、JSONL 重放
  readModel.js                 逐层关联投影与治理状态查询
  releasePackage.js            四道决定之外的全链路门禁与已验证范围反查
  policy.js                    调用资格/灰区/越界配额
  monitoring.js                信号汇总与失守判定
  traceability.js              异常→数据→验证→发布→处置的反向追溯与责任链
src/application/service.js     全部用例编排（唯一写入入口）
src/transport/http.js          JSON HTTP API
src/server.js                  服务入口（--file/--port/--seed）
src/scenario/fixtures.js       金标准证据链 / 单中心对照链构造器
src/demo.js                    七幕端到端叙事
tests/                         32 个 node:test 用例
```

## 本地运行

```bash
npm test          # 32 个测试：契约/存储篡改/门禁/临床/撤回/监测/HTTP
npm run demo      # 七幕叙事：暂缓→补齐放行包→启用→覆盖→暂停回滚→撤回→追溯
npm start         # HTTP 服务（默认 data/eventlog.jsonl）

# 带金标准证据链启动便于联调：
node src/server.js --file /tmp/rel.jsonl --port 8080 --seed
```

## HTTP API 摘要

| 方法 路径 | 说明 |
| --- | --- |
| `POST /api/data/grants` · `/withdrawals` · `/deidentification` | 授权 / 撤回（自动影响评估）/ 脱敏验证 |
| `POST /api/data/disputes` · `/disputes/resolve` | 标注争议提出 / 第三方裁决 |
| `POST /api/data/synthetic-batches` | 合成批次（生成器、种子、真实来源、占比） |
| `POST /api/datasets/versions` · `/approval` | 版本冻结（20% 合成等）/ 治理放行 |
| `POST /api/training/runs` · `/packages` · `/complete` | 训练运行 / 包登记(sha256) / 训练完成 |
| `POST /api/validations` · `/bias-assessments` | 院×设备×亚组研究 / 群体偏差评估 |
| `POST /api/decisions/research` · `/ethics` · `/technical` | 前三道决定 |
| `POST /api/releases/evaluate` · `POST /api/releases` | 放行包评估（只读）/ 第四道决定（门禁全绿才接受） |
| `POST /api/examinations` | 发起检查，立即得到适用性与是否必须人工升级 |
| `POST /api/examinations/:id/predictions` · `/escalations` · `/overrides` | 出分（复核 sha256）/ 升级 / 覆盖 |
| `POST /api/monitoring/signals` · `/api/safety-events` | 漂移/指标信号 / 安全报告（越界自动局部暂停） |
| `POST /api/releases/:id/suspend` · `/resume` · `/rollback` | 处置：暂停 / 恢复 / 回滚（保留原预测） |
| `GET  /api/releases/:id/monitoring` | 机构×版本实时监测态势 |
| `GET  /api/trace/predictions/:id` · `/trace/safety-events/:id` | 治理追溯 + 责任链 |
| `GET  /api/events?type=&aggregate=` · `/integrity` | 事件流审计 / 哈希链自检 |

失败返回稳定错误码：`RELEASE_GATE_FAILED`（含每条阻断项）、`OUT_OF_SCOPE`、
`CHECKSUM_MISMATCH`、`DATASET_NOT_GOVERNABLE`、`UNKNOWN_*` 等；事件结构不合法返回
`event_validation_failed` 并附字段级错误。
