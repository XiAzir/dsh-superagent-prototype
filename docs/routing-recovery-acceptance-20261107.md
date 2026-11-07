# 路由恢复验收记录

日期：2026-11-07。worktree：`superagent-autonomy-20261107`；分支：`codex/autonomy-plan-20261107`；本轮开发基线：`de494a5db9bcb0c5b1fa77e4afdd0882dece9c0b`。本轮保存开发成果，其他分支、运行实例、私有配置保持原状。

## 实现与工程验证

[实现说明](routing-recovery.md)记录原 Trigger 责任、试接 claim、四次迁移上限、两次漏项恢复、成果字节复制、原请求远端命令身份与 schema 14。

最终稳定快照全量 **1762 passed / 31 skipped / 0 failed**，123 个测试文件通过，1 个文件跳过。`tsc --noEmit` 与 tsdown 构建通过；62,000/44,000 的原模型提示与工具字符门禁保持原值并通过。差异检查通过。

主要真实集成证据包括：

- Runtime 从 schema-13 形状的存量消息恢复执行归属，转交后重试仍取得原 commandId，实际 once.txt 只有一次写入。旧源任务结束保留运行命令，当前负责人停止取消继承命令，原 daemon 工单和 payload 保持一致。
- 存量工单已释放部分新请求时，剩余旧请求继续进入停止取消名单；只读上下文退出执行归属恢复。
- 继承 unknown 命令使接收任务进入环境等待，阻止新命令及文件写入；人工记录观察结果后恢复。
- 停止后，Worker 的命令读取权限收束，用户面板继续展示原始与继承历史、输出及人工核实入口。
- 二进制成果复制到目标任务，真实字节、SHA、目标登记和通知路径一致，源与目标快照都可读取，重复交接复用持久回执。
- 原请求批次完整纳入验收；释放请求退出旧验收证据，已释放来源重新加入条件时被拒绝。
- 完成/停止后查询状态保持终态；多 Worker 的完成和取消聚合与结束次序一致；claim 与 acknowledgement 都重新检查当前权限、暂停和观察模式。
- 覆盖复核校验准确原文、版本和来源，隔离同 thread 的其他来源及其他请求；执行前刷新回复，推理期间证据变化会重查。模式变化、模型故障、预算与次数在 SQLite 重开后保持有效。

日志：`tmp/autonomy-tests/routing-full-frozen.log`、`routing-build-frozen.log`、`routing-authority-final.log`、`routing-qq-runtime.log`。全量首次出现的 QQ 异步回执竞态已将测试改为等待持久回执，最终全量通过。

## 固定协议与恢复故障

运行：`node scripts/evaluate-autonomy.mjs --mode all --repeats 2 --prompt-profile repository --recovery`。

结果：`.artifacts/evaluation/2026-11-07T08-07-01-308Z/comparison.json`。四模式、两轮配对共 74 次 Router 决策，计分偏差为 0，32 组预期文件任务通过。该部分采用固定判断，衡量协议与执行路径。

| 注入故障 | 纠正动作 | 额外 Router 决策 | 本次恢复耗时 | 完成覆盖 |
| --- | ---: | ---: | ---: | ---: |
| 误 attach | 1 | 1 | 16.94 ms | 2/2 |
| 误 accept | 2 | 0 | 18.51 ms | 2/2 |
| 误 status | 1 | 1 | 19.16 ms | 2/2 |
| 误 ignore | 1 | 1 | 19.33 ms | 2/2 |

四场景的孤儿请求、重复副作用与非预期副作用均为 0，转交复用实际 checkpoint，数据库重启保持责任。这些耗时来自本机确定性修正与真实 Engine/SQLite/Node 操作；模型调用数为 0，额外 token 保留未知。Runtime 模型复核接线及故障隔离通过独立集成测试。

## 真实模型两轮复测

使用既有 `yunqing-gm / deepseek-v4.1-flash`，`autonomy-fixtures-v4`、repository 生产组合提示和 provider 文件任务，两次配对且轮换模式顺序。原始协议、实际 API 消息正文、原始模型响应、用量和 hash 保存于各运行的 `provider-traces.json`，凭据留在适配器中。

结果：`.artifacts/evaluation/2026-11-07T07-52-01-023Z/comparison.json`。

| 模式 | 两轮 Router 调用 | 计分偏差 | 预期文件任务通过 |
| --- | ---: | ---: | ---: |
| router-first | 26 | 2 | 7/8 |
| structured-fast-path | 12 | 0 | 8/8 |
| subscription-fast-path | 10 | 0 | 7/8 |
| single-worker | 26 | 4 | 7/8 |

共 74 次路由调用，计分器记录 6 次偏差，原始原因逐项为：

1. 第一轮 router-first 的 `summary-correction` 超时，修正要求留在待处理队列，报告标题漏项。
2. 第一轮 single-worker 的 `waiting-request` 超时，独立等待工单尚未建立。
3. 紧随其后的 `waiting-continuation` 只有 `unresolved-waiting` 引用，模型选择新建，计分器期待附加。此项与上一项缺失上下文关联。
4. 第二轮 single-worker 把“这份汇总后续会用于内部核对”判为 ignore，计分器期待 attach。该原文属于用途说明，其独立行动要求较弱，指标保留这一归类分歧。
5. 第二轮 single-worker 的 `summary-status` 超时。
6. 第二轮 router-first 的 `stop-filter` 超时，停止要求尚未执行，fixture 随后生成了该工单输出，记录 1 次非预期副作用。

另有第二轮 subscription-fast-path 的 summary **文件生成**调用超时，该项计入任务失败。共 106 次模型调用，5 次超时；已知 token 小计 440,177，5 次调用的用量未知，完整 token 总量、费用和人工采纳保持未知。重复副作用为 0，实际发布错误完成为 0；任务验收仍保留失败及缺失证据。

按用户“再试试”的要求，使用完全相同协议输入重试第 1 项一次，返回正确 attach 目标，实际用量 1228 tokens。原输入 hash 为 `f3e0c8de475e2c6d0e302231e24ca7e34a814247fd15f742f55963fdbcd5f275`，原失败和重试各自保留于 `targeted-retry.json`，主比较表继续使用首次样本。

v3 的“7/35”来自较短 JSON 提示和不同任务集，包含 6 次语义判断偏差与 1 次无用 null 字段协议错误；其中等待任务原文也有续接歧义。本轮 v4 调整任务文本、提示、trace 与重复测量，旧、新原始比例各自描述对应实验。Router-first 与 single-worker 均在执行并发分化前完成路由，两者的采样差异沿此设计解释。

当前真实模型评测使用生产提示的 JSON 适配接口。误路由后的完整识错、模型复核质量、实际项目交付时间与费用继续通过完整 DSH 会话和生产账本观察。原 Trigger 粒度责任已落地；每个语义子行动的独立分解仍留待后续评估。

## 分支与运维状态

本轮只在当前独立分支提交。原 checkout 保持 `linux`、HEAD `3d7581c4db8920bf65b55eb2cfe596f7fe6565eb`，工作区清洁。未合并、推送或部署。任务群、Worker 详情、会话、执行记录、定向输入、R 开关、停止和接管继续保留。
