这是父任务中用户已明确批准创建、驱动的独立 Desktop 验收聊天；用户原授权为“允许并行安装并创建验收聊天”，随后要求“那么继续做完，做完整”。现在按此授权启用本次隔离验收监督。你的配置已由 route-codex-task 核验：原生聊天 01a1a1a6-547e-7540-b838-e157cfebff71，保留实际 gpt-6.1-sol/xhigh 默认值，validator decision=allow；禁止另建 worker。

显式调用安装在 C:/Users/will/.codex/plugins/cache/needs-forever-spec33/needs-forever/0.3.3/skills/supervise/SKILL.md 的 needs-forever:supervise 技能。请阅读该安装副本的完整技能说明，使用已准备好的 .spec33-archive/task.json，保留目标、授权、两条验收、独立 verify.mjs 及保护基线。

实际 chat cwd 必须是 C:/Users/will/Documents/Codex/2026-11-03/needs-forever-spec33-cancel-archive。通过本聊天原生工具执行下列公开入口（不传伪造 session 身份、不在第二 app-server 恢复 A）：

node "C:/Users/will/.codex/plugins/cache/needs-forever-spec33/needs-forever/0.3.3/scripts/control.mjs" start --task "C:/Users/will/Documents/Codex/2026-11-03/needs-forever-spec33-cancel-archive/.spec33-archive/task.json" --state "C:/Users/will/Documents/Codex/2026-11-03/needs-forever-spec33-cancel-archive/.spec33-archive/state.json"

本聊天就是 worker A；绑定后仅创建 stage1.json，内容严格为 {"stage":1,"value":"before-cancel"}。报告真实工具证据后结束此响应，触发实际 Stop。父任务会在真实 JUDGE 和已知 C 身份出现后执行公开 pause，检查取消与自动归档。不要创建 stage2，不要自恢复，暂停后等待明确恢复指令。

完整目标始终包括 stage1、明确恢复后且获得新 C 真实指导才创建 stage2.json {"stage":2,"value":"after-explicit-resume"}，以及不改固定独立验收通过。不要预跑独立 verifier、修改保护文件、模拟回调、访问其他任务或扩大授权。不要向父任务主动发消息。若安装、信任或绑定不可用，准确报告现状，不能冒称已经启用。
