# CNB 云开发持久运行接入

本目录提供 dsh-superagent 的 CNB runtime 快照接收端与部署模板。快照只覆盖 `archive.py` 定义的 `dsh-home`、`state`、`work` 数据；不接收共享的 maimai 数据。

## 目标规格与访问

- CNB 云开发工作区目标规格：2 核、4 GB 内存。规格由 CNB 工作区配置设定，本文模板不修改仓库 `.cnb.yml`。
- Superagent web 服务监听 `127.0.0.1:13082`。客户端通过当前 CNB 工作区 SSH 目标建立隧道：

  ```sh
  ssh -N -L 13082:127.0.0.1:13082 <当前工作区SSH目标>
  ```

- 备份接收端在固定入口反代至本机 `127.0.0.1:9012`，API 前缀为 `/superagent-runtime`。公网入口应使用 HTTPS，访问令牌通过 `Authorization: Bearer ...` 传送。
- CNB 资源回收后，下一工作区由 runtime 先获取180秒租约，再从接收端恢复快照；成功运行后每5分钟创建并上传新快照。接收端的租约与备份元数据保存在 `/var/lib/cnb-superagent/state.json`，latest 与 previous 存放两代 ZIP。

## 快照格式和限制

`archive.py` 生成 ZIP，并写入 `snapshot/manifest.json`（当前 `schema_version: 1`）。manifest记录文件路径、大小、SHA-256与权限位；校验和恢复都会检查manifest和文件内容。归档最大512 MiB，展开内容最大2 GiB，最多200,000个成员。上传由服务以1 MiB块流式写入临时文件；完整校验及租约复核通过后才轮换 `latest.zip` / `previous.zip`。每个已保存备份提供 `X-Archive-SHA256` 下载响应头，客户端按该值核对下载内容。

归档仅包含 dsh-superagent 的 home、state 和 work，不会迁移既有模型供应商凭据，也不会迁移或启动 QQ、NapCat 等客户端。模型配置及后续服务集成需在目标 DSH profile 中单独设置。

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

启用 `archive.service` 后，确认服务只监听 `127.0.0.1:9012`。在固定域名的 HTTPS server 中加入 Nginx 示例配置，设置 `client_max_body_size 512m` 并关闭 request buffering，确保ZIP流式转发。匿名 `GET /superagent-runtime/health` 返回 HTTP 200 和 `{"status":"ok"}` 或 `{"status":"waiting"}`，供现有 watchdog 按 `.status == "ok"` 探测。

Watchdog 仅在连续两次健康失败后请求启动或回收该 CNB 仓库工作区；它需要一枚限定目标仓库的启停PAT，以及单独的 `account-engage:r` workspace列表PAT。列表令牌只用于列举实例，启停令牌只作用于配置的仓库。PAT正文需存于VPS的0600文件，环境模板只填写文件路径。

## API

所有控制请求、`GET /status` 和备份读写都需要 Bearer token。路径均相对于 `/superagent-runtime`：

| 请求 | 行为 |
|---|---|
| `GET /health` | 匿名探活；活跃租约启动宽限期15分钟，之后要求最近120秒内有健康心跳。人工暂停会保持健康状态，直到新runtime恢复健康。 |
| `GET /status` | 返回健康、租约、人工暂停标记和备份摘要，不返回令牌。 |
| `POST /lease` | JSON `{"owner":"<CNB_BUILD_ID>"}` 获取180秒单实例租约。其他owner仍持有租约时返回409。 |
| `POST /heartbeat` | JSON含`owner`、布尔`healthy`、可选布尔`paused`及受限阶段元数据；匹配owner后续租180秒。 |
| `POST /release` | JSON含`owner`；人工暂停时附`"paused":true`，接收端会持久化暂停标记，后续新租约的健康心跳到达后清除。 |
| `PUT /backup` | Bearer认证，并带 `X-Superagent-Owner: <CNB_BUILD_ID>`。最多512 MiB，流式上传ZIP；owner必须仍持有有效租约。 |
| `GET /backup` | Bearer认证，流式下载 `latest.zip`；无快照时返回404，成功时提供 `X-Archive-SHA256`。 |

控制JSON最大8 KiB。服务对每个连接设置30秒socket超时，最多32个并发请求线程，并限制同时上传为1个。上传时会在校验后再次检查租约；过期owner以及旧owner无法覆盖当前latest。文件替换和下载打开共用锁，下载期间打开的文件描述符继续指向该代完整ZIP。

## 测试

从 `superagent/` 目录运行：

```sh
python -m unittest -v deploy.cnb.test_archive deploy.cnb.test_archive_server
```

`test_archive.py`覆盖ZIP manifest生成、路径白名单、校验、哈希错误、归档大小限制及安全恢复；`test_archive_server.py`覆盖认证、watchdog健康schema、bootstrap宽限、心跳超时、暂停/续租/释放、服务重启后的租约持久化、过期owner拒绝、并发上限、分块/半截上传、latest/previous轮换以及下载SHA-256头。
