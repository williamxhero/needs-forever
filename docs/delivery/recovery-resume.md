# 恢复按钮真正重新接通原始 A

2026-11-11 00:01（UTC+8），新的真实 Stop→C2→B 唯一交付→A 完整工具继续链路已成立，见 [SPEC #49 最终交付](spec49-final.md)。下文描述各次故障与恢复的捕获时间，独立 helper 的 Desktop writer 限制仍如实保留。

23:31 的后续真实 Stop 另暴露了路线结果异常逃出恢复处理的问题，见 [第二次 Stop 修复](c2-outcome-repair.md)。下文保留先前捕获时间的恢复记录。

后续 21:59 的真实 Stop 暴露了 B 的快照漂移及新恢复误用旧期限问题，已另行修复；当前结果见 [C2 Stop 交付修复](c2-stop-repair.md)。下文 PID 与状态描述属于该次原始验收的捕获时间。

2026-11-10，原始 A 保持 `01a1ae7a-9442-79e0-b32b-aa560f976453`，B0QI 合同 SHA 保持 `db7ccc65dc3524ae4dcc40767bfd7bd11bd7e4a107a51c5e90d1bb5f3c576e54`。

## 复现与原因

现场任务版本 10 在 20:26:44 点击恢复，20:28:44 中断；两条事件之间没有任何恢复 prompt 派发。对应 daemon 控制入口只保存新绑定挑战，没有启动 provider 恢复执行。

另外，旧恢复 helper 使用了 C 的隔离连接，关闭 A 的 hooks/plugins，并在 turn/start 确认后立即关闭自有 app-server。这只能证明请求被接收，不能证明 A 继续执行。现有测试原先只断言 sent/ack，因此漏掉提前中断。

重新绑定还仅接受 SessionStart/UserPromptSubmit。已经运行的 A 即使发出真实 PreToolUse、PostToolUse 或 Stop，也不能接回监督，只能等到 120 秒后中断。

## 修复

- 全局 daemon 在持久化恢复状态后立即调用 provider 驱动；后台扫描也能补起驱动，无须 B 或新 hook 先启动。独立 coordinator 复用同一驱动、租约和 delivery id。
- A 使用独立 worker 连接，不套用 C 的 hook/plugin 禁用参数，也不覆盖原线程权限；C 的只读及网络隔离保持原样。helper 持有执行连接直到目标 turn 完成，人工暂停、删除/任务版本变化及恢复期限仍能取消。传输建立阶段最多 30 秒；A 已绑定并正常执行后不受旧恢复期限中断。
- 发送前回读同一安装路径的 6 项 hook。缺失、禁用或未信任会立即中断并显示具体原因，不再空等两分钟。实际传输失败写入恢复原因。
- 同一原始 A 的新工具事件或 Stop 可以重绑。保留原 A、工作区、任务版本、generation、合同和回执时间栅栏。用于重绑的首个真实 Stop 只交付新 B 一次；不会构造补发 Stop。
- B 成功启动后清除过期恢复错误。继续保留每次恢复 120 秒的上限及持久化中断边界。
- 用于重绑的真实 PreToolUse 同时保留起始记录，后续匹配 PostToolUse 的实际结果进入 C 证据；单独收到 PostToolUse 不构造不存在的起始事件。adapter/core 共享重绑事件枚举，防止两边漂移。

## 本机验证

本机检查另发现仅剩插件缓存、Codex 未注册 Needs Forever。重新注册同一个 0.3.4 包后，由用户在 Codex 设置中信任六项 hook；宿主回读六项均为 trusted。未代替用户写入信任，也没有使用绕过信任参数。

21:13:11（UTC+8）发起恢复，21:13:37.701 原始 A 的实际 PreToolUse 触发 `main_session_rebind_receipt`，21:13:39.728 新 B 启动（PID 28740），随后接收真实工具结果。状态为 ACTIVE / WORKER / BOUND，恢复窗口已经清除。该次恢复没有追加新 A 消息；原始 A 已在执行，独立恢复连接对 active writer 的拒绝被如实保留。

三项 active-worker 回归在修复前均失败（持续 PENDING_NATIVE_HOOK）；修复后 PreToolUse/PostToolUse/Stop 三种入口全部通过，Stop 入口同时验证返回 CONTINUE 和唯一 Stop 事件。另覆盖 daemon 无 hook 派发、helper 等待真实完成、未信任时禁止启动 A。

独立 Standards 审查为 0 项硬问题，原先重复枚举的可选建议已通过共享 predicate 处理。Spec 审查发现首个恢复工具结果可能丢失；新增断言复现为 0 条结果，修复后通过，复审无未解决项。最终针对性测试 7/7，覆盖 daemon 派发、实际 helper 完成、未信任时中断，以及 PreToolUse/PostToolUse/Stop 恢复与真实结果保留。

## 验收范围

独立 helper 支持 app-server 内建工具和原权限；尚未实现 Desktop 客户端动态工具、交互审批或输入请求的转接。因此不将“未禁用插件”声称为“所有 Desktop 动态工具均可由独立 helper 执行”。本次真实恢复中原始 A 的 Desktop writer 已在工作，helper 没有接管它；实际恢复凭据来自其真实 native hook。动态工具转接属于明确保留的兼容性限制。

最终测试、包一致性与后续真实 Stop 结果以 evidence 记录为准。真实 A 恢复不等于 QuantResearch #793 已完成。

## 最终交付

- 修复提交：`f3162a57734f0165cccbec6ce00b7741867b3a80`。
- 最终完整串行测试 **219/219**，276.187 秒；零失败、取消、跳过或 todo。该轮在所有代码修复和插件重建之后运行。[全量输出](../evidence/recovery-resume/full-test.txt)、[针对性测试](../evidence/recovery-resume/targeted-test.txt)、[修复前失败](../evidence/recovery-resume/pretool-before-fix.txt)。默认并发命令未作为本次通过结论。
- 同一个 0.3.4 安装副本 **48/48 文件一致**；最后部署更新四个文件，Hook 清单和包身份未变。[包部署回执](../evidence/recovery-resume/package-deployment.json)。六项 Hook 均已启用并信任，[宿主回读](../evidence/recovery-resume/hook-trust.json)。
- 全局 daemon PID 79944 和 B PID 28740 持续运行；8790/8788 服务正常。部署后的下一条真实工具事件更新了 B 的包指纹，并清除了过期 active-writer 错误，无须再次重启 A 或恢复任务。
- [现场回执](../evidence/recovery-resume/release-checks.json)记录原 A/合同、恢复与启动时间及真实工具结果数量。新的原生 Stop→C 仍待 A 自然发出；不构造或强迫结束当前 turn。
- 两轴审查：[Standards](../evidence/recovery-resume/review-standards.md)、[Spec](../evidence/recovery-resume/review-spec.md)。
