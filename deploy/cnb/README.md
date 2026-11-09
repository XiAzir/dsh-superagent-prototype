# CNB 云开发持久运行接入

本目录提供 dsh-superagent 的 CNB 运行监督器、快照接收端与部署模板。每个应用使用独立目录、凭据和租约。

## 目标规格与访问

- `.cnb.yml` 的 `codex/autonomy-plan-20261107.vscode` 与 `linux.vscode` 共用部署流程，使用4核、8GB，Docker service承载所选QQ后端，离线保留18小时。当前部署及外部恢复目标为 `codex/autonomy-plan-20261107`。首次配置将Worker并发设为1；已有配置继续保留。更高内存规格需核对对应runner资源。
- 本部署的公网 Web 入口为 `https://superagent.1994622.xyz/`，使用独立 HTTPS BasicAuth 登录；用户名 `azir`，密码保存在运维仓库已忽略的 `local/secrets.md` 对应条目。云端环境恢复后会自动重建反向隧道，日常访问直接使用域名。
- Superagent web 服务监听 `127.0.0.1:13082`。客户端通过当前 CNB 工作区 SSH 目标建立隧道：

  ```sh
  ssh -N -L 13082:127.0.0.1:13082 <当前工作区SSH目标>
  ```

Windows 推荐从 PowerShell 7 运行仓库的连接助手：

```powershell
pwsh -File scripts/connect-cnb.ps1
```

它经 `ssh wuhan` 查询本项目在 Codex 或 Linux 分支创建的唯一运行中云环境，显示本机14082端口的认证链接并保持前台SSH隧道。工作区内切换 Git 分支后，CNB 的创建分支元数据仍沿用原值；连接助手兼容这段迁移期。云环境重建后重新执行即可；`-InfoOnly`显示当前SSH目标，`-VerifyOnly`验证认证链接且隐藏token。使用默认SSH known_hosts；首次连接按SSH提示核对主机。`-KnownHostsFile`可传已有CNB主机密钥文件。

- 备份接收端在固定入口反代至本机 `127.0.0.1:9012`，API 前缀为 `/superagent-runtime`。公网入口应使用 HTTPS，访问令牌通过 `Authorization: Bearer ...` 传送。
- CNB 资源回收后，下一工作区由 runtime 先获取180秒租约，再从接收端恢复快照；成功运行后每5分钟创建并上传新快照。接收端的租约与备份元数据保存在 `/var/lib/cnb-superagent/state.json`，latest 与 previous 存放两代 ZIP。

## 快照格式和限制

`archive.py` 生成 ZIP，并写入 `snapshot/manifest.json`（当前 `schema_version: 1`）。manifest记录文件路径、大小、SHA-256与权限位；校验和恢复都会检查manifest和文件内容。归档最大4 GiB，展开内容最大8 GiB，最多200,000个成员。上传由服务以1 MiB块流式写入临时文件；完整校验及租约复核通过后才轮换 `latest.zip` / `previous.zip`。每个已保存备份提供 `X-Archive-SHA256` 下载响应头，客户端按该值核对下载内容。

首次部署使用新的云端profile，保留本机现有服务。后续在云端配置的模型凭据、QQ配置、会话、定时任务数据库与工作文件均随快照保存，归档应按敏感数据管理。NapCat由监督器管理并完整保存其独立数据根；其余应用需分别规划目录。普通应用的可重建依赖与缓存按下述规则排除，依赖锁文件保留；恢复后自动重新安装profile依赖。

### 应用数据目录

CNB 应用的持久数据统一位于 `/workspace/.superagent-runtime/data`：

| 子目录 | 保存内容 |
|---|---|
| `dsh-home` | DSH profile、模型配置、会话与附件 |
| `state` | Superagent SQLite、任务、定时任务、QQ附件、默认Worker工作目录 |
| `work` | DSH默认工作目录与手工保存的工作文件 |
| `home` | 应用HOME；工具配置、XDG数据、浏览器profile等 |
| `snowluma` | SnowLuma data、QQ .config/.local/share、稳定设备身份；排除 Chromium SharedStorage/DIPS 缓存 |
| `napcat` | QQ登录数据、NapCat配置、插件、app、缓存、设备身份；完整保存依赖与缓存 |

