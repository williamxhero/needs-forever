---
name: supervise
description: 持续执行一个已授权的本地任务，或查询、暂停、恢复 Needs Forever 管理的任务。用于用户要求自动推进到验收通过、启动监督任务或管理其检查点。
---

# Needs Forever

通过插件自带控制脚本管理独立 worker。脚本相对于本技能为 `../../scripts/control.mjs`；将该路径解析为当前安装目录的绝对路径，使用 Node.js 和参数数组调用。脚本和运行包随插件安装，无需开发仓库或 npm install。

## 选择操作

- **启动**：先运行 `node <control> doctor`。读取 [任务合同](references/task.md)，将用户目标、验收和真实授权写入任务工作区的 JSON 文件。执行 `node <control> start --task <绝对配置路径>`；需要指定检查点位置时加 `--state <绝对路径>`。默认记录在 `<workspace>/.codex-supervisor/<task_id>/state.json`。
- **查询**：执行 `node <control> status --state <绝对路径>`。同时说明保存的 status、phase 和进程 live；`ACTIVE` 且 `live:false` 表示需明确恢复，不代表正在推进。查看同目录 `summary.md`、`events.jsonl` 和 `<state>.console.log` 获取原因。
- **暂停**：执行 `node <control> pause --state <绝对路径>`。确认返回 `paused:true` 与持久状态 `PAUSED` 后报告成功；控制句柄失效时保留检查点并报告，不能按旧 PID 杀进程。
- **恢复**：用户明确要求后执行 `node <control> resume --state <绝对路径>`。使用原任务和 worker ID。仅需显式变更任务合同或限制时加 `--task <绝对配置路径>`；修改目标/授权前先暂停。`DONE` 的新增工作使用新的 task_id。

每个操作的完成条件是脚本结果与当前持久状态一致。启动回执只证明进程已启动；worker_thread_id 非空及事件中的 `send_confirmed` 才能证明实际开工。报告检查点和日志路径，让用户能够在新聊天继续管理。

## 持续推进与授权

用户要求执行时完成任务配置与启动，不停在建议命令。监督进程独立于当前聊天运行；用户要求等到结束时，按检查点查询直到 DONE、WAIT_EXTERNAL、PAUSED 或进程退出，并在有变化时汇报。状态不明先检查，避免重复启动。

以具体、可检查的验收描述最终目标；项目有独立验收命令时将其配置为 verify，并保护验收脚本。保存用户实际授权；目标范围或必要授权确实缺失时先澄清，普通技术选择自行处理。后台 worker 只在指定工作区、受限网络和已验证沙箱执行。外部消息、付费、凭据或扩大权限须来自明确授权；当前内核的隔离边界不足以执行时报告限制。

该插件创建并管理自己的 app-server / worker，不接管当前 Desktop 聊天。它复用内核的 CONTINUE、DONE、WAIT_EXTERNAL 判断、验收与恢复门禁；停止条件由实际验收、外部依赖或用户暂停决定。机器关机后需明确 resume。仅真实模型运行可标为 live，`--test-fixture` 入口仅用于明确授权的模拟验收。
