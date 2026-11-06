# 自主性评估与运行账本

评估分为固定事件回放、实际文件任务与可选模型调用。每次运行使用独立 SQLite 数据库和任务目录，保存版本、配置摘要、事件与结果证据。

当前任务集为 `autonomy-fixtures-v3`。真实模型实测发现了三处评估条件需要修正：报告中的 `[3, 5, 7]` 因空白差异被误拒；回执必需的字段尚未完整写入原始交办；文件生成模式缺少实际 JSON.parse 执行证据。v3 公开所需 schema、容许数字列表的空白变化，并由宿主先执行复现再传递真实观察。已有 v1/v2 结果保持原样，比较时按任务集版本区分。语义路由评分答案及真实产物的字段、值、错误名称与副作用检查继续保留。

## 运行固定基线

完成构建后，在当前 worktree 执行：

```powershell
node scripts/evaluate-autonomy.mjs --mode all
```

输出位于 `.artifacts/evaluation/<UTC时间>/`，包含 `comparison.json` 以及每种模式的 `result.json`、`events.json`、`state.sqlite` 和实际任务文件。脚本自行读取本仓库 Git 提交号，模型配置和实际费用缺失时保存 `null`。

可选模式：

| 模式 | 回放路径 | 执行并发 |
| --- | --- | --- |
| router-first | 人类消息经 Router 决策路径；CI 订阅沿原路径 | 2 |
| structured-fast-path | 明确状态、停止和定向补充直接操作 | 2 |
| subscription-fast-path | 后续消息走订阅，状态和停止走明确操作 | 2 |
| single-worker | Router 路径与单个执行槽 | 1 |

默认路由使用固定场景的已知答案，报告标记为 `routingPolicy: fixture-oracle`，用于验证协议接线、幂等和状态机。耗时为本机实际事件处理及子进程耗时。它提供协议回归基线；模型的语义路由效果需要下述 provider 运行。

## 实际执行的任务

事件集包含闲聊、并发交办、补充、状态查询、CI、群内观察、停止、要求更正及消息重复。

- **汇总任务**：原始交办公开 `summary.json` 的 `count`（数据总数）与 `total`（合计）字段。子进程读取真实 `input.json`，生成 JSON 与文本报告。报告内容受实际投递到该工单的补充和标题更正影响；独立检查器核对字段、值、标题和原始数字列表，允许列表中的空格/换行，继续检查准确值、顺序及元素数量。
- **停止任务**：在派工后、执行前接收人工停止，检查执行状态和副作用记录。
- **重启任务**：原始交办公开 `receipt.json` 的 `operationId: "fixture-operation"` 和 `count` 字段，成功时只记账一次。第一条真实命令持久记账后以非零状态退出，随后关闭并重新打开 SQLite，调用 Engine 的中断恢复，再读取原 checkpoint 生成回执。独立检查器核对回执和 checkpoint 中的实际记录次数。
- **复现任务**：原始消息明确使用 Node.js `JSON.parse` 并记录实际错误名称和输入。宿主先用真实 Node 子进程解析 `invalid.json`，保存 `observed-runtime.json`，其中包含解析器、Node 版本、原始输入、实际返回/抛错结果、错误名称与信息。fixture 程序或模型据此组织 `reproduction.txt`。独立子进程再读取输入和证据并实际解析核对，产物须记录宿主观察到的 `SyntaxError` 及原始输入。
- **外部等待任务**：Worker 报告外部等待与持久 `next_check`；另一条子进程产生外部文件，到期检查在原工单投递一次继续输入，然后生成结果。

ready 报告绑定独立验收记录。检查器通过后才记录完成发布；错误 provider 文件会留下 `needs_changes` 和失败证据。SHA-256、文件大小与产物路径保存在结果中。

默认执行器是这些确定性 fixture 程序，报告标记为 `executionPolicy: fixture-programs`。它检验实际执行与恢复链路。模型编程和产物质量需要注入对应执行器或启用 provider 文件生成。

## 配置真实 provider

创建一个 UTF-8 JSON 文件，正文为完整 argv 数组，例如：

```json
["C:/tools/dedicated-evaluation-adapter.exe", "--profile", "evaluation"]
```

