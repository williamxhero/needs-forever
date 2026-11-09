---
name: supervise
description: 仅在用户显式调用本技能执行任务，或明确要求启用、恢复、查询、暂停 Needs Forever 监督时使用。普通长任务、自动推进要求、提及或查看插件不触发监督。
---

# Needs Forever

先核对用户意图：只有用户显式调用本技能来执行目标任务，或明确要求启用、恢复 Needs Forever 监督，才允许执行 `start` / `resume`（含内部 `prepare`）。安装或信任插件、普通长任务或“持续推进到验收通过”、提及或查看插件、查询状态均不等于启用授权；不得自行把普通任务升级为监督。用户明确请求查询或暂停时，只执行对应管理操作，不激活监督。

主 session A 就是 worker。插件启动隐藏 Node.js 控制进程 B；每次 A 准备停止时，同步 Stop hook 让 B 新建独立只读 supervisor C。C 未确认完成时，具体方向先通过原 Stop 请求返回 A；如果 A 没有产生匹配工具活动，NF 会在持久化去重边界后通过 provider adapter 自动向原 A thread 发送同一条恢复 prompt，并记录发送与回执。脚本相对于本技能为 `../../scripts/control.mjs`；将其解析为当前安装目录的绝对路径，使用 Node.js 和参数数组调用。运行包随插件安装，无需开发仓库或 npm install。

## Stop 原因协议

每次首次启动或恢复监督时，当前 A 都必须把结构化 Stop 原因要求带入本次 worker 工作约定：当当前回合准备停止且存在明确原因时，最后一条 assistant 消息单独写一行 `STOP_REASON: <真实原因>`。只写 worker 自己知道的真实原因，不从 supervisor 判断、普通工作摘要或猜测中推导；外部阻塞、证据已收集、等待用户输入和当前工作暂告一段落都应具体说明。没有明确原因时不填充猜测，NFG 保持空白。该要求是本技能的默认协议，不需要用户在每次 Stop 前再次提醒。

运行时只接受 Stop payload 中的显式 `stop_reason`/`STOP_REASON`，或最后一条 assistant 消息中的上述独立字段；普通文本不会被推断为停止原因。

## 选择操作

- **启动**：确认上述明确启用授权后，先运行 `node <control> doctor`，然后读取 [任务合同](references/task.md)，保存原始目标、逐项验收及真实授权。将命令工作目录设为合同 workspace，在当前 A 中执行 `node <control> start --task <绝对配置路径>`；可加 `--state <绝对路径>`，默认位置为 `<workspace>/.codex-supervisor/<task_id>/state.json`。真实 native PreToolUse/PostToolUse 回执必须关联该命令、任务和随机 challenge，才会绑定 A 并自动启动 B。参数或环境变量中的 session ID 不能建立绑定。该技术凭据只关联实际控制命令与 A，不能验证 UI 中是否调用过技能；执行命令前由当前 A 核实上述人类授权。
- **查询**：按用户明确查询请求执行 `node <control> status --state <绝对路径>`。分别报告 control_mode、main_session_id、status/phase、controller_reachable、host_process_alive、hook_effective、continuation_confirmed 和 recovery_required。B 可达、hook 已返回方向和 A 实际继续活动是三个不同证据。查看同目录 `summary.md`、`events.jsonl`、`snapshots` 及 `<state>.controller.log`。
- **暂停**：按用户明确暂停请求执行 `node <control> pause --state <绝对路径>`。确认返回 `paused:true` 与持久状态 `PAUSED` 后报告成功；控制句柄失效时保留检查点并报告，不能按旧 PID 杀进程。
- **命令入口**：绑定只接受单条字面量 `node`/`node.exe` 命令（可用绝对 Node 路径和 PowerShell `&`）。Code Mode 使用顶层 `text(await tools.exec_command({cmd: "完整命令"}));`，也支持 `const result = await tools.exec_command({...}); text(result);`，对象参数须为字面量。不要用动态字符串、模板字符串、条件/循环/函数包装或复合 shell；这些形式保持 neutral，真实 prepare 若已执行则仍待绑定，按回执提示用直接 `resume --state FILE` 重试。读取、搜索、打印命令示例不会启用监督。
- **恢复**：宿主、插件或 daemon 重启后，NF 会自动向原 A 发出一次可审计的恢复 prompt，促使原 A 产生真实 `SessionStart` / `UserPromptSubmit` 生命周期回执；该回执完成重绑、轮换 generation 并重新启动 B，不需要用户再次发送 `resume`，也不会重发旧方向。只有人工 `pause` 后才需要用户明确要求恢复，并在原 A 及原 workspace 执行 `node <control> resume --state <绝对路径>`。可用 `--task <绝对配置路径>` 明确更新合同或提高/取消累计限制；目标/授权变化须先 PAUSED，固定验收及原保护基线保持不变。其他聊天可以查询和暂停，不能代替已经绑定的 A 恢复。`DONE` 的新增工作使用新的 task_id。
- **记录页面**：需要观察一个工作区的任务记录时执行 `node <control> web --workspace <绝对工作区路径> [--port 8787]`。页面只读，默认监听 `127.0.0.1`，从 `.codex-supervisor/*/state.json`、`events.jsonl` 和快照读取数据，不提供启动、暂停或恢复按钮。

完成条件是脚本结果与持久状态一致。`PENDING_NATIVE_HOOK` 或 `RECOVERING` 不能报告监督已生效。待信任时请用户在 Codex Settings > Hooks 审阅插件定义并按宿主要求重载；doctor 只检查 Node/CLI，不能证明 Desktop hook 能力或信任。只有真实 Stop 返回后的原 A 匹配工具活动才能确认续跑。身份、hook、版本或宿主不支持时保留检查点，清楚说明原因及待验证步骤。

## 持续推进与授权

已有明确启用授权时完成合同与启动，继续在当前 A 中执行原任务。B 独立运行；A 的执行内容和工具仍在当前聊天可见。Interrupt/pause 先落 PAUSED，再取消 C/验收；新 UserPromptSubmit 使旧判断和方向失效，但不自动修改目标/授权。恢复需要明确操作。状态不明先查询，避免重复启动。

以具体、可检查的验收描述完整目标；项目有固定独立验收时配置 verify 并保护验收脚本。保存用户实际授权。A 的模型、工具、网络和审批由 Desktop 原样管理；C 独立只读、受限网络，B 不替 A 回答审批或扩大授权。遇到 provider 不可用、限频、凭据阻塞或同一路线重复失败时，C 必须先检查已授权的替代 provider、本地缓存/产物、其他 API 或实现路线，并把可执行的替代动作写入 next_message；只有这些路线都已核查且确实不可执行时才允许 WAIT_EXTERNAL。失败要调查可行替代路线及其他可推进事项，全部验收和固定独立检查通过才 DONE；WAIT_EXTERNAL 必须具有必要外部条件、已尝试路线、无其他可执行工作及恢复条件的证据。

旧检查点缺少 control_mode 时保持独立 worker 模式，status/pause/resume 沿用原 worker 身份。只有用户明确选择兼容模式时，新任务使用 `start --control-mode independent-worker`。新默认模式不能悄悄降级成隐藏 worker。`live`/`simulated` 是证据分类，独立于 control_mode；`--test-fixture` 仅用于明确模拟验收。原生事件去重与内部 continuation prompt 的宿主差异及真实验收状态见发布证据，模拟通过不能替代实际 Desktop 闭环。
