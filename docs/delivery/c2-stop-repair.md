# C2 原生 Stop 交付与恢复期限修复

2026-11-10（UTC+8），B0QI 在 21:59:14.894 收到原始 A 的真实 Stop，C 在 22:00:24.095 返回有效 C2 `CONTINUE`，计划为 `qr793-v14-restore-route-context`。没有发生 B 交付或后续 A 继续执行，因此这次链路不能计为生产闭环验收通过。

原始 A 保持 `01a1ae7a-9442-79e0-b32b-aa560f976453`；合同 SHA 保持 `db7ccc65dc3524ae4dcc40767bfd7bd11bd7e4a107a51c5e90d1bb5f3c576e54`。

## 原因与修复

1. C 实际看到七条证据，原始输出通过校验。B 在记录 C 的判断并更新 `last_decision` 后重新生成受 24k 预算限制的快照，证据变为五条，其中丢失了 C 引用的一条。B 因此错误地拒绝有效判断。每次判断现在只生成一个快照，C 与交付 admission 使用同一份；admission 仍重新核对当前合同、Catalog 和完整 Ledger，不放宽证据或权限规则。交付 admission 异常同时纳入已有三次有界重试路径。
2. 新的传输失败发生在健康 BOUND 工作之后，旧恢复窗口已经清除，但恢复代码误用了 21:13 的旧绑定 `armed_at`，立刻触发过期中断。现在仅待 native hook 的同一恢复过程可继承该时间；健康执行后的新故障获得新的 120 秒窗口。同一过程的重试、generation 变化和进程重建仍不能延长期限。

## 证据

- 实际历史快照只读回放：原快照有效，重建快照丢失一个被引用 ID。保留原快照可通过 admission；没有发送消息或改写生产状态。[回放](../evidence/c2-stop-repair/captured-proof-after.txt)
- 安装副本回归在修复前不能返回 CONTINUE，修复后返回一次有效方向、只记录一次 send、没有重试。[修复前](../evidence/c2-stop-repair/installed-proof-before.txt)、[修复后](../evidence/c2-stop-repair/regressions-after.txt)
- 恢复期限回归在修复前使用旧起点，修复后从新故障开始计时。[修复前](../evidence/c2-stop-repair/recovery-window-before.txt)
- 针对性测试 57/57，通过快照保留、暂停取消、晚到判断、重绑、唯一交付和持久恢复期限。[测试](../evidence/c2-stop-repair/targeted-test.txt)
- 独立 [Standards](../evidence/c2-stop-repair/review-standards.md) 与 [Spec](../evidence/c2-stop-repair/review-spec.md) 审查均无未解决问题。

## 部署与现场恢复

修复提交 `3a6a6e923ef2ca8839d6278d5f1381684cb4734f`。最终完整串行测试 **221/221**，249.294 秒，零失败、取消、跳过或 todo。[完整输出](../evidence/c2-stop-repair/full-test.txt)。构建产物与运行测试时一致，后续只更新交付记录。

同一个 0.3.4 安装包更新四个文件，**48/48 文件与源插件一致**，Hook 清单和包身份不变。全局 daemon 经过归属核验后重启为 PID 20228，8790/8788 正常，NFG HTTP 200。[部署回执](../evidence/c2-stop-repair/package-deployment.json)。

22:18:51 发起恢复，独立 helper 三次均因 Desktop 仍持有原线程 active writer 而被拒绝。这条传输不能声称已自动恢复。随后协调线程通过 Codex Desktop 原线程消息接口恢复 A，操作另记为 `operator_recovery_prompt_dispatched`，没有把该消息写成 Hook 或 Stop。

22:20:14.634 收到原始 A 的真实 `main_session_rebind_receipt`；22:20:15.442 启动新 B（PID 31388），随后真实工具结果持续到达。状态为 **ACTIVE / WORKER / BOUND**，恢复窗口清除。原始 A、合同 SHA、其他任务的人工暂停以及系统日志均保留。[现场安全投影](../evidence/c2-stop-repair/release-checks.json)。

此轮恢复含协调线程通过 Desktop 的协助，不能据此声称独立 helper 已解决 Desktop writer 冲突。后续仍待 A 自然发出新的 Stop，确认修复后的 C2 判断、B 唯一交付及 A 继续活动，再关闭 #54/#49。不把历史回放或模拟模型测试计为新的生产 Stop，也不表示 QuantResearch #793 已完成。