监督器显式设置HOME/XDG相关变量，并在复用tmux会话时更新每个新pane的环境。临时文件与运行socket位于同一workspace下的`control/tmp`和`control/run`。归档服务兼容较早仅包含dsh-home/state/work的快照。

CNB设置`DSH_SUPERAGENT_DATA_ROOT`后，插件stateDir、Worker目录和定时任务cwd会检查归档覆盖范围及已有符号链接。自定义命令的输出路径也应指向上述持久目录。此开关只由CNB监督器设置，普通Windows/Linux安装保持原路径行为。

普通项目中的`cache/caches/.cache`目录会保存；可重建的`home/.cache`、`home/.local/share/pnpm`和依赖目录`node_modules/.pnpm-store`按规则排除。CONTROL中的租约和隧道凭据由部署配置恢复，应用数据与Git源码分开管理。受控停机会先停止应用、再保存末次快照；突发环境丢失以最近一次成功上传为恢复点。

## 启停与恢复

```sh
python3 deploy/cnb/runtime.py start       # 首启恢复快照，启动或恢复运行
python3 deploy/cnb/runtime.py status
python3 deploy/cnb/runtime.py stop        # 人工停机，外部恢复保持暂停
python3 deploy/cnb/runtime.py shutdown    # 环境结束时保存快照，允许外部重新拉起
```

### NapCat 生命周期

`data/napcat/deployment.json`使用私有0600配置（`enabled`与可选QQ `account`）。启用后监督器在DSH之前启动独立容器`superagent-napcat`；暂停、停机或失去租约时一并停止。QQ待扫码属于就绪状态，持续监控以容器与WebUI健康为准。无配置或disabled时保持纯Superagent运行。

NapCat的WebUI token从已持久的`napcat/config/webui.json`读取，OneBot token通过Superagent管理API保存到DSH凭据服务。容器固定镜像digest、hostname、machine-id与MAC，并校验ownership、只读产物挂载和loopback端口；Docker29停止时隐藏的endpoint MAC会在启动后再次严格验证。WebUI6099与OneBot3001仅监听宿主loopback。

迁移与验收记录：[本地NapCat迁移CNB](../../docs/cnb-napcat-migration-record.md)。切换回本机时先停止云端运行，再启动本地NapCat，以保持同账号单端运行。

### SnowLuma 生命周期

在 `data/snowluma/deployment.json` 写入 `{"enabled":true}`，并将 `data/napcat/deployment.json` 的 `enabled` 设为 `false`。监督器选择一个 QQ 后端，启动前停止另一个自有容器。两个后端同时启用时记录配置错误并等待修复。

SnowLuma 容器 `superagent-snowluma` 固定 v2.4.0 镜像 digest，使用 `unless-stopped` 重启策略。CNB `.cnb.yml` 每次启动执行 `runtime.py start`，恢复快照后启动 QQ 后端，再启动 DSH；运行期间检查容器/WebUI并重试。人工暂停、环境结束或失去租约时停止 QQ 容器；环境结束保存快照并允许下一工作区恢复。手机验证要求以 QQ 的提示为准。

三个持久卷为 `snowluma/data:/app/data`、`snowluma/.config:/app/.config`、`snowluma/.local/share:/app/.local/share`；`data/config/machine-id` 及 `identity/mac-address` 持久保存。SnowLuma 数据根参与私有快照；仅排除 QQ 主配置目录及 `Partitions/qqnt_*`、`Partitions/qq-browser-*` 中的 `SharedStorage`、`DIPS` 及对应 SQLite sidecar，这是由 Chromium 重建的浏览器缓存，长期独占锁会阻塞在线备份。QQ 登录态、账号数据库及其他缓存继续保存。归档接收端须同步新版 `archive.py`，支持 `snowluma` 根。

