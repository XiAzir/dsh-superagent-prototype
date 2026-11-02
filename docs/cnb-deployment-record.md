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

## 首次云端验收

- 首个持久化实例 `cnb-ckn-1k6d6rnmm` 自动导入凭据、获取租约、初始化个人模式并生成首份归档。
- cgroup：CPU quota/period=200000/100000，memory limit=4294967296；整机内存当时已用约453MiB，启动高水位1100476416字节。
- 已通过 API 执行测试定时命令，Worker并发=1。任务记录及生成文件位于持久化目录，将用于回收恢复核对。
- 武汉接收器约13MB内存；HTTPS健康接口工作，未携带凭据的backup请求为401；原有麦麦/注册/兼容服务继续active。
- 已启用 `/etc/cron.d/cnb-superagent`，每5分钟执行独立wrapper `/usr/local/bin/cnb-superagent-watchdog.sh`，只有接收器可达且返回合法健康结果才进入共享watchdog，避免接收器自身故障触发云环境回收。
- 独立watchdog配置 `/etc/cnb-watchdog-superagent.env`、日志 `/var/log/cnb-watchdog-superagent.log`、状态 `/tmp/cnb-watchdog-superagent-fails`；连续2次失败恢复，恢复后冷却1800秒。
- 12:09执行graceful shutdown并确认末次快照成功，随后停止该云环境，开始外部cron回收恢复验收。
- 此前Linux测试实例的临时profile/state已保存到本地 `tmp/cnb-persistent-20261102/linux-before-persistence.tgz`，使用新的云端profile启动持久化实例。

## 自动恢复验收

- 12:10:01 武汉cron记录 `RECOVER: no running workspace -> start`，自动创建 `cnb-khh-1k6d76b9h`。
- 新实例12:10:40获取租约，12:10:41完成快照恢复，12:10:59完成启动后的快照上传。
- 实机核对测试定时任务历史、生成文件与并发设置全部恢复；云端内存约446MiB。
- 测试定时任务已通过应用API删除，日常定时任务列表保留干净状态。
- 最新部署Python测试46项通过，真实HTTP/SQLite/ZIP集成测试1项通过。2核全项目构建约4分钟，上一轮核心测试1363 passed/12 skipped的Linux基础继续沿用。
- `scripts/connect-cnb.ps1 -InfoOnly`、`-VerifyOnly`已实机通过，认证值只在内存读取；正常连接时向操作者显示一次性启动链接。
- 手动SSH重启使用CONTROL/owner.json恢复该环境标识，operator stop标记清除只由显式start触发。周期备份失败60/120/240/300秒退避，服务继续运行。

## SSH HTTP复用兼容

- 浏览器首批请求和WebSocket101成功，HTTP闲置后复用旧连接会停滞；额外Connection:close请求头可恢复全部请求。
- Node单socket Agent实测：响应Keep-Alive timeout=5，闲置7秒后仍复用未收到close的旧socket，后续请求超时；Connection:close对照两次约157ms完成。
- 兼容开关 `DSH_SUPERAGENT_HTTP_CLOSE=1` 限定为CNB监督器启动的DSH进程，使用Node的maxRequestsPerSocket=1；本机DSH配置继续保留。
- TypeScript类型检查与构建通过，6项真实HTTP/WebSocket等兼容测试通过，25项runtime测试通过。当前实例重启后已实机复核：响应Connection:close，浏览器默认请求头正常交互。
- 管理API接受SSH转发后的规范loopback端口，仍要求Origin与Host严格一致及自定义请求标记，拒绝cross-site、外部host和非法authority；新增回归通过。
- ego默认profile实测正常打开个人任务面板；等待8秒后API请求返回200/个人模式，修复覆盖了原闲置复用故障。
- 最终当前实例Python测试47项通过，真实HTTP/SQLite/ZIP集成1项通过，HTTP兼容/同源/文档索引专项20项通过。
- 测试命令任务与两个验证文件已清理；工作文件历史副本仍可在近期归档中找到。
- 当前本机保留一条127.0.0.1:14082访问隧道供控制台使用，其余诊断隧道已关闭；云端持续运行与外部恢复由监督器及武汉cron负责。
- 云端尚未配置模型API凭据，QQ/NapCat和邮箱配置继续保留在本机。控制台“添加API Key”属于云端首次设置。
