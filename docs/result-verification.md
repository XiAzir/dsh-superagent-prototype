# 独立成果验收

成果验收把原始交办、后续明确修正、当前 Worker 报告与宿主读取的证据放进一次独立评估。评估使用配置的模型路由，创建独立、无工具的一次性上下文。记录通过现有 SQLite KV 和 Effects 持久化，任务继续使用原有 Engine、授权、Worker 与 Outbox。

## 启用与任务方式

在“设置 → 执行 → 成果验收与修正”选择默认方式，或使用 `GET/PUT /orchestrator/api/verification/config`：

```json
{ "mode": "observe", "maxRepairs": 2 }
```

| 方式 | 新接单任务的行为 |
| --- | --- |
| off | 使用现有交付流程 |
| observe（默认） | ready 后独立检查并保存历史；原有任务完成与交付流程继续运行，观察结果按需读取 |
| enforce | ready 进入待验收；当前结果验收通过后才允许完成和最终交付 |

默认方式由新工单接单时捕获。配置修改用于之后接单的任务；进行中的工单保留已捕获的方式，旧工单沿原有生命周期运行。观察验收保存独立意见，无额外 Router 唤醒与自动修正消息。

## 有来源与修订的成功条件

新工单自动建立 `revision: 1` 的成功条件，引用原始 `trigger/<id>`。后续到达该工单、通过当前显式授权的人工补充或修正，会追加带来源的条件并增加修订号。观察讨论保留其推断权限。

Owner 可通过 `PUT /orchestrator/api/tickets/:id/acceptance` 整理逐项条件：

```json
{
  "expectedRevision": 1,
  "criteria": [{
    "id": "report-json",
    "description": "生成可解析的 JSON，包含用户要求的汇总字段。",
    "kind": "artifact",
    "sourceRefs": ["trigger/原始人工消息ID"]
  }]
}
```

`kind` 支持 `content`、`code`、`artifact`、`source`、`external`。每次保存使用 CAS，要求工单仍在进行中、修订号匹配、条件 ID 唯一，并且引用来自该工单实际接收的人工交办。每份条件最多 30 项。条件修订清除先前的当前验收结论。

## 当前结果与并发保护

`completionKey` 由工单、成功条件修订与内容、当前 Assignment、完整 ready 报告以及相关输入修订共同计算。ready 报告记录生成时的输入修订。新任务资料、记忆更正、远端执行结果等输入到达后，需要 Worker 消化并提交新结果；状态查询和纯上下文订阅沿其专用语义处理。

每次独立检查另有递增的验收代次。相同 ready 报告正在检查时，重复重验请求复用在途检查；已完成检查后的新请求可创建下一代。相同 `requestId` 返回持久回执。评估前和落库时都核对当前报告、输入、代次以及人工停止状态。过期记录保留 `superseded` 供回溯，当前结果由持有最新代次的检查更新。

强制验收的结果消息保存完成标识。Outbox 在发送前重新核对当前通过结论与完成标识，失效的待发结果以 `deliveryRevoked` 收束。专项回归覆盖新输入、替换报告、并发重验及旧执行结果晚到的竞态；最终构建和全量结论记录在[实施与验收表](autonomy-implementation-plan.md)。

## 真实证据与覆盖范围

宿主收集以下资料，并把覆盖情况写进每条证据的 `coverage`：

- 原始交办与后续人工修正：最多 20 条消息，每条最多 16,000 字符，作为成功条件的来源。
- 注册交付物：ArtifactRegistry 校验所属工单、快照完整性、文件大小和 SHA-256，再实际读取文件字节。文本和 JSON 最多读取 24,000 字节；完整 JSON 会解析校验。空文件、损坏文件和解析错误形成明确缺陷记录。
- 执行结果：宿主读取 Session 的真实 tool call/result，持久记录 Assignment 与 turn 归属；当前验收读取当前 Assignment 的有界结果，避免复用旧执行完成事件。
- 远端命令：读取原命令 ID、实际状态、输出与 owner 确认信息，保留原始事实及其有效状态。

证据正文总预算为 80,000 字符。截断内容与二进制文件记录为 `partial`；二进制证据包含大小、摘要和文件签名，语义或视觉要求需要对应的内容检查。Worker 自述作为待核实上下文，原始消息作为要求来源。

每项条件必须恰好检查一次，证据引用必须来自本次收集范围。`passed` 项需要至少一条完整的实际交付物、执行结果或回执证据；缺少资料、覆盖不足、模型故障、无效输出和超时写入 `unknown`。宿主验证出的具体缺陷或有依据的逐项问题写入 `needs_changes`。独立调用最长 60 秒。

这些检查给出可追溯的评估意见，实际覆盖范围随资料和评估能力变化。外部服务行为、图片/文档的视觉质量及复杂代码正确性应提供对应的执行、渲染或外部回执证据。

## 修正、查看与重验

在 enforce 模式，`needs_changes` 可沿原 Worker 的输入路径投递带检查明细的修正 note，保留原有任务与授权。每个工单自动修正上限由 `maxRepairs` 指定，范围 0～3，默认 2。达到上限或出现 `unknown` 后，owner 可查看依据、补充材料，再明确重验。观察模式的意见保存在验收历史。

工单详情、任务群与 Worker 区域显示方式、当前状态、逐项依据和历史，并提供“重新验收”与资源等待后的“恢复任务”。原任务群、Worker 详情、执行记录、定向输入、R 开关与停止入口继续可用。交互细节见[验收与独立监督界面](verification-ui.md)。

接口沿用现有同源检查和 owner 工单授权：

| 接口 | 用途 |
| --- | --- |
| `GET tickets/:id/verification` | 当前条件、当前结论与独立历史 |
| `POST tickets/:id/verify` | 使用稳定 `requestId` 请求重验，返回 `reviewId` |
| `PUT tickets/:id/acceptance` | 来源约束与 CAS 下修订成功条件 |
| `POST tickets/:id/resume` | 在当前授权有效且远端未知结果已处理后恢复资源等待任务 |
| `orchestrator_read` 的 `ticket/<id>/verification` | 通过现有角色资源权限读取验收依据 |

以上 HTTP 路径均以 `/orchestrator/api/` 为前缀。一次失败后的重试沿用原 ID，完成后新的主动重验使用新 ID。

## 验证入口

`tests/verification.spec.ts` 覆盖模式、真实交付物、条件来源、故障、修正和在途重验竞态。`tests/execution-evidence.spec.ts` 覆盖 Assignment/turn 归属、旧执行结果晚到及持久投影复用。`tests/autonomy-integration.spec.ts` 通过实际 Runtime/HTTP/Outbox 检查接线，`tests/panel-verification.spec.tsx` 检查状态、依据和重试控制。

独立模型质量、实际项目交付质量与真实费用通过[自主性评估](autonomy-evaluation.md)的 provider 运行及真实任务账本继续衡量。当前统一全量验证与 v2 基线由本分支最终验收记录更新。
