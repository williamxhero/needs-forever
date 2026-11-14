# Desktop Provider 验收记录

日期：2026-11-15（Asia/Singapore）  
集成提交：`6d54277`  
项目版本：`0.3.4`

## 已通过

| 场景 | 结果 | 证据 |
|---|---|---|
| source、bundled runtime、integrity metadata 一致 | PASS | `npm test`；插件构建输出 44 modules；完整测试 281 passed |
| provider contract、capability receipt、simulated same-thread | PASS | `main-session-provider.test.ts` 的 7 项测试 |
| shared transport identity fence、writer 状态、未知 delivery 去重 | PASS | Desktop provider adapter 的 2 项测试；每次 RPC 都携带 thread/session/workspace/host/task_version/run_generation |
| Recovery Episode / 状态投影 / late-result fence | PASS | `provider-recovery.test.ts` 的 5 项测试；`main-controller.test.ts`、`web.test.ts` 回归通过 |
| installed runtime、native Stop、B/C 生命周期回归 | PASS | 完整安装副本回归，281/281 通过 |
| hook 断开后保持恢复等待、未知 delivery 不盲重发 | PASS | 既有 native recovery 测试与 provider recovery 测试通过 |
| provider unavailable 明确等待 | PASS | `recovery_desktop_provider_unavailable`、`WAIT_EXTERNAL/RECOVERING` 断言通过 |

## 真实 Windows Desktop 结果

当前机器上发现的 Desktop 可执行文件是：

```text
C:\Users\will\AppData\Local\OpenAI\Codex\bin\ca9abb0b4d8ac692\codex.exe
codex-cli 0.159.0
```

Needs Forever 当前支持并校验的协议基线是 `codex-cli 0.166.0` 和 `codex-cli 0.167.0`。因此本次没有把 0.159.0 当作可连接的 Desktop provider，也没有猜测窗口、最近 thread、标题或进程顺序来绑定原始 A。使用未提供 transport 的 provider probe 得到：

```json
{
  "provider_kind": "unavailable",
  "evidence_level": "unavailable",
  "available": false,
  "attached": false,
  "same_thread_verified": false,
  "limitation_reason": "Desktop shared transport or trusted original-thread identity is unavailable."
}
```

所以以下真实宿主场景在本机标记为 **NOT RUN / 明确不兼容**：

- 连接当前 Desktop 的原始 A thread 并读取真实 thread history。
- Desktop 重启后使用同一 thread ID 恢复。
- 真实 Desktop active writer、真实 delivery unknown 和真实 A native activity confirmation。

这不是把模拟结果冒充真实可用。协议版本或宿主 shared endpoint 未满足时，系统会保留 `WAIT_EXTERNAL/RECOVERING`，继续使用受支持的 native receipt fallback；不会创建第二个 worker，也不会发送无法核对的恢复消息。

## 复现命令

```text
npm test
node --input-type=module  # DesktopMainSessionProvider 无 transport 的 fail-closed probe
```

`npm test` 在本次集成提交上完成 source build、插件构建、安装副本回归和全部 281 项测试，失败数为 0。

## 发布限制

要把真实 Desktop provider 从“已实现但不可用”提升为“真实可用”，还需要在同一 Windows Desktop 版本上提供并验证 shared app-server/daemon endpoint，且 capability receipt 必须同时证明 endpoint、宿主指纹、原始 main session、workspace、协议版本和 writer 状态。完成这项现场验收前，生产默认行为保持 fail-closed。
