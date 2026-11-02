# 本地 NapCat 迁移 CNB（2026-11-02）

用户明确将先前误称的 AstrBot 更正为本地 NapCat，授权迁移到 Superagent 云环境。

## 基线与范围

- 本地源：`E:\VSCODE-project\SuperAgent\napcat\prepared`，官方Shell包版本记录为`v4.18.42`。
- 已有账号级OneBot配置启用`127.0.0.1:3001`正向WebSocket，token与WebUI凭据仅作私有传输，Git留档省略明文。
- 本地程序与数据保留为回退副本；此次迁移独立于现有`XiAzir/psy-maimai`麦麦实例，后者保持原状。
- Windows登录态跨Linux兼容性待验证，预留首次手机扫码/验证步骤。

## 部署规划

- CNB linux/vscode资源升至4核8GB，增加Docker service，工作区镜像仅添加Docker CLI。
- 固定NapCat镜像版本摘要，独立受管容器`superagent-napcat`，OneBot与WebUI仅发布loopback端口。
- 业务数据归入`/workspace/.superagent-runtime/data/napcat`，包含QQ登录数据、NapCat配置/插件/应用数据及稳定设备标识；归档服务加入对应根目录。
- 归档容量扩到压缩4GiB/展开8GiB，保持流式传输与两代私有备份。
- Superagent继续使用原域名；NapCat WebUI优先通过临时SSH端口转发完成登录。

## 部署与验收结果

- 已保存旧Superagent末次快照并停止唯一旧环境，新建4核8GB环境`cnb-kvq-1k6ddrlao`；DSH恢复healthy，Docker client/server可用，内存上限实测8192MiB。
- 归档模块提交`3108d38`，新增NapCat完整根与4GiB/8GiB流式限制。
- 本地进程/端口只读检查：未发现NapCat启动命令行或6099/3001监听，普通QQ桌面进程保持原状。
- 固定镜像已成功拉取；检查entrypoint确认首次从镜像自带Shell ZIP初始化app，已有配置会保留，避免引入Windows二进制。
- 武汉归档服务与单独的`/superagent-runtime/` Nginx location已扩容4GiB，读写等待600秒；回滚副本`/root/.cnb-superagent/storage-backups/napcat-20261102T061332`。
- 私有配置通过SSH stdin直接传输到云端data/napcat/config，包含默认及账号级OneBot、WebUI配置；本机源文件保持原状。账号与现有麦麦归档账号只读比对结果为不同账号。
- 容器固定hostname、machine-id、MAC；Docker bind probe已通过；6099/3001仅发布127.0.0.1。入站路径兼容别名`/app/napcat`、`/app/.config/QQ`实际指向workspace，出站仅只读挂载state/artifacts。
- NapCat首次启动后已有包含完整app/QQ配置的私有快照成功上传武汉。
- Superagent QQ来源已启用正向`ws://127.0.0.1:3001`，凭据写入DSH凭据服务，只允许真人`1791081637`，群列表为空。
- 用户完成手机扫码后，OneBot已连接，登录账号与迁移目标一致。
- 重启验收发现Docker29停止容器时会清空inspect中的endpoint MAC，旧管理器误判为配置变化。`18f5c37`修正为停机时兼容隐藏MAC，启动后立即严格复验，不匹配则停自有容器；Linux targeted15/15通过。
- 修复后已自动重新登录，未再次扫码。真实OneBot文本与文件上传均确认成功，唯一收件人为1791081637；临时样本文件已清理，发送确认记录保留在云端control/napcat-migration-smoke.json。
- 浏览器task space11已由用户结束，后续遵守ego-browser规则停止页面控制，仅进行服务端验收。临时本机转发端口16099和HTTP兼容代理16100仅用于登录，业务QQ运行完全在云端。
- 最终再次完整shutdown/start成功，NapCat自动登录原账号、Superagent恢复connected，监督器healthy。Linux部署单测88/88、HTTP恢复集成1/1通过，公网管理API与WS101回归通过。
- 武汉latest ZIP约174.7MB，manifest实测包含QQ数据2226文件、NapCat配置7文件、app686文件、identity2文件，以及私有deployment配置；应用各数据根均已覆盖。
- 本机临时SSH转发与登录代理已退出，16099/16100监听确认清空；云端QQ保持connected。保留本机原程序与配置，完成回退准备。

## 后续管理与回退

- 主入口仍为`https://superagent.1994622.xyz/`，QQ由云端处理。
- 云端SSH：`cnb-kvq-1k6ddrlao-001.7ab42003-9bc0-4076-b7cc-ac43e588d389-61q@cnb.space`；环境重建后通过`scripts/connect-cnb.ps1 -InfoOnly`获取最新地址。
- `python3 deploy/cnb/runtime.py stop`会暂停整套服务并保存末次快照；`start`恢复。回退本地前先停止云端，以保持机器人账号单端运行。
- 登录态数据会随workspace与私有快照保存；平台风控再次要求手机验证时，使用SSH临时转发WebUI完成确认。
