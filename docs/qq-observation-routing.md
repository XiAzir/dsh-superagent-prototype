# QQ 讨论观察与明确操作直通

默认 QQ 配置继续接收交办与已知任务回复。指定群可以在 **设置 → 来源 → QQ → 接收范围** 选择“观察群内讨论”。观察仅接收原允许名单内的发送者，群策略的行 ID 为原始群号。

## 启用顺序

1. 选定群并将该群的 `listen` 保存为 `observe`。
2. 在评估策略中保持 `observe` 模式，用明确的自然语言规则判断哪些背景问题值得处理。
3. 查看候选判断、静默丢弃和预算记录，确认误触发与成本后，切换既有 `auto` 模式。

`observe` 模式记录判断；`auto` 模式才允许按有效规则开展推断任务。明确交办继续沿既有授权规则处理。群内无人提及机器人的讨论带 `meta.observation`，后续引用观察消息保留推断依据。

群策略中“已列入名单且未提及”使用 `inferred`。默认 copy/visual 规则要求明确交办；希望后台复现缺陷时，应增加覆盖该行为的书面规则，例如：

> 对已选观察群内、获准发送者讨论的具体 JSON 解析崩溃，在独立任务目录用原始输入复现并保存实际错误与最小复现步骤。目标和输入明确时可后台执行；有复现证据再回报，证据不足时静默记录。修复范围沿另行明确的授权要求。

该规则与群、发送者、模式及运行预算共同决定准入。更改规则后，先在 `observe` 记录中核对具体候选，再启用 `auto`。

原生回复链优先保留同一 Thread。无回复链讨论按机器人、群号与有界时间窗口组织。默认窗口 5 分钟；相同窗口的候选由现有 Thread/Eval 队列合并处理。Router 可以把与现有工单有关的上下文关联过去，避免重复派工；普通任务和原始讨论仍可按引用展开。

## 持久预算

QQ 来源配置的 `observation` 支持以下字段：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| windowMinutes | 5 | 无回复链的观察窗口 |
| maxCandidatesPerHour | 30 | 每群每 UTC 小时最多候选 |
| maxInputCharsPerHour | 60000 | 每群每小时实际提交的文本字符预算 |
| maxActiveTasks | 1 | 每群同时执行的观察任务 |
| maxTaskMinutes | 30 | 一次观察任务 Assignment 的运行时间上限 |
| maxModelCallsPerDay | 200 | 每群每日已记录的模型调用预算 |
| maxTokensPerDay | 200000 | 每群每日已记录的 token 预算 |
| maxCostPerDay | 按需设置 | 模型服务计价单位下的每日已知费用上限 |

小时、日和时间预算按宿主时钟核算，独立于来源消息时间。候选输入在模型评估前预留；重复事件复用原结果。超额事件留下丢弃原因，正文继续留在原始来源。

执行器启动前检查授权、日预算与并发配额。启动预留在 SQLite 中保存 5 分钟，防止同时准备的任务争用一个配额；实际运行的 Assignment 持续计入并发。运行中的预算耗尽由宿主进入可恢复的资源等待状态，原 Mandate 与任务历史保留。明确交办的任务沿原有路径执行。

每日 token 和调用数依赖模型事件中的真实用量。缺失计数显示 `unknown`，已知计数按调用 ID 去重。批量 Router 评估调用按实际涉及的群均摊计数，Worker 调用归入原工单所在群。成本保留提供方给出的数值；币种与费率继续使用模型服务的原始定义。

观察记录包括候选、丢弃、启动、资源等待和用量，并关联原始 Trigger、工单与 Decision。可通过 `QqBridge.observations.records({groupId, offset, limit})` 分页读取，`summary(groupId)` 返回当日计数。

## 结构化 Web 工单操作

`WebTasks.action(conversationId, request)` 接收服务端 owner 的明确操作：

```json
{
  "kind": "supplement",
  "ticketId": "目标工单ID",
  "requestId": "stable_request_id",
  "text": "补充的原始要求",
  "attachmentIds": []
}
```

`kind` 为 `status`、`stop` 或 `supplement`。宿主 HTTP 路由应沿现有 owner 会话、请求头与来源权限执行验证。

- `status`：直接返回保存的状态快照；保留已结束工单的执行状态。
- `stop`：对当前对话订阅的工单执行已有人工停止语义。
- `supplement`：把原始正文和图片引用交给该对话中指定的活跃工单；Engine 检查来源、授权和 Mandate。

三类操作均以请求 ID 保持幂等，并保存来源审计事件。普通自然语言继续走既有 Router 消息入口。任务群关闭 R 后的指定成员输入继续沿已有直达路径。

## 验证入口

- `tests/qq-source.spec.ts`：真实本地 OneBot WebSocket 与 Runtime，验证观察线程、原生回复、静默记录、候选限额和停用。
- `tests/qq-observation.spec.ts`：真实 SQLite，验证启动预留、重启、调用去重、未知用量、配额重置与资源等待建议。
- `tests/web-tasks.spec.ts`：真实 Engine 与 SQLite，验证状态、停止、定向补充、跨对话隔离、重复提交和授权撤销。
- `tests/qq-threads.spec.ts`：默认路由、机器人/群隔离和回复链兼容性。