路径指向专用评估适配器或用户准备的 CLI。配置文件保存调用参数；账号授权由该适配器自己的常规机制管理。评估器读取任务数据，通过 stdin/stdout 交换 JSON。

```powershell
node scripts/evaluate-autonomy.mjs --mode all --provider-config .artifacts/evaluation-provider.json --provider-name my-provider --model my-model --provider-tasks
```

只配置 `--provider-config` 时，模型判断路由；附加 `--provider-tasks` 后，模型同时生成任务文件。脚本创建独立进程，并仅传入系统运行所需环境变量。评估器自身无需接入生产 DSH 实例、QQ 或凭据服务。

路由请求格式：

```json
{
  "task": "route",
  "guidance": "返回路由决定",
  "context": { "trigger": {}, "tickets": [] }
}
```

返回格式：

```json
{
  "decision": { "kind": "attach", "ticketId": "当前上下文提供的真实工单ID" },
  "usage": { "tokens": 123, "cost": 0.002 }
}
```

`kind` 为 `accept`、`attach`、`ignore`、`status` 或 `stop`；accept 可给 `title`。模型接收原始消息与当前工单上下文，评分答案保留在评估器中。工单提供 `id`、`title`、`ended`、`sourceText`，并附可选 `source` 和 `threads` 原始来源事实，帮助判断关联关系；既有适配器继续兼容。

文件任务请求的 `task` 为 `execute_fixture`，`context` 提供实际收到的原始要求、输入/已有 checkpoint 的正文以及允许的输出文件名。复现任务在调用模型前，将宿主实际执行的 `observed-runtime.json` 一并放入 `existingFiles`。此模式中，宿主执行复现，模型根据观察组织交付文件。返回 `{files:[{name,content}],usage?}`。宿主只写这些预期输出文件，随后用独立真实子进程检查字节与任务要求；缺少实际错误名称、错误字段或错误数字仍记录失败。

调用超时、无效 JSON、错误路由和不合要求的文件均记录失败。用量字段缺失时保留未知；带真实计数的调用以调用 ID 去重。费用单位沿模型服务的计价规则。

## 运行账本接口

`EvaluationLedger` 复用 Store 的 KV 与事务，无需额外数据库迁移：

```ts
const ledger = new EvaluationLedger(store, { runId: 'runtime' })
ledger.record({ id: 'session-id:request-id', kind: 'usage', ticketId, data: { tokens, cost } })
ledger.record({ id: 'review-id', kind: 'verification', ticketId, data: { state: 'passed' } })
const summary = ledger.summary()
```

事件类型包含 `request`、`route`、`usage`、`completion`、`verification`、`intervention`、`adoption`、`recovery` 与 `side_effect`。相同 ID 和内容重放复用原事件；同 ID 的不同内容会报冲突。事件数据用于有界标识和测量，正文与工具结果沿原存储保留。

| 指标 | 证据字段 |
| --- | --- |
| Router 决策量 | route.path=router |
| 错误路由 | route.correct，缺少判断时为 null |
| 错误完成 | completion.correct=false 且 published=true |
| 预先发现的完成缺陷 | verification.state=needs_changes |
| 重复副作用 | side_effect.count 中超出一次的实际记录 |
| 非预期副作用 | side_effect.count 中超出 expectedCount 的实际记录；停止任务的预期为零 |
| 人工介入/路由纠正 | intervention，以及 data.kind=routing-correction |
| 采纳率 | adoption.accepted 的实际用户反馈 |
| token/费用 | usage.tokens、usage.cost；缺失调用保留未知 |
| 完成延迟 | completion.durationMs，或关联 request 的时间差 |
| 响应 p50/p95 | route.durationMs |
| 恢复 p50/p95 | recovery.durationMs |

`summary.coverage` 给出有明确判定的样本数；`knownUsage` 单独列出已知小计和未知调用数。真实用户采纳、模型用量和主观质量没有来源时保持 `null`。

## 测试

`tests/autonomy-evaluation.spec.ts` 覆盖持久化与重放、真实文件和命令、重启 checkpoint、停止、外部等待、不同路由模式、错误模型路由、错误文件拦截，以及独立 CLI 的 JSON 协议。v3 增加数字列表空白/错误值/额外元素、原始 schema 可见性、来源事实、模型调用前的宿主真实观察，以及遗漏/错误的复现错误名称回归。
