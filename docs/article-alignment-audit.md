# Super-agent 原文思想对照审查

审查日期：2026-11-01。范围：核心域、运行时、Source 适配器、执行器、提示词、Web 面板、服务脚本和测试。

依据：[《Super-agent 设计探索：迈向更自主的 Agent 系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)。原文以逻辑职责划分和系统机制为主，并在结语明确开源插件只实现其中部分设计。下面分别记录现有机制、此次修复和部署条件。

## 逐章对照

| 原文章节 | 设计要求 | 审查结果与处理 | 实现与验收入口 |
| --- | --- | --- | --- |
| §1、§2 | 统一面对用户，后台任务独立并发，降低人的会话管理负担 | 保留一个 Router 和每工单一个持久 Worker；QQ、Web 都从来源对话交办和交付；Worker 内部 subagent 继续由该 Worker 管理 | `src/app/runtime.ts`、`src/app/sessions.ts`、`src/executor/dsh.ts`；`tests/runtime-concurrency.spec.ts`、`tests/background.spec.ts` |
| §2.1 | Router 承接人类交互和跨任务协调，具体执行交给 Worker | 删除 Router preset 的 shell、文件系统、job 工具；继承工具只保留 skill；旧主 Session 同样受执行工具 guard 约束；保留自有评估、路由、状态及资源工具 | `cordis.patch.yml`、`src/app/sessions.ts`；`tests/bundle-patch.spec.ts`、`tests/runtime.spec.ts` |
| §2.1、§7.2 | 单常驻 Router 可以合并推理期间积压的事件 | 保留 Session inbox steering、每 Thread pending 批处理、多项 route 决定和 durable assessment effect；现有测试验证逻辑聚批和顺序；性能数值以实际负载实测为准 | `src/core/evals.ts`、`src/app/assessment.ts`、`src/app/delivery.ts`；`tests/core-engine.spec.ts`、`tests/delivery.spec.ts` |
| §2.2 | Worker 上下文隔离，可自行组织 subagent；关键结论统一回 Router | 保留每工单目录、会话和并发配额；QQ 附件获取、产物上传由来源适配器完成，Worker 登记报告和产物；后台作业和 subagent 随 Assignment 停止 | `src/app/tools/executor.ts`、`src/app/artifacts.ts`、`src/executor/background.ts`；`tests/qq-source.spec.ts`、`tests/background.spec.ts` |
| §3.1 | 确定性代码先过滤来源、身份与群范围，再做语义判断 | 保留 Source scope、策略 gate、人工显式请求及观察/自动模式；QQ 先过滤机器人、自身消息、未授权发送者和群，普通群闲聊默认过滤 | `src/core/intake.ts`、`src/core/evals.ts`、`src/policy.ts`、`src/app/qq-source.ts`；`tests/policy.spec.ts`、`tests/qq-source.spec.ts` |
| §3.2 | 归属确定的 Thread 直通订阅 Worker，新任务和跨任务消息由 Router 决定 | 保留多对多订阅、context-only 跟随、handback；修复 QQ 将窗口内所有私聊强行归为同任务的问题：默认无引用消息进入语义路由，已知引用继续直通；发送者窗口模式可显式选用 | `src/app/qq-threads.ts`、`src/app/links.ts`；`tests/qq-threads.spec.ts`、`tests/qq-source.spec.ts`、`tests/followups.spec.ts` |
| §3.3 | 对象有唯一 ID，关联引用逐跳展开，长内容 Spill | 保留 Trigger→Thread→Ticket→Assignment/Session/Report 的资源链、分页和权限；补齐附件稳定引用、近邻文件上下文、产物 ID，以及状态报告的 600 字摘要和完整报告读取入口 | `src/app/cards.ts`、`src/app/resources.ts`、`src/core/replies.ts`；`tests/cards.spec.ts`、`tests/tools.spec.ts`、`tests/core-engine.spec.ts` |
| §3.3 | 按任务需要读取真实上下文 | QQ 保留 file_id、名称、大小等字段，按引用解析 NapCat API 并获取字节；图片进入视觉工具输出；视频提供有界抽帧、时间点及采样范围；模型能力不足时返回明确状态 | `src/sources/qq-attachments.ts`、`src/sources/qq-media.ts`；`tests/qq-attachments.spec.ts`、`tests/qq-media.spec.ts`、`tests/qq-source.spec.ts` |
| §3.4 | 根据环境信号提前行动，有价值再交付 | 保留书面规则授权的 inferred admission、observe→auto 渐进启用和静默回执策略；策略可要求后台复现/起草并静默放弃。额外对外操作继续遵守原授权及各来源交付规则 | `src/core/evals.ts`、`prompts/admission.md`、`src/app/assessment.ts`；`tests/assessment.spec.ts`、`tests/policy.spec.ts` |
| §4.1 | 前台响应与后台执行解耦；用户可随时干预、停止 | 保留 Worker shell 5 秒转后台、job/subagent 完成事件、输入 steering、持久 effect 和 stop；修复进度询问必须等 Worker 作答的限制，Router 可基于只读快照立即回复 | `src/core/replies.ts`、`src/app/notices.ts`、`src/app/tools/main.ts`；`tests/followups.spec.ts`、`tests/background.spec.ts` |
| §4.2 | IM 简短低打扰，异步交付提供完整可用结果 | 普通 progress 保持内部；主动状态询问有独立去重答复；ready/attention 统一回原来源。QQ 文件、图片、视频保存交付确认；Web 对话提供授权产物下载 | `prompts/replies.md`、`prompts/personal/replies.md`、`src/app/qq-source.ts`、`src/app/web-tasks.ts`、`src/client/artifacts.tsx` |
| §5.1 | 计算生命周期与持久化状态分离 | 核心通过 Repository、Executor、Assessor 和 Outbox 端口工作，工单/输入/effect/outbox 存 SQLite，Session 由 DSH persistence 保存；重启可继续。当前部署采用本地持久化，云端共享存储与多计算节点需要单独部署适配器 | `src/core/ports.ts`、`src/app/store.ts`、`src/app/effects.ts`；`tests/store.spec.ts`、`tests/effects.spec.ts`、`tests/runtime.spec.ts` |
| §5.2 | 执行环境独立保留，Agent 按需访问 | 保留可独立选择的 stateDir、执行根目录及每任务目录，状态对象引用执行环境；当前 DshExecutor 在本机执行。跨设备 daemon、在线设备登记及远程命令传输仍属后续部署适配工作 | `src/executor/dsh.ts`、`src/app/execution-environment.ts`、`src/deployment.ts`；`tests/environment.spec.ts`、`tests/deployment.spec.ts` |
| §6 | 独立外部控制回路，同时观察基础设施和任务进展 | 新增外部进程 Watchdog、只读有界快照、独立模型 assessor 命令接口、有限状态 nudge；时间阈值只挑选审查候选；等待人和手动停止保留。恢复需显式启用，带手动停止保护、退避和次数上限 | `src/app/watchdog.ts`、`scripts/dsh-superagent-watchdog.mjs`；`tests/watchdog.spec.ts`；详见 `docs/watchdog.md` |
| §7 | 实验检验路由和并发机制 | 本次用确定性协议、状态机、独立进程及集成测试检验功能。原文的 LLM 负载性能实验可用于后续实测；此次测试结果记录功能正确性 | 全量 `pnpm test`、`pnpm typecheck`、`pnpm build` |
| §8.1 | Router 扩展与长程记忆仍有待探索 | 保留单 Router、引用链召回和可选角色模型；历史持久保存并按需读。跨月自动记忆选择、Router 分片和 Worker 网络拓扑按实际负载继续研究 | `src/app/resources.ts`、`src/app/role-models.ts`、`src/app/prompts.ts` |
| §8.2 | 产品交互独立于 Session，人可中途参与 | Web 任务、QQ 原对话与工单状态为产品入口；补齐状态问询、artifact 下载；attention、follow-up、stop 保留原始来源和授权 | `src/app/web-tasks.ts`、`src/client/personal.tsx`、`src/core/replies.ts`；`tests/web-tasks.spec.ts`、`tests/panel-artifacts.spec.tsx` |
| §8.3 | 共享与隔离范围明确，A2A 可独立探索 | 保留工单读取权限、context-only 标记、子代理继承工单工具限制、停止任务后工具封锁；本次近邻上下文限定同机器人/聊天/发送者/时间窗口，并只读一跳展开 | `src/app/resources.ts`、`src/app/qq-threads.ts`、`src/app/sessions.ts`；`tests/tools.spec.ts`、`tests/runtime.spec.ts` |
| §8.4 | 不可信事件与凭据暴露面需要系统约束 | QQ token 留在宿主适配器；附件按授权引用读取，检查大小/路径/URL/取消；产物按工单目录快照并校验 SHA-256；新增 CLI 凭据导出和改号命令防护；Watchdog 快照和模型输入脱敏 | `src/sources/qq-attachments.ts`、`src/app/artifacts.ts`、`src/infra/credential-guard.ts`；`tests/artifacts.spec.ts`、`tests/environment.spec.ts`、`tests/watchdog.spec.ts` |

