# 自主性改进实施与验收

本轮追加实施见[路由纠错与任务连续性](routing-recovery.md)，结果见[本轮验收记录](routing-recovery-acceptance-20261107.md)：降低首次误判，并以原 Trigger 责任、试接确认、跨工单成果/命令继承和有界漏项复核降低误判损失。继续在独立 worktree 与当前分支验证，保留第五项界面控制；下文 v3 数据作为前轮历史记录。

日期：2026-11-07。开发分支 `codex/autonomy-plan-20261107`，基线 `3d7581c4db8920bf65b55eb2cfe596f7fe6565eb`。

用户授权：在独立 worktree 逐项完成对话中的方案，自主运行可用测试。第五项界面取舍暂缓，保留任务群、Worker 详情、会话、执行记录、定向输入、R 开关和人工接管。

工作区：`E:/VSCODE-project/SuperAgent/superagent-autonomy-20261107`。原 checkout、运行实例与私有配置保持原状；本分支提供代码、操作配方和隔离验证结果，供后续审查与部署。

## 逐项交付

| 项目 | 实际行为 | 主要证据与操作说明 |
| --- | --- | --- |
| 1. 独立语义监督 | 独立无工具模型读取原始目标、人工修正、阶段报告与实际执行证据，分别报告基础设施及语义状态。observe 保存意见；advise 提供有冷却的两次纠偏。同任务目标下，再次有依据的停滞判断、第二次建议后至少两个新工具结果、当前证据版本一致时进入可恢复暂停。等待、后台执行、人工停止、撤权、未知远端结果和模型故障均有保护。既有瞬态重试与外部 Watchdog 的限次宿主恢复继续有效。 | `supervision.ts`、`watchdog.ts`、Runtime/HTTP；`supervision.spec.ts`、`watchdog-model.spec.ts`、`autonomy-runtime.spec.ts`；[Watchdog](watchdog.md) |
| 2. 独立成果验收 | 工单捕获带人类来源及修订的成功条件。observe 保存独立意见；enforce 在当前 ready、输入与审核均匹配并通过时完成和交付。宿主读取真实产物字节、当前 Assignment/turn 的工具结果及远端回执，有界退回原 Worker 修正。审核代次、输入变化和待发结果发送前均重新核对，过期结果收束。 | `verification.ts`、`execution-evidence.ts`、core/Outbox；`verification.spec.ts`、`execution-evidence.spec.ts`、`autonomy-integration.spec.ts`；[成果验收](result-verification.md) |
| 3. QQ 主动观察 | 选定群可观察未 @ 讨论，保留原生回复链和有界窗口。来源、发送者、inferred/auto 与用户规则共同授权后台任务，并可关联原任务。候选、输入字符、启动预留、并发、时间、调用、token 与已知费用持久记账，超额暂停保留上下文。失败模型尝试和未知用量留有记录。 | `qq-source.ts`、`qq-threads.ts`、`qq-observation.ts`、Runtime；`qq-source.spec.ts`、`qq-observation.spec.ts`、集成回归；[观察与直通](qq-observation-routing.md) |
| 4. 确定性直通 | 明确工单 ID 的状态、停止、原文及图片补充通过结构化端口直达，复用现有授权和幂等记录。状态读取保留已结束任务状态；停止收束未读的定向输入。普通自然语言继续由 Router 判断。 | `WebTasks.action`、`web/tasks/:id/actions`；`web-tasks.spec.ts`、`autonomy-integration.spec.ts`；[观察与直通](qq-observation-routing.md) |
| 5. 原控制界面保留 | 原任务群、Worker 详情、完整会话、执行记录、定向输入、R 开关、停止与接管继续可用。验收依据、监督记录、环境及命令状态加在现有详情和执行设置中，局部接口失败保留任务正文及原操作。 | `verification.tsx`、`remote-environments.tsx`、原工作区组件；新旧面板及协作测试；[界面入口](verification-ui.md) |
| 6. 可靠长期记忆 | 中文检索、相关性/范围/时效排序、实际来源引文核验、有效期、候选/替代、版本与 CAS。更正通过持久回执通知实际使用中的任务。当前通过的验收结果可独立提炼为待确认经验候选，提取失败有次数限制和重启恢复。 | `memory*.ts`、Runtime；`memory-reliability.spec.ts`、`memory-experience.spec.ts`、真实 SQLite/进程重启与固定召回集；[可靠记忆](memory.md) |
| 7. 运行保障与跨设备 | 运行身份记录实际代码及 prompts/skills/locale/patch 指纹、配置摘要、协议与 schema 13；preflight 只读检查并导出 SQLite。真实 HTTP daemon 执行任务命令与文件操作，持久命令 ID/payload hash，支持断线、重连、离线取消、结果 unknown 的人工核实及字节/SHA 校验。绑定任务及其深层子代理使用远端执行工具；终结统一取消远端命令，撤权暂停保留 Mandate。 | `runtime-manifest.ts`、`src/remote/`、CLI、Runtime/API/UI；`runtime-manifest.spec.ts`、`remote-environments.spec.ts`、集成测试及 12 层子代理 guard；[运行保障](runtime-operations.md)、[远端环境](remote-environments.md) |
| 8. 真实评估账本 | 真实 Engine/SQLite、文件及子进程任务覆盖路由、补充、更正、停止、等待、故障重启、checkpoint 与副作用。四模式持久保存版本、模型、配置、延迟、路由、交付及恢复证据。运行时接入实际用量、验收和 owner 采纳/质量反馈，缺少计数保留未知。v3 公开任务合同，评分接受等价数字空白格式；复现先执行再供模型组织产物。 | `src/evaluation/`、`evaluate-autonomy.mjs`；`autonomy-evaluation.spec.ts`、运行时/界面回归；[评估说明](autonomy-evaluation.md) |

