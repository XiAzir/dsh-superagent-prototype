# 可靠长期记忆

共享记忆沿用 `orchestrator.sqlite` 的 KV、版本和 CAS。此模块新增查询索引、使用记录、更正回执及经验提取队列，数据库 schema 保持现有版本。

## 来源、依据与状态

旧 `sources: string[]` 持续可读。可识别的 `trigger:<id>`、`trigger/<id>`、`ticket:<id>`、`document:<id>` 和 HTTP(S) URL 会解析为结构化引用；其他旧字符串保留 `legacy` 标记。旧事实保留原有状态，其依据显示为 `legacy`。

新写入可以使用以下结构：

```json
{
  "topic": "meeting-timezone",
  "title": "会议时区",
  "summary": "会议使用上海时区。",
  "content": "安排会议时使用 Asia/Shanghai，并在跨时区邀约中标明。",
  "expected_revision": 0,
  "evidence": "user",
  "sources": [{
    "kind": "trigger",
    "ref": "original-message-id",
    "quote": "会议使用上海时区。"
  }],
  "scopes": ["project:calendar"],
  "importance": 75
}
```

`kind` 支持 `trigger`、`ticket`、`document`、`url`；`locator` 可以指出报告、段落或页码。`quote` 保存与事实有关的原始短引文，`observedAt` 可记录来源时间。主机通过 `resolveSource` 检查资源可访问性、原始引文和适用授权。URL 来源解析只接受无内嵌账号密码的 HTTP(S) URL，模块自身直接读取 KV，外部来源的验证沿宿主现有资源读取能力进行。

`evidence` 区分 `user`（明确用户陈述）、`verified`（任务中验证的事实）、`inferred`（推断或提炼）、`legacy`（旧依据）。`confidence` 由模块计算：

- `user/verified` 至少有一个已解析且带原始引文的来源时为 `supported`。
- 来源或引文待核验时为 `unresolved`，默认进入 `candidate`。
- `inferred` 为候选，后续用明确陈述或验证依据另存一版后激活。
- 旧依据保留 `legacy`，目录中明确标注。

来源解析证明了证据引用的可追溯性；事实是否被引文充分支持仍需要 Router 或独立验收结合上下文判断。资源内容作为资料，不赋予新的操作权限。

候选与未解析更正保存到独立主题，并通过 `conflicts` 指向当前事实。已有 active 事实受此约束保护。跨主题 `supersedes` 需要当前、有效的已解析依据和 active 状态。

## 面向当前工单的召回

原有工具名称保持一致。Router 在查找将传给 Worker 的事实时传入任务 ID、当前问题和适用范围：

```json
{
  "query": "供应商报价 交期",
  "scopes": ["project:procurement", "source:qq"],
  "ticketId": "ticket-123",
  "includeExpired": false
}
```

随后按返回主题读取正文，并把 `topic/revision` 引用保留在派工 note 内：

```json
{
  "topic": "vendor-quote-process",
  "ticketId": "ticket-123",
  "scopes": ["project:procurement", "source:qq"]
}
```

范围支持 `global`、`project:<id>`、`source:<id>`、`ticket:<id>`。global 适用于各范围；其他范围按维度组合，例如 `project:a + source:qq` 同时匹配项目 a 与 QQ 来源。同一维度的多个值表示可选范围。项目、来源和工单 ID 应使用原始稳定标识。

中文检索使用 Unicode 规范化、拉丁词和中文相邻双字，不依赖外部检索服务。标题、摘要、别名和正文参与查询，支持“日程”与“冲突”分散在不同位置的匹配。英文与数字查询保留每个词，避免 `topic-64` 命中全部 `topic-*`。旧版本数据的正文索引在首个实际查询时按当前版本建立，事实与历史修订保持原状。

排序依次考虑查询匹配、范围、依据、importance 和确认时间。`index(context?)` 为可选相关目录，仍保持 3000 字符与最多 30 个主题的提示预算。目录之外的主题持续通过工具分页访问。候选、归档和过期事实可明确查询；当前自动目录只显示生效事实。

`valid_from/valid_until` 接受含时区的 ISO 日期；在读取时判断生效。指定 `null` 清除对应时间限制。`confirmed_at` 记录确认时间，未来时间会被拒绝。正文与历史查询均返回 `effective` 和 `current_revision`，帮助判断历史材料的使用方式。

## 更正与使用中的任务

保存新版本继续使用 `expected_revision`。同主题的新版本自动保存 `supersedes` 引用；跨主题显式传入 `supersedes: [{topic, revision}]`，会在同一事务中归档被替代主题并写入 `supersededBy`。引用修订过期或 CAS 失败时，整笔保存回滚。

读取或目录展示携带 `ticketId` 时，模块记录该活跃工单使用的主题版本。后续更正产生持久 `MemoryCorrection`，包含稳定 `id`、原主题、旧版本、目标引用与摘要。读取本身持续保持幂等，不产生重复更正。

Runtime 接线示例：

```ts
const memory = new Memory(store, {
  tickets: store.tickets,
  resolveSource: source => resolveOriginalResourceAndQuote(source),
  notifyCorrection: event => {
    engine.note(event.ticketId,
      `Memory ${event.kind}: ${event.topic} r${event.previousRevision}; `
      + `read ${event.reference.topic} r${event.reference.revision}. ${event.summary}`,
      event.id)
  },
})
// 复用 Runtime pass，停机时等待这个异步操作收尾。
await memory.flushCorrections()
```

