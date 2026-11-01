# 任务合同

配置文件为 UTF-8 JSON；workspace 必须是已存在的绝对路径。task_id 使用字母、数字、下划线、点或连字符，且不能为 `.` 或 `..`。同一 task_id 和工作区只允许一个监督进程。

```json
{
  "schema_version": 1,
  "task_id": "repair-local-build",
  "workspace": "D:/projects/example",
  "goal": "修复本地构建失败，并通过现有验收。",
  "acceptance": [
    { "id": "A1", "text": "现有构建成功，修复有可追查的验证证据。" }
  ],
  "authorization": "仅允许修改指定本地项目并运行本地检查。",
  "limits": { "max_worker_turns": null, "max_minutes": null },
  "verify": {
    "argv": ["node", "verify.mjs"],
    "timeout_seconds": 60,
    "protected_files": ["verify.mjs"]
  }
}
```

按项目实际情况替换示例值。verify 可省略；配置后使用真实存在的验收脚本，argv 直接执行而非 shell 字符串。保护文件必须位于 workspace 内。预先固定的 argv 和文件基线会跨 resume 保留。

两个 limits 默认均为 null；用户主动要求时才填写正数。限制触发 PAUSED/user_limit 后，显式提高或移除限制才能恢复。不要在 authorization 中存放密钥。

start 的回执包含 `state_path`、日志路径和 session。保存这些路径；所有可变任务数据都在工作区或显式 --state 目录，插件升级或重装不应删掉任务记录。
