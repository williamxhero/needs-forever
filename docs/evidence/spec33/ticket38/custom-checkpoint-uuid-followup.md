# UUID 业务文件变更门的审查修正

独立 Spec 审查对首轮 `321cbe42d8ddefc07bbd0975baff496a2425be5c` 候选进行了 public Stop 边界探针：未列入 protected_files 的 `.spec33-fixture/snapshots/11111111-1111-1111-1111-111111111111.json` 在固定核验期间实际变化，却仍得到 DONE 和 workspace_changed=false。审查原始证据保存在项目根目录 `.scratch/main-session-supervision/review-custom-digest-1793707444180/result.json`。这表明按 UUID 文件名猜测 Store 所有权的排除过宽。

本工作树通过相同的公开安装副本 lifecycle → B → Stop → 独立核验 seam 增加回归，使用不同的业务 UUID `22222222-2222-2222-2222-222222222222.json`。`custom-checkpoint-uuid-red.txt` 在修改源码前记录：该文件实际变化时 Stop 返回 `{}` 而非 block。

最小修正删除生成快照 UUID 正则及对应排除条件。当前控制流的所有 Store.snapshot 写入均在 verification 调用、首次 workspaceDigest 之前发生；核验期间无需排除 snapshots。最终仅忽略明确保留的自身 state、原子写临时文件、summary.md 和 events.jsonl，不忽略 snapshots 文件或整个状态目录。

`custom-checkpoint-uuid-green.txt` 覆盖四项：自定义 checkpoint 心跳不误阻完成、邻接普通业务输出变化会拒绝、未 protected 的 UUID 业务 JSON 变化也会拒绝、protected UUID 文件仍保留原始基线门。稳定重查和恢复原保护内容后分别可以完成。全部证据为 simulated host，不能作为真实 Desktop 原生通过证据。受影响测试保存在 `custom-checkpoint-uuid-regression.txt`。

保留首轮 runtime-fix033 归档及 receipt。最终待审候选另存 `needs-forever-0.3.3-runtime-fix033-uuid.tar.gz`，28 文件凭据为 `runtime-fix033-uuid-package.json`。相较原始 0.3.3，仅 runtime/src/main-supervision.js 与 runtime/integrity.json 改变；hooks、scripts、skill、metadata 字节不变。未执行安装、信任修改、真实 A 或其 state 操作。
