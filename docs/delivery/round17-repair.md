# B0QI 第 17 轮中断修复

用户要求修复 2026-11-11 第 17 轮的中断、上一轮确认串入本轮、以及空的 WORKER 收到。修复基线为 `3e800b87ac06f61ee3c8fbacb1020fa62c9f4d28`。

## 现场与复现

原始 A 保持 `01a1ae7a-9442-79e0-b32b-aa560f976453`，合同 SHA 保持 `db7ccc65dc3524ae4dcc40767bfd7bd11bd7e4a107a51c5e90d1bb5f3c576e54`。真实 Stop `f352d5fb-7917-4039-84be-a7c3f34388d8` 于 2026-11-11 00:38:56.771（UTC+8）到达。三次实际 C 判断均超时，00:45 后备用 inventory 被完整账本的 `no_progress_limit` 拒绝，00:47:21 转为 INTERRUPTED。本轮未发送续接指令。

00:28:31 的 CONFIRMED 属于 delivery `853e717a-8e8a-4226-8c46-f5ca0fe67340`、Stop `25ceab10-4ef2-457b-ab47-b95066236172`，不能作为本轮 C 判断。原事件保留，不改写。

原快照有一条完整 inventory，但全局 evidence_complete=false 清空了所有 observation digest。原持久状态有 8 条 Catalog、3 次尝试，快照预算却将两者全部裁掉；C 无法了解已执行的诊断。备用方案只对这个空的账本投影校验，直到实际交付才被完整历史拒绝。C 超时本身没有输出可用于断言模型内部原因，不将上下文缺陷声称为超时的唯一原因。

## 修复约定

- 按证据项保留完整性。完整且来源相关的工具结果可以形成独立观察、提示 B 实际探测；截断项不能形成事实。缺失或截断的当前整体证据仍禁止 DONE/WAIT_EXTERNAL。旧快照没有逐项完整性时继续保守处理。
- 预算优先丢弃冗长的旧路线计划与大块当前 payload，保留精简当前证据及有界 Catalog/Ledger；原始任务合同不裁剪。裁剪必须明确标记，持久状态不修改。
- 备用方向引用实际完整结果作为区分检查，并在完整当前账本下再次检查。不得通过改名、UUID、清空历史或放松 no-progress 规则获取许可。
- 三次 C 失败且备用方案也不获准时，立即以明确原因中断；不空等额外恢复窗口，不发送空方向，不宣告接收成功。
- NFG 优先按 Stop/source Stop/delivery 关联交付事件，不能将上一轮确认作为下一轮 C 判断。C 无有效判断时显示实际失败状态；未发送时显示“未交付”，不生成 prompt 框或接收时间。
- 普通 worker 的实际 send_prepared/send_confirmed 仍按 delivery 与源 turn 显示真实方向；未确认的提案不能作为已收到。固定验收输出被裁剪时不成为完整证据；后续真实修复回合出现后，旧验收结果仅作明确标记的历史上下文，不污染当前证据完整性，新的 DONE 候选仍触发原固定验收。
- 部署复用现有全局 NF/NFG、同一个受信任插件和原始 A；不恢复其他人工暂停任务，不为测试构造 native Stop。

## 验证与交付

三个初始回归在修复前均失败：完整 sibling 观察为空、大 payload 导致 Catalog 清空、确认事件串轮。修复后通过。另增加完整 inventory 实际文件探测、完整重试账本防绕过和安装副本中备用方案立即中断的回归。

第 17 轮只读重建已保留 4 条 Catalog、1 次尝试、5 条独立观察；与原始完整持久账本联合检查的备用方向通过，未写生产状态或发送消息。最终相关模块测试 56/56，新增历史验收与当前裁剪两项测试 2/2；完整串行回归 **233/233**、301.090 秒，零失败、取消、跳过或 todo。冻结修复提交为 `0006b5138fa98af6d0b7cb46a0c80ff485efa757`。[验证汇总](../evidence/round17-repair/checks.json)、[全量输出](../evidence/round17-repair/full-test.txt)、[现场只读重放](../evidence/round17-repair/replay.txt)。较早 230/230 和 232/232 的通过版本不是最终交付凭据。

独立两轴复审均通过、无未解决项：[Standards](../evidence/round17-repair/review-standards.md)、[Spec](../evidence/round17-repair/review-spec.md)。审查发现并修正了普通模式交付显示、裁剪验收证明、以及历史验收污染新修复回合三个边界问题。实际历史 NFG 回读为“SUPERVISOR 未完成 / WORKER 未交付”，无上一轮 CONFIRMED、无虚构接收时间或空 prompt 控件；旧终止事件没有明确超时字段时，界面不推断内部终止原因。

## 本机交付与恢复

2026-11-11 09:05（UTC+8）部署到原 0.3.4 安装副本，48/48 文件一致，更新 9 个 runtime 文件，Hook 清单及包身份未变；[部署回执](../evidence/round17-repair/package-deployment.json)。仅停止已核实归属、端口及命令行的旧全局 daemon PID 81068，以同一配置在后台重启，保留现有全局服务和自启动机制。六项 Hook 仍全部启用且 trusted；[宿主回读](../evidence/round17-repair/hook-trust.json)。

通过 daemon 对 B0QI 正常 resume 后，任务版本为 16，原 A 与合同 SHA 不变。独立 helper 被 Desktop 的 active-writer 锁拒绝；再次确认原 A 空闲后，协调线程通过原 Desktop 通道发送一次正常恢复消息，并另记 `operator_recovery_prompt_dispatched`。没有将协调消息冒充 native receipt，没有要求用户手动发送。

09:06:24.903 收到真实 rebind，09:06:26.328 新 B PID 66656 启动；09:06:52 后连续接收原 A 的实际工具结果。捕获时状态 **ACTIVE / WORKER / BOUND**，恢复窗口清除，新 B 的 bundle 指纹与安装包一致，NFG HTTP 200；CPA 人工暂停状态保持 PAUSED。[现场回执](../evidence/round17-repair/release-checks.json)与[原事件前缀摘要](../evidence/round17-repair/original-event-prefix.json)证明原事件未改写，恢复操作仅追加新审计事件。

本次验收覆盖缺陷复现、修复、回归、两轴审查、原安装副本部署及原 A 实际恢复；不将新的 Stop/C2 全链路或 QuantResearch #793 的业务完成声称为已验收。问题跟踪为 #55。
