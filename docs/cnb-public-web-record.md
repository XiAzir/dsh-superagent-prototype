# Superagent 公网入口部署（2026-11-02）

目标域名：`superagent.1994622.xyz`，Cloudflare管理，武汉服务器 `8.148.72.235`。
保留现有CNB运行环境与归档，新增HTTPS入口与全路径登录保护。

## 变更记录

- 准备独立反向SSH账号 `cnb-superagent-web`；固定允许监听武汉127.0.0.1:13083，映射CNB127.0.0.1:13082。
- 新增 `/etc/ssh/sshd_config.d/90-superagent-web.conf` 与 `/etc/ssh/authorized_keys/cnb-superagent-web`。限制remote forwarding、PermitListen、MaxSessions=0，禁用密码、TTY、agent与X11转发。
- 专用私钥 `/root/.cnb-superagent/web-tunnel-ed25519`，仅注入本项目CNB密钥配置；用户既有SSH私钥保持原状。
- 管理入口登录名 `azir`，随机密码与内部代理密钥存于武汉 `/root/.cnb-superagent/web-credentials.json`（0600）；本机明文仅归入ssh-server的 `local/secrets.md`。
- BasicAuth散列 `/etc/nginx/cnb-superagent.htpasswd`（root:www-data，0640）；内部代理鉴权配置 `/etc/nginx/snippets/cnb-superagent-proxy-auth.conf`（0600）。
- 网关环境文件 `/etc/cnb-superagent-web.env`（0600）；计划网关127.0.0.1:13084，SSH回源127.0.0.1:13083。

部署源码暂存 `/root/.cnb-superagent/web-deploy-20261102`。

## DNS 与 HTTPS

- Cloudflare 默认 profile 中创建 `superagent` A 记录指向 `8.148.72.235`，DNS only；服务器解析已验证。
- Let's Encrypt 证书签发成功，有效期至 2027-01-31；certbot 自动续期并 reload nginx。
- nginx 独立站点已启用，匿名 HTTPS 访问返回 401，realm 为 `Superagent`。
- CNB 专用密钥仓库 runtime.json 已新增反向隧道密钥、固定目标与主机公钥 pin；导入限制为当前仓库 linux/vscode。
- 专用 SSH 公钥指纹：`SHA256:25QLuqYaMcRCkPOyvtiDr78KeoH+segF/MgUEg+92mE`。

## 网关部署排查

- 13:17 首次安装触发回滚，旧归档服务保持 active。journal 显示新网关启动 34ms 后被安装脚本主动停止，未出现应用崩溃。
- 安装脚本加入 HTTP 就绪有界等待，避免 Type=simple 与监听就绪的竞态；显式 restart 已安装网关，回滚仅由父 shell 执行并保留原 active/enabled 状态。
- 首轮回滚备份：`/root/.cnb-superagent/web-backups/20261102T051713-419268`。
- systemd 对归档目录设置只读权限，确保 state.json 原子替换后能读到最新租约。

## 验收过程与结果

- 13:21 修订后的安装脚本通过，archive/web/nginx 三个服务均 active，网关仅监听127.0.0.1:13084；公网匿名401。
- 成功部署备份：`/root/.cnb-superagent/web-backups/20261102T052125-419877`。
- 三个功能模块已分别提交并推送 CNB linux：`402a1b8`（会话上报）、`d06d78b`（反向隧道）、`5ff6a24`（HTTPS网关）。
- 本地回归：Python 60项执行、1项平台跳过，其余通过；Node网关10/10通过；diff空白检查通过。
- 13:24 对旧实例 `cnb-khh-1k6d76b9h` 执行监督器shutdown并保存末次快照，再使用仓库限定API停止该唯一运行实例，等待watchdog恢复以载入新版代码与密钥导入。
- 手动运行一次现有watchdog记录首次失联后，13:25系统cron完成第二次检测并自动创建 `cnb-hda-1k6dbfmao`；新实例检出`5ff6a24`、恢复快照并成功上报Web会话。
- 首轮真实SSH鉴权发现公钥目录被umask收紧为0700，sshd降权后无法读取。配置代码已显式固定公钥目录root:root/0755，公钥文件仍root:root/0644，私钥保持0600；该修正仅涉及专用公钥目录。
- 修正后CNB自动重试成功，武汉监听 `127.0.0.1:13083`；归档、网关和nginx均active，网关enabled，`nginx -t`通过。
- 新CNB真实Linux回归：Python 60/60通过、真实HTTP持久化集成1/1通过；武汉Node标准test运行10/10通过。
- 公网实测通过：匿名/错误密码401；登录根页200并取得Secure/HttpOnly/SameSite=Strict cookie；管理state GET 200；同源无副作用POST404；跨源/缺Origin POST403；token query400；跨源/缺Origin WS403；合法WS101且保持16秒。
- 当前环境：`cnb-hda-1k6dbfmao`，SSH `cnb-hda-1k6dbfmao-001.e48099a8-00bf-4e19-af53-685a0f3c6c49-1dd@cnb.space`，运行代码`5ff6a24`；专用公钥目录修正在武汉生效并另行提交`d78b072`。
- 本机此前14082转发会话已结束，公网访问由CNB与武汉之间的常驻隧道承载。
- 受限SSH实测通过：真实CNB占用固定loopback端口；专用凭据的其他远端端口转发、shell/exec及本地转发实际通道均被拒。验收脚本`deploy/cnb/test_web_ssh_policy.py`仅显式运行时连接武汉，自动单测导入无网络副作用。
- ego 默认Profile 10的task space 9已导航公网入口；浏览器原生认证阻塞页面查询，已通过handOff交回用户。浏览器内登录后的界面尚待用户填写凭据；服务端公网API与WS验收已完成。

## 使用与凭据

- 访问 `https://superagent.1994622.xyz/`，浏览器登录用户名为`azir`。
- 密码及专用私钥仅在本机运维仓库已忽略的`local/secrets.md`中保留，条目标题`Superagent public web 2026-11-02`；此文与Git提交均省略明文。
- 浏览器原生BasicAuth弹窗交由用户填写。云端模型API key仍需用户配置，本机QQ/NapCat/邮箱本次保持原状。
- 域名DNS only，使用武汉的Let's Encrypt证书。域名入口不依赖本机SSH窗口；云环境回收期间恢复由既有watchdog与快照机制完成，恢复期间可能短暂503。
