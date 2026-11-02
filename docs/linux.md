# Linux 个人模式

本指南在 Linux 工作区部署个人模式，个人任务页可单独使用，无需配置 GitHub 或飞书。DSH profile 使用独立的 `DSH_HOME`，避免触碰同一宿主上的其他 profile。

## 前置条件

- Linux 环境
- Node.js 24 LTS、pnpm 11、Git
- DeepSeek Harness CLI `dsh` 0.2.1-rc.5
- Python 3、tmux；视频帧提取使用 ffmpeg

CNB 仓库：[XiAzir/dsh-superagent](https://cnb.cool/XiAzir/dsh-superagent)。默认 `linux` 分支从 Windows 功能分支 `personal-web` 的 `92f0694` 继续开发，保留原分支及完整历史。

在 `linux` 分支点击“云原生开发”，平台会按照 `.ide/Dockerfile` 安装工具，并按 `.cnb.yml` 安装依赖、构建。SSH 命令可从工作区启动页面的“SSH 登录命令”复制。每次推送 `linux` 分支会触发 `pnpm check`。

## 准备 profile

在仓库根目录执行：

```sh
node scripts/setup-linux.mjs --port 13082
```

脚本使用仓库现有 `pnpm-lock.yaml` 执行 `pnpm install --frozen-lockfile` 和构建。首次运行会创建独立的 `superagent` Web profile，并安装当前仓库。Web 模板自带的空 `cordis.patch.yml` 会被 Linux 个人模式配置替换，其中明确设置 `mode: personal`。重复运行时会沿用已有 profile，不覆盖它的配置文件或非空 `cordis.patch.yml`。

默认 DSH profile 和任务状态放在仓库 `.artifacts/linux/` 下：

- `.artifacts/linux/dsh-home/`：DSH profile、模型服务设置及凭据
- `.artifacts/linux/state/`：个人任务数据库、会话和执行工作目录

默认目录供当前云开发环境测试使用，也可以显式指定路径：

```sh
install -d -m 700 /workspace/.artifacts/linux/dsh-home /workspace/.artifacts/linux/state
node scripts/setup-linux.mjs \
  --home /workspace/.artifacts/linux/dsh-home \
  --state-dir /workspace/.artifacts/linux/state \
  --port 13082
```

`--home` 和 `--state-dir` 都要求绝对路径。运行状态和凭据目录使用当前用户专有权限：

```sh
chmod 700 /workspace/.artifacts/linux/dsh-home /workspace/.artifacts/linux/state
```

### 环境回收与数据保留

CNB 云开发环境闲置后会回收。按平台的[代码备份和文件漫游文档](https://docs.cnb.cool/zh/workspaces/file-keeper.html)，代码自动备份会跳过 `.gitignore` 中的目录；这里的 `.artifacts/` 属于忽略项。长期保存个人任务时，请先配置持久卷、外部备份，或在 CNB 个人设置中明确加入所需的自定义漫游路径（平台容量上限 100 MB）。SQLite 备份应在服务停止后进行，并同时保留 `DSH_HOME` 和 `stateDir`。长期运行的个人 Agent 适合部署在具备持久磁盘的 Linux 主机上；本次 CNB 工作区用于开发和验收。

`--port` 默认为 3082。本指南使用 13082，便于和本机 Windows 的 3082 服务同时使用。如果目标 profile 已存在，脚本会保留其设置及已有 `cordis.patch.yml`；调整端口时，编辑现有 patch 的 `webserver.config.port`。需要核对文件包含 `mode: personal`、`webserver` 的 `127.0.0.1:13082` 及 `dsh-superagent.config.stateDir` 的绝对路径。示例见 [profile.linux.cordis.patch.yml](../examples/profile.linux.cordis.patch.yml)。模型服务请在 DSH profile 中单独配置。

`dsh --from-default-profile web` 会重建目标 profile，因此脚本仅在目标 profile 目录不存在时调用它。脚本不会启动 QQ 或其他消息客户端。

## 启动

首次启动建议在终端前台运行，以便查看 DSH 的启动信息：

```sh
export DSH_HOME="$PWD/.artifacts/linux/dsh-home"
dsh --profile superagent --no-open
```

自定义 `--home` 时，将上面的 `DSH_HOME` 换成相同的绝对路径。打开 `http://127.0.0.1:13082`，进入 Superagent 的任务页。模型服务设置完成后即可创建个人任务。

CNB 工作区需要在连接断开后继续运行时，先确认该环境支持常驻进程和 `tmux`，然后使用服务管理脚本：

```sh
export DSH_HOME="$PWD/.artifacts/linux/dsh-home"
export DSH_SUPERAGENT_URL=http://127.0.0.1:13082
scripts/dsh-superagent start
scripts/dsh-superagent status
```

停止服务：

```sh
scripts/dsh-superagent stop
```

服务管理脚本会把日志和控制文件写入仓库 `.artifacts/`。容器重建后，从恢复的数据目录启动服务。

## 通过 SSH 隧道访问

DSH 只监听回环地址。先从本地电脑建立本地端口转发，再在本地浏览器访问服务：

```sh
ssh -N -L 13082:127.0.0.1:13082 <CNB-SSH-target>
```

将 `<CNB-SSH-target>` 替换为 CNB 当前工作区提供的 SSH 目标或别名；保持 SSH 会话运行，并使用 DSH 启动日志中的 `http://127.0.0.1:13082/?token=...` 链接。隧道两端端口需和 Web 配置保持一致，管理 API 会校验 Host 与 Origin。SSH 目标会随云开发环境更新，应从当前工作区页面获取。

模型来源、QQ 连接、邮箱凭据和定时任务在新 Linux profile 中独立配置。定时任务的程序路径和参数应使用 Linux 可执行程序；例如 Windows 的 PowerShell 邮箱启动器可迁成 Python 程序或 Linux shell 包装脚本，再在 Superagent“定时任务”中配置。

## 配置示例

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 13082
- id: dsh-superagent
  config:
    mode: personal
    stateDir: "/workspace/.artifacts/linux/state"
```

保持 `stateDir` 为稳定的绝对路径。升级仓库或重启服务前，备份该目录；profile 的模型配置和凭据位于 `DSH_HOME`，也应纳入持久化和备份规划。
