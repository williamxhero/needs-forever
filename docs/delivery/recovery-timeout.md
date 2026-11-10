# 自动恢复超时中断

恢复期最长 120 秒。首次进入恢复时持久化 `recovery_window.started_at` 和 `deadline_at`；重试、绑定 generation 轮换和进程重启沿用同一窗口。旧 checkpoint 以已有 `binding.armed_at` 迁移，不用持续变化的 `updated_at` 重新计时。

超过截止时间后，任务进入 `INTERRUPTED / IDLE`，NFG 显示“已中断”和最后失败原因。取消恢复计划、清空待发送动作与恢复 prompt、释放 native 绑定，并追加 `recovery_interrupted` 审计事件。保留原始任务合同、原 Codex thread 以及历史日志。该转换表示监督意外中断，不表示任务已完成，也不终止原 Codex thread。

存活的恢复 owner 不能绕过超时检查。全局 daemon 在常规扫描之间另按最早恢复截止时间唤醒；独立 coordinator 超时后退出。恢复消息辅助进程的单次传输上限为 30 秒，且受累计恢复截止时间约束。

中断后的迟到 Hook、旧 checkpoint 写入及自动 rebind 不能重新激活监督。用户点击“恢复”时更新任务版本、重新生成原 A 的绑定挑战，并开启新的 120 秒窗口。正常恢复到 WORKER 后清除当前窗口；下一次独立故障重新计时。

修复前 B0QI 的现场复现显示：原生绑定等待超过 17,964 秒，仍为 `ACTIVE / RECOVERING`，且控制器已经退出；其旧 coordinator 持续生成恢复消息辅助进程。现场状态备份保存在忽略目录，原始事件不改写。

验证包含：120 秒边界、存活 owner、跨重试和重启、旧状态迁移、重复 tick 只记录一次中断、迟到生命周期与旧状态写入、人工恢复的版本与绑定栅栏、已安装 coordinator 退出、全局 daemon 截止时间唤醒、NFG 原因与恢复按钮及异步刷新。

## 交付验收（2026-11-10）

- 代码提交 `0cc855c3f3722e574122a1484c61c4cd9163d2c7`。构建通过，35 个自包含运行时模块；最终针对性测试 34/34，通过最终串行全量回归 213/213，耗时 299.306 秒，零失败、取消、跳过或 todo。默认并发测试未作为本次通过结论。
- 现有 0.3.4 安装副本更新了 12 个文件，48/48 文件与源插件一致，Hook 清单及插件身份文件未变。全局 daemon 已重启至 PID 63976，8790/8788 正常监听。
- B0QI 按旧 `armed_at` 迁移：起始 2026-11-10 14:42:38（UTC+8），截止 14:44:38；本次部署后于 19:59:26 记录 `INTERRUPTED / IDLE / RELEASED`，没有把既有失败恢复重新计时。该日期表示旧任务迁移生效时间，不声称旧版本在截止时间已经执行中断。
- 实际 NFG 页面显示“已中断 26/11/10 19:59”，展示最后失败原因与“恢复 Needs Forever”图标按钮。三分钟后复核仍中断、仅一条 `recovery_interrupted` 事件，该任务恢复辅助进程为零。
- 原 A ID、任务版本、完整合同字节与合同 SHA 均保持一致，系统日志未删除。没有声称原 A 已恢复或 #793 已完成。

完整证据：[验收记录](../evidence/recovery-timeout/release-checks.json)、[全量测试输出](../evidence/recovery-timeout/full-test.txt)、[针对性测试输出](../evidence/recovery-timeout/targeted-test.txt)。
