# 自动恢复超时中断

恢复期最长 120 秒。首次进入恢复时持久化 `recovery_window.started_at` 和 `deadline_at`；重试、绑定 generation 轮换和进程重启沿用同一窗口。旧 checkpoint 以已有 `binding.armed_at` 迁移，不用持续变化的 `updated_at` 重新计时。

超过截止时间后，任务进入 `INTERRUPTED / IDLE`，NFG 显示“已中断”和最后失败原因。取消恢复计划、清空待发送动作与恢复 prompt、释放 native 绑定，并追加 `recovery_interrupted` 审计事件。保留原始任务合同、原 Codex thread 以及历史日志。该转换表示监督意外中断，不表示任务已完成，也不终止原 Codex thread。

存活的恢复 owner 不能绕过超时检查。全局 daemon 在常规扫描之间另按最早恢复截止时间唤醒；独立 coordinator 超时后退出。恢复消息辅助进程的单次传输上限为 30 秒，且受累计恢复截止时间约束。

中断后的迟到 Hook、旧 checkpoint 写入及自动 rebind 不能重新激活监督。用户点击“恢复”时更新任务版本、重新生成原 A 的绑定挑战，并开启新的 120 秒窗口。正常恢复到 WORKER 后清除当前窗口；下一次独立故障重新计时。

修复前 B0QI 的现场复现显示：原生绑定等待超过 17,964 秒，仍为 `ACTIVE / RECOVERING`，且控制器已经退出；其旧 coordinator 持续生成恢复消息辅助进程。现场状态备份保存在忽略目录，原始事件不改写。

验证包含：120 秒边界、存活 owner、跨重试和重启、旧状态迁移、重复 tick 只记录一次中断、迟到生命周期与旧状态写入、人工恢复的版本与绑定栅栏、已安装 coordinator 退出、全局 daemon 截止时间唤醒、NFG 原因与恢复按钮及异步刷新。