WebUI 5099、noVNC 6081、OneBot WS 3001 发布到宿主 `127.0.0.1`；可选 `http_enabled:true` 发布 HTTP 3000。应用默认 UID/GID1000。CNB Docker service 的 nofile 上限为65535，因此容器使用 `65535:65535`；Docker capability `CAP_SYS_PTRACE` 与 `SYS_PTRACE` 统一校验。镜像的 Node 二进制具有 `cap_sys_ptrace=ep`，显式设置 `no-new-privileges=false`，保留该文件 capability 供 UID1000 加载 QQ 组件；CNB Docker daemon 默认开启的 no-new-privileges 会屏蔽该能力。

登录入口通过临时 SSH 转发访问：

```sh
ssh -N -L 15099:127.0.0.1:5099 -L 16081:127.0.0.1:6081 <当前工作区SSH目标>
```

WebUI 为 `http://127.0.0.1:15099/`，桌面为 `http://127.0.0.1:16081/vnc.html`。VNC 密码保存在云端私有 `snowluma/data/config/vnc-password`；OneBot token 存入 SA 凭据服务。产物通过 base64 内容传输，保持 SA 私有目录权限。

首次在 QQ 窗口登录时勾选“自动登录”，再登录账号，使后续容器启动能自动恢复账号连接。该选项和登录态一同随 QQ 配置归档。

QQ 的其他 SQLite 数据库若持有独占锁，归档会为 `snowluma/.config/QQ` 内的数据库复制稳定的 main/WAL/journal 文件组，在私有副本中恢复事务、检查完整性，再生成单文件快照。复制前后核对文件身份、大小、修改时间和日志存在状态；变化时重试，源文件保持原样。其余应用数据库继续使用 SQLite 在线备份。

本次部署与验收进度见 [SnowLuma 部署记录](../../docs/cnb-snowluma-deployment-record.md)。

跨环境单实例租约为180秒。心跳每30秒续租，持续失联90秒后启动限时停机，过期owner的上传会被拒绝。每5分钟生成快照；突发回收时的恢复点以最近一次成功上传为准。活跃文件与多个数据库采取逐项一致性快照，业务动作发往外部系统的结果仍依赖业务层幂等记录。可预期的关闭及人工暂停会在应用停止后再保存一次快照。

CNB监督器还设置 `DSH_SUPERAGENT_HTTP_CLOSE=1`：当前CNB SSH转发在远端HTTP keep-alive闲置关闭后可能保留失效socket，本适配器令DSH每个HTTP socket只处理一个请求，响应显式带 `Connection: close`；WebSocket与SSE继续工作。普通本机启动默认沿用DSH原连接策略。适配器涉及固定版本DSH的内部server字段，升级DSH时需运行真实HTTP/WebSocket回归测试。

## 接收端部署模板

模板文件：

- [`archive.service`](archive.service)：systemd 接收端服务。
- [`watchdog.env.example`](watchdog.env.example)：VPS watchdog 环境变量示例。
- [`nginx-location.conf.example`](nginx-location.conf.example)：固定 HTTPS 站点中的反向代理 location。

将 `archive_server.py`、`archive.py` 安装到 `/usr/local/lib/cnb-superagent/`。创建专用 `cnb-superagent` 用户，将 `/var/lib/cnb-superagent` 作为该用户的状态目录。生成至少32字符的随机 `SUPERAGENT_ARCHIVE_TOKEN`，放入 root 所有且权限0600的 `/etc/cnb-superagent-archive.env`：

```ini
SUPERAGENT_ARCHIVE_TOKEN=<至少32字符的随机值>
SUPERAGENT_ARCHIVE_DIR=/var/lib/cnb-superagent
SUPERAGENT_ARCHIVE_PORT=9012
```

以 `install-archive.sh` 安装 `cnb-superagent-archive.service` 后，确认服务只监听 `127.0.0.1:9012`。在固定域名的HTTPS server中加入Nginx示例配置，设置`client_max_body_size 4g`并关闭request buffering，确保ZIP流式转发；大归档建议代理读写等待600秒。匿名 `GET /superagent-runtime/health` 返回HTTP 200和`{"status":"ok"}`或`{"status":"waiting"}`，供既有watchdog探测。

