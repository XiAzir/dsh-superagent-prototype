# CNB SnowLuma 部署记录（2026-11-06）

## 部署内容

用户授权在 `XiAzir/dsh-superagent` 的 CNB Linux 工作区部署 Docker SnowLuma，并完成 Superagent 适配。首次部署工作区为 `cnb-e0d-1k6m1ij78`；完整重建验收后当前工作区为 `cnb-v08-1k6nfnt67`，4 核、8 GiB。部署代码已推送 CNB `linux` 分支。

- 镜像：SnowLuma Docker v2.4.0，固定 `motricseven7/snowluma@sha256:9b035551e8615a20d8367601a6a61c641796d9ed870f5501830f045b68f74667`。
- 容器：`superagent-snowluma`，`unless-stopped` 重启策略；WebUI5099、noVNC6081、OneBotWS3001 均发布到宿主 `127.0.0.1`。
- 数据：`/workspace/.superagent-runtime/data/snowluma`，保存 `data`、`.config`、`.local/share` 和 `identity`。QQ 配置从原 NapCat 数据副本迁入，MAC 和 machine-id 已延续。
- 原 `superagent-napcat` 已停止，部署配置 `enabled:false`；原数据保留作回退。
- 监督器在恢复快照后选择一个 QQ 后端，启动 QQ 容器，再启动 DSH；暂停、环境结束、租约丢失时停止对应容器。`.cnb.yml` 的每次工作区启动继续调用 `runtime.py start`。

## CNB 兼容修复

CNB Docker service 的 nofile 硬上限为65535，容器使用 `65535:65535`。Docker inspect 返回 `CAP_SYS_PTRACE` 时统一按同名能力校验。

镜像的 Node 二进制带有 `cap_sys_ptrace=ep`；CNB daemon 默认开启 no-new-privileges，导致 UID1000 的组件加载失败。当前受管容器显式使用 `seccomp=unconfined`、`no-new-privileges=false` 和 `SYS_PTRACE`。隔离探针确认 Node 的有效 capability 包含 SYS_PTRACE，实际容器日志确认 `pipe connected`、`awaiting login`。用户已于本次会话明确授权将这组配置推送 CNB，用于重启自动部署。

## SA 适配

- QQ 来源统一显示 OneBot v11，保留既有授权、聊天路由及回复确认记录。
- RPC 使用数字 echo，兼容响应中的数字和字符串 echo。
- 入站文件支持 `get_group_file_url` / `get_private_file_url`；对不支持接口的响应回退 `get_file`。明确失败的 RPC 避免重复调用。
- 普通文件、图片和视频产物在校验后以 `base64://` 字节内容发送，支持独立容器的文件交付；单产物50 MiB时 Base64 约67 MiB，上传期间还会占用原始 Buffer。

## 快照与管理入口

武汉接收端 `archive.py` 已同步 SnowLuma 数据根支持，原代码备份于 `/root/.cnb-superagent/storage-backups/snowluma-20261105T163709`；后续快照修复备份于 `snowluma-cache-20261106T024648`。

QQ Chromium 的 `.config/QQ/SharedStorage`、`.config/QQ/Partitions/qqnt_*/SharedStorage` 长期持有独占 SQLite 锁。归档仅排除这组可重建浏览器缓存及其 sidecar，QQ 登录态、账号数据库和其他文件继续保存。回归覆盖持锁期间归档、登录状态文件恢复，以及其他路径同名文件的保留。

WebUI 已完成首次使用设置并保存新的随机强密码。运维凭据保存于私有数据根 `snowluma/operator-webui-access.json`；VNC 密码位于 `snowluma/data/config/vnc-password`，随私有快照保存。

本次临时登录入口：SSH 转发15099/16081，HTTP兼容代理15100；验收完成后清理。代理逐请求关闭连接，处理 CNB SSH 对闲置 HTTP keep-alive socket 的兼容问题。日常 SA 入口继续使用 `https://superagent.1994622.xyz/`。

## 验收结果

- `pnpm check`：类型检查、1466项测试、构建通过；31项测试跳过。
- Linux 部署单测110项全部通过；Windows对应检查通过，5项按平台跳过。
- 真实HTTP备份/恢复集成测试1项通过，Web网关10项通过。
- 实际容器配置与管理器预期一致，SnowLuma WebUI健康，监督器healthy；NapCat停止。
- 已上传包含 SnowLuma 数据的私有快照，manifest 覆盖 QQ 配置、三个数据卷及设备身份。
- 修复后在线归档并上传成功（HTTP200）：438,653,073字节、5433文件，其中SnowLuma2384文件；包含新WebUI运维凭据，两个Chromium SharedStorage缓存按规则排除。
- 用户完成首次登录后，SA 实际连接机器人账号 `1152578024`，来源授权仍为1人、0个群。
- 第一轮完整重建创建 `cnb-7a0-1k6nf3lg9`，证明三个数据卷、设备身份、OneBot和WebUI配置可从外部快照恢复；QQ窗口中的“自动登录”原为关闭状态。已在官方QQ窗口勾选该选项并登录保存的账号，SA随即恢复连接。
- 保存新的登录配置后，第二轮完整重建创建 `cnb-v08-1k6nfnt67`。CNB自动恢复快照、启动SnowLuma、QQ自动登录原账号、SA OneBot恢复connected，监督器healthy。该轮账号恢复全程自动完成。
- 冷启动校验标记保留；MAC、machine-id、deployment、默认及账号级OneBot、WebUI配置的6项SHA-256比较全部一致。受管容器配置与管理器预期一致。
- 验收原始记录位于新工作区 `control/snowluma-coldboot-verification.json`，本机副本位于工作区外的 `output/snowluma-cnb-20261105/coldboot-verification.json`。首次登录时勾选“自动登录”已补入部署说明。

## 回退

先执行 `runtime.py shutdown` 保存末次状态，关闭 `snowluma/deployment.json` 的 enabled，再开启原 `napcat/deployment.json` 的 enabled，并执行 `runtime.py start`。保留账号及 OneBot token，监督器按单一后端顺序恢复。