回调使用 `event.id` 作为 `Engine.note` 的 `requestId`，因此进程在 note 提交后、回执保存前退出，重放仍获得同一条输入。交付前再次检查工单仍活跃及目标记忆版本仍为当前；停止或已结束的工单被跳过。连续 r2、r3 更正积压时，过期 r2 直接跳过，保留最新更正。交付失败保存错误与尝试次数，以 1 秒至 60 秒的指数退避沿原 ID 重试。Runtime pass 使用持久待发索引；有效期扫描每分钟检查活跃使用记录，历史回执保留用于审计。

`kind=conflict` 表示有待核对的冲突候选，通知正文应明确该状态；`kind=expired` 在事实有效期结束后提醒仍在使用它的活跃工单。跨主题替代会持续跟随替代链，因此新主题在首条通知投递前再次更正时，任务仍能收到最新版本。派工 note 附的记忆只提供上下文，沿用工单原 Mandate。

## 从已验收任务提取经验

`MemoryExperienceService` 在 `VerificationService.recorded(review)` 内调用 `submit(review)`（`add` 为同义入口）。只有当前独立验收为 `passed`，且报告与验收标准版本保持一致时，服务才按稳定 `reportKey` 排入 `queueExperience`，同时写入提取记录与 `memory-experience` Effects。三步共享 Store 事务。相同工单与报告的后续验收复用原请求；同一报告的重复验收运行期间，提取等待结果，新的 `passed` 可沿用原请求和原来源，新的 `unknown/needs_changes` 则跳过。服务构造时从持久待处理索引补齐缺少的 Effects，适用于 SQLite 重启恢复。

提取模型复用 `dshSupervisionModel` 的独立单次上下文：`runModel(input, signal)`，工具列表为空。输入包含原始目标、验收标准、当前验收版本与有界证据；输出为 `keep:false` 或一条包含原证据引用的长期候选。模型生成 title、summary、content 与 evidenceRefs；稳定 topic 与适用 scopes 由服务及宿主确定。范围默认使用来源，也可通过 `scopes(ticket)` 限定到项目及来源。模型响应、用量与路由保留在 `memory-extraction:*` 记录中。

`completeExperience(id, {topic, title, summary, content, scopes?, aliases?}, citedSources?)` 将输出保存为 `inferred/candidate`，并在同一事务确认提取请求。`citedSources` 仅可选用原请求已保存的来源；候选保留实际引用的证据、验收 ID 与报告版本，原请求保留完整来源。重放返回原候选版本。候选由后续明确确认或验证提升为可用事实，临时任务进度继续保留在工单中。

模型判断缺少长期价值时，`skipExperience(id, reason)` 持久结束待处理请求。任务停止、hold、报告替换、验收标准变动、后续输入更正或当前验收失去通过状态同样会跳过；这些条件在调用模型前和保存候选的事务中再次检查。执行器在验收后自然完成工单时，经验提取可以继续。服务只写记忆候选与自身记录，Worker 按原任务继续。

模型失败与输出格式错误最多尝试三次，尝试数跨 SQLite 重启保留，使用 Effects 的指数退避；达到上限后结束待处理请求并保留 `failed` 原因。每次模型调用默认 60 秒，进程退出信号保留等待恢复的 Effect；全局暂停期间提取等待。输入与输出分别限制为 100,000 与 16,000 字符，并沿用监督文本的常见凭据遮盖规则。

## 验证与评估

专项测试：

```powershell
$env:TEMP = (Resolve-Path tmp/memory-tests).Path
$env:TMP = $env:TEMP
node node_modules/vitest/vitest.mjs run tests/memory.spec.ts tests/memory-reliability.spec.ts tests/memory-experience.spec.ts --pool=threads --maxWorkers=1 --reporter=dot
```

在运行前创建 `tmp/memory-tests`。部分 Windows 沙箱会重复映射 `tmpdir()`；本次验证在正常进程权限下使用上述工作区临时目录执行。

`tests/fixtures/memory-evaluation.ts` 提供固定事实与独立预期：同名 Atlas 项目的范围区分、跨 QQ/邮件来源、分散中文词语、仅正文出现的报价规则、跨月失效约定。`tests/memory-reliability.spec.ts` 在真实 SQLite 关闭并重开后执行这些用例，并覆盖失效来源、候选保护、跨主题替代及多个版本更正。

`tests/fixtures/memory-restart-child.ts` 使用真实 Node 进程：先保存使用记录与更正，再在 `Engine.note` 提交后强制退出；下一进程重放待确认事件，最终工单中只有一条更正输入。这验证持久输入与记忆回执之间的崩溃窗口。

`tests/memory-experience.spec.ts` 使用真实 SQLite 关闭并重开，覆盖经验 Effect 恢复、补队列、同报告重复验收、候选来源与范围、无长期价值的静默跳过、跨重启三次失败止损、暂停、自然完成，以及调用前和调用中的停止/更正/验收替换保护。

这些固定用例提供召回正确性与恢复的基线；长期模型使用还需统计真实任务中的遗漏、过期事实使用、更正传播、人工纠正与有效结果费用。