Watchdog 仅在连续两次健康失败后请求启动或回收该 CNB 仓库工作区；它需要一枚限定目标仓库的启停PAT，以及单独的 `account-engage:r` workspace列表PAT。列表令牌只用于列举实例，启停令牌只作用于配置的仓库。PAT正文需存于VPS的0600文件，环境模板只填写文件路径。

## 公网 Web 接入

请求链路：浏览器 HTTPS → 武汉 Nginx BasicAuth → loopback 网关 13084 → 受限反向 SSH 13083 → CNB DSH 13082。

`provision-web.py` 配置专用 SSH 账号与凭据，`web-sshd.conf` 仅允许该账号的固定反向监听。`web-nginx*.conf` 提供独立站点模板；证书与解析准备完成后，`install-web.sh` 安装网关和新版归档服务，进行 HTTP 就绪检查并保留回滚备份。网关固定服务当前部署域名。

在 CNB 私有导入中设置 `SUPERAGENT_WEB_TUNNEL_KEY_B64`、`SUPERAGENT_WEB_TUNNEL_KNOWN_HOSTS` 和 `SUPERAGENT_WEB_TUNNEL_HOST`。监督器将密钥保存在快照之外的私有 CONTROL 目录，仅用于固定目标 SSH；应用子进程环境会剥离这些变量。隧道断开会自动重连。

监督器从本地 DSH 启动日志兑换认证 cookie，再通过归档服务上报至当前租约。网关校验租约及会话归属；用户登录后访问根页面会取得 `Secure; HttpOnly; SameSite=Strict` cookie。API、WebSocket 与流式响应均经过同一登录入口，原始启动 token 留在云端。域名入口仍需云端模型配置才能执行模型任务。

部署实录：[公网入口记录](../../docs/cnb-public-web-record.md)。

## API

所有控制请求、`GET /status` 和备份读写都需要 Bearer token。路径均相对于 `/superagent-runtime`：

| 请求 | 行为 |
|---|---|
| `GET /health` | 匿名探活；活跃租约启动宽限期15分钟，之后要求最近120秒内有健康心跳。人工暂停会保持健康状态，直到新runtime恢复健康。 |
| `GET /status` | 返回健康、租约、人工暂停标记和备份摘要，不返回令牌。 |
| `POST /lease` | JSON `{"owner":"<CNB_BUILD_ID>"}` 获取180秒单实例租约。其他owner仍持有租约时返回409。 |
| `POST /heartbeat` | JSON含`owner`、布尔`healthy`、可选布尔`paused`及受限阶段元数据；匹配owner后续租180秒。 |
| `POST /release` | JSON含`owner`；人工暂停时附`"paused":true`，接收端会持久化暂停标记，后续新租约的健康心跳到达后清除。 |
| `POST /web-session` | Bearer认证，JSON含当前`owner`和DSH cookie；仅持有活跃租约的owner可更新，公共状态响应隐藏此字段。 |
| `PUT /backup` | Bearer认证，并带 `X-Superagent-Owner: <CNB_BUILD_ID>`。最多4 GiB，流式上传ZIP；owner必须仍持有有效租约。 |
| `GET /backup` | Bearer认证，流式下载 `latest.zip`；无快照时返回404，成功时提供 `X-Archive-SHA256`。 |

控制JSON最大8 KiB。服务对每个连接设置30秒socket超时，最多32个并发请求线程，并限制同时上传为1个。上传时会在校验后再次检查租约；过期owner以及旧owner无法覆盖当前latest。文件替换和下载打开共用锁，下载期间打开的文件描述符继续指向该代完整ZIP。

## 测试

从 `superagent/` 目录运行：

```sh
python -m unittest discover -s deploy/cnb -p 'test_*.py' -v
python deploy/cnb/integration-test.py
node --test deploy/cnb/test_web_gateway.mjs
```

`test_archive.py`覆盖ZIP manifest生成、路径白名单、校验、哈希错误、归档大小限制及安全恢复；`test_archive_server.py`覆盖认证、watchdog健康schema、bootstrap宽限、心跳超时、暂停/续租/释放、服务重启后的租约持久化、过期owner拒绝、并发上限、分块/半截上传、latest/previous轮换以及下载SHA-256头。
