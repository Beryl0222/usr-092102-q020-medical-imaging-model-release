# 医学影像模型放行

医学影像模型放行后端：以 `contracts/domain.schema.json` 为不可变事件入口，把数据授权及撤回、脱敏验证、标注争议、数据集版本、合成来源、训练运行、模型包校验值、跨医院跨设备复现、群体偏差、用途边界和责任分工**逐层关联**成一份机器可核查的放行包，而不是一份平均指标报告。

## 架构

事件溯源 + 投影 + 操作型记录：

```
事件（契约信封）──▶ 载荷规则（rules.js）──▶ 事件存储（追加式，版本连续）──▶ 投影（注册表）
                                                        │
操作型记录（预测/覆盖/撤回/监控样本/安全事件/越界/适用性审计）◀── 业务服务 ──┘
```

- `contracts/domain.schema.json`：领域事件信封及稳定枚举（**不可变**，代码只读引用）。
- `src/schema-validator.js` / `src/validator.js`：以契约为唯一入口的信封校验。
- `src/event-store.js`：追加式事件存储；`event_id` 唯一，每聚合 `version` 从 1 连续递增；可选 JSONL 持久化与回放。
- `src/rules.js`：五类事件的放行载荷规则（见下）。
- `src/projections.js`：数据集/授权/模型/验证研究/放行注册表。
- `src/services/`：适用性、预测门禁、医生覆盖、监控、撤回影响评估、回滚、放行包、追溯。
- `src/server.js`：HTTP API（node:http，无外部依赖）。
- `examples/scenario.js`：内部一致的中文联调样例；`scripts/demo.js`：端到端演示。

## 逐层关联的放行规则

| 层 | 事件 | 关键不变量 |
| --- | --- | --- |
| 数据 | `DATASET_APPROVED` | 授权（用途/撤回条款）齐全；脱敏验证通过且残余风险 ≤ medium；标注争议 `open_disputes = 0`；合成占比 0..1，>0 必须登记生成器与来源 |
| 训练 | `MODEL_TRAINED` | 只引用已获批且授权未撤回的数据集版本；`package_checksum` 为 `sha256:<64hex>`；合成占比落在所引数据集占比区间内 |
| 验证 | `VALIDATION_COMPLETED` | 校验值与训练登记一致；复现覆盖 ≥2 机构、≥2 厂商；每个人群有灵敏度+置信下限+样本量；覆盖人群/厂商与指标、复现一致 |
| 放行 | `RELEASE_ACTIVATED` | 研究完成、伦理通过、技术验证、院内启用**四个不同决定**齐全且时序递增；技术验证引用本版本研究；用途边界 ⊆ 验证覆盖；各人群置信下限 ≥ 放行阈值；工作点采用验证值；启用机构在复现站点中；责任分工四角色齐全；监测方案齐全；血缘中无已撤回授权 |
| 暂停 | `MODEL_SUSPENDED` | 仅可暂停启用中的放行；范围必须等于该放行的机构+版本（局部暂停）；原因枚举：越界调用/阈值失守/安全事件/数据撤回影响/人工 |

回滚与再激活是同一放行聚合上的新 `RELEASE_ACTIVATED`（`activation_kind = rollback / reactivation`），回滚必须声明 `retains_predictions: true`——原预测只增不改，始终归属产生它的版本。

## 运行期行为

- **发起检查即知适用性**：`POST /applicability/checks` 按机构（+版本）核对病种、人群、设备厂商与阈值，返回是否可调用、缺失条件、以及何时必须人工升级（强制复核人群、低置信度）。
- **越界调用**：`POST /predictions` 先过适用性；越界即拒绝、留痕并按机构+版本局部暂停；命中人工升级规则而未确认升级同样拒绝。
- **医生覆盖**：`POST /predictions/:id/overrides` 必须留临床理由；记录 `performance_protected`，只提供汇总统计，按个人维度的统计请求直接被拒绝——不得成为个人绩效惩罚依据。
- **持续监控**：`POST /monitoring/samples` 检查输入漂移（PSI）与关键指标下限，`POST /monitoring/safety-events` 登记安全事件（high/critical 即暂停）；越限只暂停对应机构+版本，其他机构与其他版本不受影响。
- **数据撤回**：`POST /datasets/withdrawals` 触发影响评估——沿血缘找到受影响的数据集版本、训练运行、验证研究与启用中的放行并局部暂停；既往研究、验证与预测全部保留，仅停止后续使用（新训练、新启用会被规则拒绝）。
- **治理追溯**：`GET /trace/predictions/:id` 从一条预测追到数据授权与撤回、脱敏与标注、训练运行与校验值、验证与群体指标、放行决定、暂停与影响评估，并给出处置责任与待办。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/events` | 追加领域事件（契约信封 + 载荷规则） |
| GET | `/events?aggregate_type=&aggregate_id=` | 查询事件 |
| GET | `/releases` / `/releases/:id/package` | 放行列表 / 可执行放行包 |
| POST | `/releases/rollback` | 回滚到已暂停的旧版本（保留原预测） |
| POST | `/applicability/checks` | 发起检查时的适用性与人工升级判断 |
| POST | `/predictions` | 记录预测（适用性门禁） |
| POST | `/predictions/:id/overrides` | 医生覆盖（必须临床理由） |
| GET | `/overrides/stats` | 覆盖汇总（无个人维度） |
| POST | `/monitoring/samples` / `/monitoring/safety-events` | 监控样本 / 安全事件 |
| POST | `/datasets/withdrawals` | 授权撤回 → 影响评估 |
| GET | `/impact-assessments/:id` | 影响评估详情 |
| GET | `/trace/predictions/:id` | 全链路追溯与处置责任 |

错误统一为 `{ error, details }`，状态码 400（规则不满足）/ 404（不存在）/ 409（冲突，如版本不连续、重复撤回）。

## 本地运行

```bash
npm test          # 全部测试（node:test，无外部依赖）
npm run demo      # 端到端演示：放行 → 适用性 → 覆盖 → 漂移暂停 → 回滚 → 撤回 → 追溯
npm start         # 启动 HTTP 服务（PORT=8080，DATA_DIR 可选落盘目录）
```

`data/sample.json` 仍是最小联调样例；完整的领域链路样例见 `examples/scenario.js`。
