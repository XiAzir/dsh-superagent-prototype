# CNB 自动恢复故障与维护记录

## 2026-11-10：Codex 分支密钥导入权限遗漏

### 原因与影响

北京时间 2026-11-09 22:22 左右，Linux 创建的旧工作区运行约18小时后，按 `keepAliveTimeout: 18h` 完成关闭，末次快照上传成功。该实例内 Git 已切换至 `codex/autonomy-plan-20261107`，武汉 watchdog 的恢复分支也已切换，密钥仓库 `runtime.json` 的 `allow_branches` 仍仅包含 `linux`。

后续自动启动 Codex 分支在 Prepare 阶段报错：`branch: codex/autonomy-plan-20261107 does not conform to allow_branches`。旧 watchdog 仅校验启动接口返回构建号，随后进入30分钟冷却，日志持续出现 `start accepted`，实际实例始终未上线。

### 本次修复

- 密钥仓库提交 `e69ae262554b01bfe44ea206e01b41a6fbb356e4`，在原 `linux` 条目之外加入精确分支 `codex/autonomy-plan-20261107`；仓库和事件范围保持原配置。
- 新增项目专用 `deploy/cnb/recovery.py` 和测试，替换本项目的 watchdog 入口。启动前检查无凭据导入规则快照；接受启动后保存构建号并跟进流水线阶段，保存分支导入失败诊断。配置错误6小时低频重试，修复后支持 `--retry-blocked`。
- 成功判定要求对应工作区 running、有效租约、同owner最近120秒内真实健康心跳。bootstrap宽限期间继续等待。
- 武汉旧入口及配置备份在 `/root/.cnb-superagent/recovery-fix-20261110`，项目锁 `/run/lock/cnb-superagent-recovery.lock`。每5分钟cron使用新入口。
- 无凭据规则快照为 `/root/.cnb-superagent/runtime-import-rules.json`；恢复状态为 `/root/.cnb-superagent/recovery-state.json`。故障日志保留在 `/var/log/cnb-watchdog-superagent.log`。
- 冷启动进一步发现 SnowLuma 原 Docker Hub 仓库已拒绝镜像拉取。腾讯缓存保留了原固定索引及其 amd64 清单；通过平台清单 `sha256:74215e3c785099b809a6d00be107c63ecd6deeabf521ec99faf863e156b8573b` 恢复同一 v2.4.0 镜像。已导出 `snowluma/runtime/image-amd64.tar.gz`，731,775,447字节、SHA-256 `47fd020cac85e86533b9ce153497e1bfc1f956a12c9900a129fee063345f3326`，后续随私有快照恢复。
- SnowLuma管理器增加固定身份的本地镜像复用、受管归档加载及固定平台镜像缓存回退；保持设备身份、登录数据和既有进度补丁。

### 下次处理

1. 执行 `python3 /usr/local/lib/cnb-superagent/recovery.py --check`，检查实例、租约、真实心跳及待启动构建。
2. 如为 `blocked_import_branch`，读取对应构建 Prepare 阶段，并核对目标分支的 `.cnb.yml`、watchdog配置及密钥导入规则；将已授权的精确目标分支加入白名单，同步规则快照。
3. 执行 `/usr/local/bin/cnb-superagent-watchdog.sh --retry-blocked`，跟进新构建；如已有健康实例，保留该实例。
4. 检查SA运行指纹、schema、QQ连接、监督器及新快照。更新本记录并保存无凭据验收结果。

### 验收

恢复脚本专项16项测试通过。新工作区 `cnb-9vl-1k72scfdu` 已通过 Prepare，并正在恢复末次快照；完整验收结果完成后追加。
