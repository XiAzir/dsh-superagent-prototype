# 本项目维护约定

- 使用简体中文沟通，本机命令使用 PowerShell 7。
- 用户已授权对本项目 CNB 的同类部署、分支导入、自动恢复故障自行调查和修复，并记录结果。常规修复持续执行至服务验收完成。
- CNB 部署与故障处理先读 `deploy/cnb/README.md` 和 `docs/cnb-recovery-record.md`。
- 分支变更须同步核对 `.cnb.yml`、武汉 watchdog 的 `CNB_BRANCH`、密钥仓库 `runtime.json` 的 `allow_slugs/allow_branches/allow_events` 及武汉规则快照。为确定的目标分支增加精确条目，保持既有仓库、事件与其他凭据配置。
- 切换运行中的 Git 分支后，安排一次目标分支创建的新工作区验收，检查 Prepare、状态恢复、SA ready、QQ connected 和新备份上传，再记录部署成功。
- 恢复使用项目专用 `/usr/local/bin/cnb-superagent-watchdog.sh`；诊断使用 `recovery.py --check`。核对实际工作区、有效租约和真实健康心跳，跟进启动构建到结果。
- 密钥只在受限配置或内存中处理；日志、提交、输出文件和故障记录只保存公开规则、指纹及状态。
- 保留现有未提交改动。只提交本次维护涉及的文件，并将具体原因、验证结果及后续处理步骤补入运维记录。
