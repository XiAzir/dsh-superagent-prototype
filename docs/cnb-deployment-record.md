# CNB 持久化部署记录（2026-11-02）

目标为 `XiAzir/dsh-superagent` 的 `linux` 分支，2 核 4 GB 云开发环境。
参考 `XiAzir/psy-maimai` 的外置快照方案与本地 ssh-server 运维材料。

## 准备中

- 新增快照、归档接收器、运行监督器；尚在验收。
- 创建仓库限定恢复 PAT：仅 repo-cnb-trigger:rw、repo-cnb-detail:r。
- 武汉 `/root/.cnb-superagent/watchdog-token` 用于本项目恢复；原文留在 ssh-server 已忽略的 `local/secrets.md`。
- 本轮未迁移 Windows 模型、QQ、邮箱凭据，未开放 DSH 公网管理入口。

## 武汉独立接收器

- 新增 `/etc/cnb-superagent-archive.env`（0600），仅本项目归档 token、数据目录和端口。
- 新增系统用户 `cnb-superagent`、数据目录 `/var/lib/cnb-superagent`、源码目录 `/usr/local/lib/cnb-superagent`。
- 独立 systemd 单元 `cnb-superagent-archive.service`，127.0.0.1:9012，MemoryMax=256M。
- 通过 `deploy/cnb/install-nginx.py` 在现有 HTTPS vhost 加入 `/superagent-runtime/`，由 bearer token 鉴权；原 vhost 在同目录带时间戳备份。
- 暂存部署包：`/root/.cnb-superagent/deploy-20261102`。本次为全新服务安装。
- 云环境恢复所需两枚 PAT 已分开存储：单仓库启动/详情与账号云环境列表只读；后者是 `/root/.cnb-superagent/watchdog-list-token`。
- 新建 CNB 密钥仓库 `XiAzir/dsh-superagent-secrets`，`runtime.json` 限定 `XiAzir/dsh-superagent`、`linux`、`vscode` 三项；归档 token 原文仅保留在该密钥仓库、远端私有 env 和本机已忽略清单。

后续实测与恢复结果在验收后补充。watchdog 定时器将在首次启动验收后启用。