## 模块提交

| 模块 | 提交 |
| --- | --- |
| QQ 源文件读取与不可变产物交付 | `52d6beb` |
| 图片视觉输入、视频抽帧、QQ 原生媒体交付 | `4fddfd9` |
| Router 主动状态询问答复 | `dc6efda` |
| QQ 多任务语义归属和近邻上下文 | `dd868a1` |
| Router 只协调的工具边界 | `43ab197` |
| 独立外部 Watchdog | `3695088` |
| Worker CLI 凭据命令防护 | `beadfc0` |
| 状态报告 Inline & Spill | `3fec005` |
| Web 产物交付与授权下载 | `e559129` |
| 提示词和工具说明保持原上下文预算 | `3795801` |
| Router/Worker 状态处理说明与语义契约一致性 | `276044b` |

本审查记录在最终文档模块提交中保存，可通过 Git 日志查阅。

## 验收范围与运行条件

最终门禁：`pnpm test -- --reporter=dot` 共 73 个测试文件通过、1 个按环境跳过；1284 项通过、24 项跳过。`pnpm typecheck` 和 `pnpm build` 通过。Windows wrapper 的 5 项专属用例实际执行；POSIX 专属用例在 Windows 跳过。测试保持原 Router/Worker 提示词字符预算。

- OneBot 测试使用真实本地 WebSocket 协议及 Runtime，验证读取实际文件字节、授权撤销、原文件变化后的快照、上传确认和重试；保持线上 QQ 对话安静。
- 图片链路验证实际 PNG 字节进入工具视觉块；视频链路使用真实 FFmpeg 音视频 fixture，验证帧数量、时间顺序、尺寸和消息字节上限。视频提供采样画面，音频转录另行执行。
- Watchdog 测试启动独立短时进程，验证取消、网络超时、模型 assessor 故障隔离、静默去重、状态恢复、nudge 冷却、有限恢复和手动停止保护。独立模型会话通过 assessor 命令接入；持续调度和自动恢复由操作者选配。
- 同一 OS 用户的 Worker 仍拥有该用户的执行权限。当前 CLI 防护降低常见凭据暴露面；强凭据隔离需要独立 OS 权限或操作级 broker。云端存储与跨设备 daemon 同样需要独立部署配置。
- 构建产物更新后，重启 DSH profile 可加载运行时代码和 preset 改动。保留已有数据库和任务状态。
- 本轮只读检查确认现有本机 DSH 处于个人模式、运行和排队工单均为 0；当前宿主仍加载旧运行时代码，重启原终端中的 profile 后生效。
