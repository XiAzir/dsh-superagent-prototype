# CNB workspace 数据持久化加固（2026-11-02）

用户要求全部应用数据保存在云环境 `/workspace`，并核实 AstrBot 的数据归属。

## 实测基线

- 当前云环境 `cnb-hda-1k6dbfmao`。
- 现有 DSH_HOME 为 `/workspace/.superagent-runtime/data/dsh-home`，会话、配置和附件随该目录保存。
- Superagent SQLite 与任务数据在 `/workspace/.superagent-runtime/data/state`；任务工作目录默认 `state/work`。
- DSH进程原HOME为`/root`，原cwd为`/workspace`；实测/root仅发现pnpm缓存，未发现另存的DSH用户目录或应用配置目录。
- 武汉既有快照为`/var/lib/cnb-superagent/latest.zip`、`previous.zip`，每5分钟更新。

## 本轮加固

- 应用HOME固定到`data/home`，XDG配置/数据/状态/缓存目录一并设置；新建工具配置与浏览器profile随home备份。
- 默认DSH工作目录固定到`data/work`；子进程临时文件与XDG runtime目录放`control/tmp`及`control/run`。
- tmux每个新pane显式接收应用路径变量，保证复用旧tmux会话时更新HOME等设置。
- 归档增加可选`home`根，兼容旧快照。普通业务`cache/caches/.cache`目录保留；home内可重建缓存和依赖目录按明确规则跳过。
- 停机顺序调整为应用停止后保存末次快照，人工暂停也保存末次快照。
- CNB专用路径保护限制stateDir、Worker和计划任务cwd到已归档的四个子树，排除缓存与符号链接绕行；普通本机安装保持现有行为。
- 运行数据始终位于被Git忽略的`.superagent-runtime`目录；凭据与业务数据通过私有归档保存，Git提交仅保存源码与部署材料。

## 部署与验收

- 本地Python65项执行、2项Linux专用检查跳过，其余通过；真实HTTP备份恢复集成通过，已覆盖home工具配置与业务cache文件。目录保护相关Vitest 350/350通过。
- 武汉接收端先部署新版`archive.py`并重启归档服务；旧文件保留于`/root/.cnb-superagent/storage-backups/20261102-home/archive.py`。
- 三模块分别提交：`1dfdf7a`（归档覆盖）、`1fb073b`（用户目录/启动/停机保存）、`14923aa`（路径保护），均已推送CNB linux。
- 云端原数据保持原位，受控停止监督器后fast-forward到`14923aa`并启动成功；再次通过shutdown/start完成实际重启验收。
- `/proc`实测DSH cwd为`/workspace/.superagent-runtime/data/work`，HOME和全部XDG路径均在`data/home`，临时目录在`control/tmp`。
- 在home工具配置与work/cache中写入两份随机临时样本，重启后完整保留；从武汉真实归档服务下载latest、验证SHA-256并解包恢复，两份内容hash一致。样本及恢复暂存已清理。
- 真实Linux Python65/65通过，HTTP备份恢复集成1/1通过。重启后的公网登录、管理API、拒绝跨站请求、WS101均通过。
- 本机两处失败测试临时目录已定向清理，用户文件保持原状。
- 云端全量Vitest首轮1378项通过、12项平台跳过，3项文档约定检查报新增模块/测试索引及类注释缺失；已补齐对应文档与注释，待针对性复验。TypeScript检查通过。

## AstrBot / 麦麦核实

对应CNB仓库`XiAzir/psy-maimai`。活跃业务数据在`/workspace/.maimai-runtime/data`，其中AstrBot映射到容器`/AstrBot/data`。武汉`cnb-maimai-archive.service`保存`/var/lib/cnb-maimai/latest.tar.gz`与`previous.tar.gz`，每30分钟更新。

此次只读核查时main分支运行实例为`cnb-l54-1k6cc0joj`，AstrBot、NapCat与guard均running，归档服务active。Git仓库保存程序与部署配置；运行数据目录由gitignore排除。旧psy VPS还有独立AstrBot，历史数据目录`/opt/astrbot/data`，本轮未操作该实例。
