# SPEC #77 交付记录

## DPEL 原始问题

C 已经能够提出替代路线、证据检查和有限等待条件，但旧的 B admission 与通用 inventory fallback 会丢失这些方案，重复同一诊断族，最终让 A 看到重复提示或长期处于恢复/判断状态。DPEL 的目标是让每个有效 native Stop 都得到一条可审计、可执行的 C 方向，或得到明确的有界中断。

## 旧修复不能直接沿用的原因

历史修复依赖旧的 independent-worker、旧的 main-controller 闭包、旧的 planner fallback 和旧 recovery-coordinator。#72 已经将执行边界收敛为 A-only、native-Stop-only，并把职责拆到 Judgment Round、Supervision Round、Recovery Episode 和 Completion Gate；直接 cherry-pick 会重新引入第二个 worker 或非 native continuation。

## 当前实际修改的 seam

- `Judgment Round`：C transport、事件泵、校验、超时、取消、有限重试、退避、fallback、归档和审计；连续失败会切换假设或持久化有界中断。
- `Supervision Round`：一次 Stop admission、一次结果应用、一次交付和 A 活动确认，带 generation/task_version/input_epoch fence。
- `Recovery Episode` / native adapter：恢复、重绑、deadline、lease、late-result 和真实 lifecycle receipt。
- `Completion Gate`：DONE 的固定 verifier、workspace 稳定性、protected baseline 和 fence 保持不变。
- NFG：显示 C 结果、admission/交付状态和中断原因；异步刷新保留展开状态。

## 提交与验证

实现提交按 ticket 保持小步：#78 `9dc3918`、#79 `ac7070d`、#80 `ea60ef7` 与 admission seam `212be39`、#81 `b428c92`、#82 concurrency fix `6cfc51c`，以及模拟 transport normalization 审计 `3a498a5`。文档和安装验收记录随后合并到 integration 分支。

最终验证：

- `npm run build`：通过；bundled runtime 42 modules。
- `node scripts/build-plugin.mjs`：通过。
- `npm test`：267 passed，0 failed，0 cancelled，0 skipped。
- `git diff --check`：通过。
- 目标 native/recovery/pause/resume/supervision/NFG 回归：13/13 通过。
- isolated install discovery：通过；明确保留人工 Hook 信任要求。
- source/candidate/installed package：55/55 文件，hash equal，changed files 0。
- Standards review：0 项硬问题；Spec review：未发现架构回归。模拟 transport 的 raw/canonical normalization 审计补丁已补上 review 的 P2。

## 本机部署与现场门禁

现有 Windows 全局 NF/NFG 服务已保留。审阅后的 runtime 已部署到
`needs-forever-local@0.3.4`，daemon 重启后 web 8788/API 8790 均返回 200；单一受信任 Hook、工作区和系统审计日志均保留。

B0QI 的安全状态回读仍是 `PAUSED`/`IDLE`、`pause_reason=user`、`BOUND`，原始 A 为
`01a1ae7a-9442-79e0-b32b-aa560f976453`，合同 SHA 未变。遵守人工暂停意味着本次没有触发或伪造 native Stop，因此 #82 要求的“新鲜 B0QI Stop→C→唯一交付”现场门禁仍待用户解除暂停后执行。本记录不把安装成功或历史事件写成 QuantResearch #793 已完成。

## 交付状态

代码、测试、审查、本机部署、main 合并、push 和临时资源清理已经完成。最终 main 为
`3e671b470cc73cd3d8d169ce2aef60865d70f945`，本地与 `origin/main` 一致；5 个 SPEC #77 managed worktree 已归档，6 个本次创建的分支已安全删除。

目前只剩现场门禁：解除 B0QI 人工暂停后，观察一次真实 native Stop→C→唯一交付→原始 A 活动，并据此更新和关闭 #82 与 #77。两个 Issue 当前保持 OPEN，避免把未执行的现场验收写成完成。
