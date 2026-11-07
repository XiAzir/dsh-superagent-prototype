# 路由纠错与任务连续性

本轮同时处理首次路由判断和误路由后的任务连续性。生产原文保留歧义，Router 使用原始目标、产物和已保存工单依据判断归属；跨线程附加提供原因与目标原始消息引用，Worker 再进行内部确认。

## 请求责任

每条人类 Trigger 保持原 ID，持久记录版本、负责人、确认、退回、转交与终态。跨新线程 attach 先投递单条试接输入，`orchestrator_request_claim` 确认后建立订阅。直接指定 Worker、明确多 Worker 协作和已确认订阅沿用即时投递。

误 attach 可退回，误 accept 创建的初始请求也可退回或通过 `orchestrator_request_transfer` 转给已有工单。转交保留原消息、历史报告和成果，解除旧工单对应的验收责任；无剩余请求的旧工单收束，旧结果退出发布资格。同一请求跨工单及重启累计最多四次自动迁移，达到上限后保留状态并要求核对上下文或澄清。

修正使用稳定操作 ID、责任 revision 和当前 Assignment 校验。停止、撤权和暂停会阻止过期操作。已完成、已人工停止的原请求保持终态；多 Worker 有效协作成员中任一明确取消，使最终状态为 cancelled，结束次序保持一致。已释放的历史成员退出聚合。

## 覆盖复核

`RequestReviewService` 对已获明确授权、被 ignore 或作为 status 处理的 Router 原消息做独立复核，识别“查进度并生成文件”等混合要求。复核引用原文中的准确行动片段，再以原 ID 重新路由。模型故障、无效输出或证据不足保存 unknown；处理中责任、授权、模式或回复证据变化会触发失效或重查。

默认 `repair`，每条原请求最多恢复两次，每小时最多调用三十次复核模型。预算和恢复次数保存在 SQLite。`observe` 仅记录，`off` 停用。状态回复按原 Trigger 与工单的稳定回执 ID 绑定，同时校验来源和会话；执行前刷新证据，推理期间证据变化会重新检查。普通状态查询也使用该预算，实际调用成本进入既有用量账本。

现有执行设置展示模式和预算，任务详情展示责任历史。任务群、Worker 详情、执行记录、会话、定向输入、R 开关、停止与接管继续保留。

## 成果与副作用

转交通过既有 Effects 队列复制最新报告已登记的产物，最多八个文件、总量 50 MiB。复制真实字节、验证 SHA，并在目标任务登记独立快照和可用路径，源快照保留。持久回执支持重启续传；目标停止、再次转交或撤权使过期交接失效。远端设备暂时离线或存在未知命令结果时排队等待。

远端命令使用“原请求 ID + 操作 request_id + 设备”保持身份。转交后的重试查询原命令，保留原 daemon 工单、目录和 payload。多请求工单通过 `source_request_id` 选择已确认请求。未知结果阻止新命令和写文件，当前负责人停止会取消继承中的运行命令，旧工单因转交收束时保留这些命令。

停止后的用户面板继续读取命令历史和输出，并可记录或更正未知结果的人工核实依据。Worker 的读取与执行仍受当前责任及授权限制。

旧版本按工单登记的相同操作返回 `legacy_operation_scope` 和原 commandId，先核对旧结果再决定后续操作。通用外部工具的重复副作用仍需其对应接口的幂等键与结果回执；本轮远端命令和登记产物已有实现。

## 读取与运维

HTTP 均位于 `/orchestrator/api/`：

| 接口 | 用途 |
| --- | --- |
| `GET tickets/:id/requests` | 分页读取原请求与责任历史 |
| `GET/PUT routing-review/config` | 覆盖复核设置 |
| `GET routing-review/history` | 复核证据、结论及恢复结果 |
| `POST triggers/:id/review` | 使用稳定 requestId 请求复核 |

模型资源包括 `ticket/<id>/requests` 和 `trigger/<id>/request`，Worker 按其任务权限读取。存量任务的责任通过原消息和既有记录兼容恢复。Runtime schema 升至 14，升级和回滚沿用[完整备份与版本配对流程](runtime-operations.md)。

责任账本当前以一条 Trigger 为粒度；混合消息通过提示和覆盖复核保留行动要求，恢复重投完整原文。每个语义子行动的独立账本留待后续实践评估。

## 验证

具体运行数据及真实模型失败明细见[2026-11-07 验收记录](routing-recovery-acceptance-20261107.md)。

`routing-recovery.spec.ts`、`request-review.spec.ts`、`request-handoff.spec.ts` 覆盖 SQLite、竞态、重启、撤权、模式变化、预算和产物字节。`routing-recovery-runtime.spec.ts` 与 `autonomy-runtime.spec.ts` 检查 Runtime 工具、HTTP、真实远端 daemon 及接线。

[v4 评测](autonomy-evaluation.md)使用生产组合提示、完整 provider trace 和重复配对；故障注入覆盖误 attach、误 accept、误 status、误 ignore。故障套件采用确定的纠错判断和实际 Node/SQLite/文件操作，报告恢复耗时、步骤、覆盖及副作用；真实模型套件测量 JSON 适配接口中的判断与文件结果。完整 DSH 会话中的识错能力和实际任务质量继续通过生产证据观察。