## 关键竞态与恢复验收

- 同报告并发重验合并，旧审核代次、旧输入、旧 Assignment 的迟到工具结果和 ready 报告均有拒用回归。
- 实际 Outbox 先排队，再替换报告、追加人类要求或人工停止，旧完成消息以 `deliveryRevoked` 收束。
- 真实 daemon 的运行命令与容量排队命令，分别通过人工停止和 PR 合并收束；检查实际取消状态、空执行槽及排队副作用文件缺失。
- unknown 远端结果下通用 resume 被拒；owner 提供当前依据并核实后恢复原工单。监督同步 guard 也覆盖 unknown 已落库、异步环境暂停尚未处理的窗口。
- 来源插件尚未加载时保持恢复派工 pending；晚注册后启动并只重投未读输入一次。撤权暂停和恢复全过程精确比较原 Mandate。
- 远端绑定任务的 12 层子代理逐层检查本机 shell/文件 guard；父链缺失或循环时拒绝执行。
- 监督暂停通过实际 Runtime/HTTP 完成两次 note、第三次有新证据的 hold，以及 owner resume。

## 验证记录

原仓库基线实际测试：1558 项通过、31 项跳过，另有 1 项类 JSDoc 门禁失败；本分支已补齐类文档。阶段测试与历史 v1/v2 结果保留，最终结果以本节记录的构建及任务集为准。

本次进程使用工作区临时目录，并通过 Vitest threads 运行真实 SQLite、本地网络和子进程：

```powershell
$env:TEMP='E:/VSCODE-project/SuperAgent/superagent-autonomy-20261107/tmp/autonomy-tests'
$env:TMP=$env:TEMP
node node_modules/vitest/vitest.mjs run --pool=threads --maxWorkers=4 --reporter=dot
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/tsdown/dist/run.mjs
node scripts/evaluate-autonomy.mjs --mode all
```

2026-11-07 02:45:52 开始的最终全量：118 个文件、1700 项通过，1 个文件/31 项按环境跳过，零失败；耗时 79.73 秒。日志为 `tmp/autonomy-tests/final-all-tests.log`。此前评估器的公平性问题和真实重连的中间态断言均已修正并随全量复验。

v3 固定基线：`.artifacts/evaluation/2026-11-06T18-39-13-783Z/comparison.json`。四模式均 4 个任务通过、零失败、零错误路由、零重复/非预期副作用。Router 决策数如下：

| 模式 | Router 决策 | 任务通过 |
| --- | ---: | ---: |
| router-first | 12 | 4/4 |
| structured-fast-path | 6 | 4/4 |
| subscription-fast-path | 5 | 4/4 |
| single-worker | 12 | 4/4 |

