# 通过 NapCat 接入 QQ

NapCat 负责 QQ 登录和 OneBot v11，Superagent 负责消息路由、任务执行及回复。

```mermaid
flowchart LR
  qq[QQ 私聊或群聊] <--> napcat[NapCat]
  napcat <-->|OneBot v11 WebSocket| source[QQ 来源]
  source --> router[Router]
  router --> worker[Worker]
  worker -->|执行结果| source
```

## 1. 启动 NapCat 并登录

按 [NapCat 官方安装文档](https://napneko.github.io/guide/boot/Shell) 安装对应系统版本，启动后扫码登录机器人使用的 QQ 账号，并确认在线。

当前本机维护环境已准备官方 `v4.18.42` Shell 便携包及手动启动脚本：

```powershell
& 'E:\VSCODE-project\SuperAgent\napcat\Start-NapCat.ps1'
```

包的 SHA-256 已与官方 GitHub Release 一致性校验。准备过程仅下载、解压和检查启动文件，账号登录与真实 QQ 通信留待操作者完成。其他安装位置可直接使用官方 `launcher-user.bat`。

## 2. 选择连接方式

在 Superagent 的 **设置 → 来源 → QQ · NapCat** 中选择方式。

| Superagent 选项 | NapCat 中开启 | 连接方向 | 默认地址 |
| --- | --- | --- | --- |
| 正向 WebSocket | WebSocket **服务端** | Superagent 主动连接 NapCat | `ws://127.0.0.1:3001` |
| 反向 WebSocket | WebSocket **客户端** | NapCat 主动连接 Superagent | `ws://127.0.0.1:6199/onebot/v11/ws` |

两种方式选择一种即可。

### 正向模式

1. 在 NapCat WebUI 的 OneBot v11 网络配置中创建并启用 **WebSocket 服务端**。
2. 监听地址设置为 `127.0.0.1`，端口 `3001`，消息格式选择 `array`。
3. Superagent 选择“正向 WebSocket”，填写 `ws://127.0.0.1:3001`。

NapCat 配置文件对应 `network.websocketServers[]`，常用字段为 `enable`、`host`、`port`、`messagePostFormat`、`token`、`reportSelfMessage` 和 `heartInterval`。

### 反向模式

1. Superagent 选择“反向 WebSocket”，默认监听地址 `127.0.0.1`、端口 `6199`、路径 `/onebot/v11/ws`。
2. 在 NapCat WebUI 中创建并启用 **WebSocket 客户端**，目标 URL 填 `ws://127.0.0.1:6199/onebot/v11/ws`。
3. 消息格式选择 `array`，应用配置。

NapCat 配置文件对应 `network.websocketClients[]`，常用字段为 `enable`、`url`、`messagePostFormat`、`token`、`reconnectInterval` 和 `heartInterval`。当前反向监听使用回环地址，适合部署在同一台机器；跨机器部署可以使用正向模式连接可达的 NapCat 服务。

## 3. 保存访问令牌与授权范围

双方 OneBot Access Token 设置为相同值。在 Superagent 的 QQ 来源卡片中输入令牌并单独保存；页面只显示“已设置 / 未设置”。令牌存入 DSH 凭据服务，默认凭据名 `DSH_SUPERAGENT_QQ_TOKEN`，普通来源设置、配置历史和模型提示词中均保存引用名称。

先保存来源配置，再保存令牌。变更连接设置或令牌后，连接通常在两秒内更新。

QQ 来源初始关闭，按以下步骤启用：

1. 在 **设置 → 评估 → 各来源授权** 中，为 QQ 添加允许交办任务的真人 QQ 号。这里填写操作者的账号。
2. 在 QQ 来源卡片中添加允许接收消息的群号。空群列表接收 0 个群。
3. 如需私聊，开启“接收已授权账号的私聊”。
4. 打开 QQ 来源开关并保存。确认连接状态为“已连接”，并核对显示的机器人 QQ 号。

来源配置由本机管理面板维护。移除账号授权后停止接收该账号的新任务和发送给它的回复；关闭来源后暂停整个来源。

## 4. 交办任务与追问

私聊可直接发送任务。群聊使用任一方式：

```text
@机器人 帮我整理这段文字……
/agent 帮我查一下……
```

引用机器人回复或已知任务消息，可在原任务中继续追问。普通群消息默认在代码层过滤。

- 私聊在同一账号的 `sessionMinutes` 窗口内延续会话，默认 30 分钟。
- 群聊默认 `groupFollowups: reply`，通过引用回复关联任务。
- 可选 `sender-window` 模式允许同一群内、同一发送者的窗口内补充消息继续原任务。
- `/new` 或 `/agent new` 重置当前发送者的会话窗口，下一条消息开始新任务；也可在命令后直接写任务内容。

消息和工单会持久保存；引用关系在重启后继续生效。来源上下文保留原始首条消息及最近 199 条消息，原始入站 Trigger 仍由核心数据库保存。

QQ 活动可在 **来源、触发、评估、执行** 页查看。个人任务列表用于 Web 交办对话。

## 回复与附件

回复发回任务的原私聊或群，首段引用原消息。长结果按 Unicode 字符分段，默认每段 1800 字符、最多 20 段。已确认发送的分段会持久记录，重试时跳过；OneBot 在确认丢失的情况下无法提供端到端去重保证。

支持文字、@、引用消息，以及图片、文件、语音、视频的附件标记和元数据。视觉理解需要接入实际图片读取工具。附件标记本身仅表示消息带有附件。

## 配置参考

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `connection` | `forward` | 连接方向 |
| `url` | `ws://127.0.0.1:3001` | NapCat 正向服务地址 |
| `host / port / path` | `127.0.0.1 / 6199 / /onebot/v11/ws` | Superagent 反向监听 |
| `privateMessages` | `false` | 私聊开关 |
| `groups` | `[]` | 接收的群 |
| `commandPrefix` | `/agent` | 交办前缀 |
| `sessionMinutes` | `30` | 发送者会话窗口 |
| `groupFollowups` | `reply` | 群聊追问方式 |
| `replyChunkSize / maxReplyChunks` | `1800 / 20` | 回复分段 |
| `requestTimeoutMs` | `15000` | OneBot 请求超时 |

## 参考资料

- [NapCat 官方文档](https://napneko.github.io/)
- [go-cqhttp / OneBot v11 文档](https://docs.go-cqhttp.org/)
- [AstrBot 文档](https://docs.astrbot.app/)

自动验收使用本地 OneBot 模拟端验证协议，以及真实 DSH / 模型执行链路。真实 QQ 账号的登录和线上收发需在 NapCat 登录并配置授权范围后完成。
