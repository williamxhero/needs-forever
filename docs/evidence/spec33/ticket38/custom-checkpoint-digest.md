# 自定义检查点位置的核验摘要修复

真实 Desktop 的原 A 已到达 C 的 DONE 判断，独立核验 exit 0，但完成门因 `workspace_changed:true` 拒绝。A 报告变化仅来自 `.spec33-fixture/state.json`；本次实现没有读取真实状态内容、controller token 或操作真实 A。

根因为 `src/main-supervision.ts` 的 `workspaceDigest` 只按根目录名称排除 `.codex-supervisor` 和 `.git`。当任务把检查点放在 `.spec33-fixture/state.json` 等自定义位置，B 每 250ms 保存的 accounting 状态、summary 也进入业务文件摘要。固定核验期间即使没有业务输出变化，前后摘要仍可能不同。`src/snapshot.ts` 负责模型证据窗口，与这次文件摘要误报无关，无需修改。

测试通过现有安装副本的 lifecycle → B → Stop → 独立核验公开边界复现：自定义 `.spec33-fixture` 检查点，核验延迟 600ms 跨过 B 的真实心跳。`custom-checkpoint-red.txt` 中 verifier exit 0、protected_before/after 均为空，但被误报 workspace_changed 并返回 block。

修复让摘要读取实际 Store 路径，仅排除自身 state、UUID 原子写临时文件、summary.md、events.jsonl 和 snapshots 下 UUID 命名的生成 JSON。没有排除整个检查点目录；同目录的 task.json、verifier、业务输出和其他文件继续参与摘要。原有 protectedChanges 在摘要排除之前和之后独立执行，即使某 protected 文件恰好具有生成快照的名称，也不能绕过原始基线保护。

`custom-checkpoint-green.txt` 验证三个行为：只有 B accounting 变化的稳定核验可以 DONE；自定义目录中业务输出在核验期间变化仍拒绝 DONE，稳定重查后才完成；具有生成快照名称的 protected 文件被改动仍在执行核验前拒绝，恢复原内容后才能完成。全部为 simulated host/app-server 测试，不构成 Desktop 原生通过证据。最终受影响的 main-supervision、main-controller、main-session、lifecycle、plugin 测试记录为 `custom-checkpoint-regression.txt`。

候选继续保持 0.3.3，hooks、scripts、skill、manifest、package 及 marketplace 字节均未变化。单独归档 `needs-forever-0.3.3-runtime-fix033.tar.gz` 与 `runtime-fix033-package.json` 保留原 0.3.3 归档和证据；包中仅 runtime/src/main-supervision.js 及 runtime/integrity.json 更新。是否可通过官方同版本 plugin add 安装，需要后续独立审查和实际安装结果；本实现没有手动更新 cache、trust 或真实状态，也没有再次变更 hook 定义。