固定基线使用 fixture oracle 与确定性执行程序；记录的是这组协议与本机文件任务的测量值。真实模型采用现有 `yunqing-gm / deepseek-v4.1-flash` 配置，在隔离进程中通过 JSON 适配器完成路由与文件组织。适配器的提示、输出上限及摘要保存于 `.artifacts/model-evaluation-adapter-config.json`，凭据在进程内解析。v2 的原失败样本保留于 `.artifacts/evaluation/2026-11-06T18-31-31-463Z/`，v3 按新任务合同独立记录。

CLI 冒烟使用隔离复制的测试数据库：preflight 的 `quick_check=ok`、schema 13、ready 与 SQLite 导出通过，导出 307,200 字节；daemon 的 `--check --backup` 返回 database=ok。两个 CLI 退出码均为 0，最终日志位于 `tmp/autonomy-tests/preflight-final.json` 和 `daemon-final.json`。完整构建与测试日志保存在同目录。

## 继续观察的实际条件

- 验收当前实际读取文本/JSON 和工具/回执证据；图片、复杂文档、外部服务及复杂代码需要相应的渲染、执行或回执资料，覆盖不足显示 unknown。
- QQ 先选群和发送者，再用书面规则及 observe 记录校准，启用 auto 后才开展推断任务；默认 copy/visual 规则仍要求明确交办。
- 跨设备协议以真实本地 HTTP、独立进程、断线/重启及文件字节测试验证。实际端侧部署、真实网络和设备权限按专用账户配方验收。
- 记忆召回集模拟跨会话和时效变化；跨月真实表现、错误完成率、采纳率及注意力收益由持续账本记录。
- 真实模型实验使用专用 JSON 适配器及固定小任务。生产 Router/Worker 提示词、完整项目编程任务和实际群流量需要后续对应负载；实际费用与人工采纳缺少来源时为 null。
- UI 验证包含 DOM、API 失败恢复与现有布局行为回归；本轮保持用户运行实例原状。

## 最终验收结果

真实模型 v3 结果：`.artifacts/evaluation/2026-11-06T18-39-12-234Z/comparison.json`。每种模式单次运行，使用相同模型、独立数据库和相同原始事件；模型采样与本机负载影响本次耗时及判断。

| 模式 | Router 调用 | 路由偏差 | 通过的文件任务 / 预期任务 | 失败记录 |
| --- | ---: | ---: | ---: | ---: |
| router-first | 12 | 4 | 2/4 | 8 |
| structured-fast-path | 6 | 2 | 2/4 | 6 |
| subscription-fast-path | 5 | 1 | 3/4 | 2 |
| single-worker | 12 | 0 | 4/4 | 0 |

35 次模型路由调用中有 7 次偏差，包含一次把可选 ticketId 输出为 null 的协议错误。另有新任务误关联、后续补充被新建、等待任务被当作状态请求等判断偏差，导致部分预期任务缺席。全部实际生成的 11 组文件均通过本次独立检查；显式停止未能落实的路由样本保留在失败清单中。重复/非预期副作用检查为零。失败记录同时包含直接错误与其下游缺失结果，因此记录数与独立缺陷数分别呈现。

共记录 46 次模型调用；已知用量小计 28,406 token，1 次调用的用量随协议错误缺失，完整 token 总量为未知。46 次调用均缺实际费用，采纳反馈尚缺，相关指标保留 null。配置、构建摘要、事件、原始产物、SQLite 和失败原因均随结果保存。这组小任务提供可复核的模型基线，生产质量继续由实际负载与人工反馈评估。

最终工程验证：全量 1700 passed / 31 skipped / 0 failed；类型检查通过；tsdown 构建通过；文档、UI 与监督/HTTP 的最后专项 5 文件 44 项通过；远端专项 11 项及并发集成 34 项通过。重连测试确定性丢失第一次探测后，核对 waiting_environment→同 ID 查询→unknown，检查 start 仅一次及实际副作用恰一次。原提示词 62,000/44,000 字符门禁保持原值。

最终构建身份为 `57569f0e7e0b293911c8bb9d3938d21004d48e3cf0c94ab955eaefdea103d03e`，记录于 `.artifacts/final-build-identity.json`。评估入口 SHA-256 为 `8fa2d60a39a7c50dc1f2a39311e59bd1c962a50a8d3d3a8bbfe1812ccd4760c5`；v3 固定及真实模型产物的 buildHash 均与最终入口一致。最后差异检查通过，原仓库分支仍为 `linux`、HEAD 为上述基线且工作区清洁。本分支的提交仅保存开发成果。
