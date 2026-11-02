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

部署及验收结果将随执行追加。
