# Needs Forever Codex 插件

将已完成的 #19 监督内核封装为可安装的本地 Codex 插件。使用原 worker / judge / app-server 控制循环；插件提供技能入口和本地进程控制，不接管当前聊天、不增加第二套续跑调度。

## 交付

- 插件清单、仓库 marketplace、`supervise` 技能和自包含 Node.js 运行包。
- `doctor` 检查 Node.js 与已验证 Codex 版本。
- `start` / `resume` 启动独立本地监督进程，保存日志和控制句柄；启动命令返回不等于 worker 已开工。
- `status` 只读持久状态，并核对监督进程是否仍在；`pause` 通过自有进程的控制通道触发原 CLI 的持久暂停路径，确认 PAUSED 后才报告成功。
- 任务和恢复记录保存到任务工作区，独立于插件缓存；同一任务保持原内核锁、原线程、授权、验收和去重门禁。
- 安装包复制到不同目录后可运行，不依赖开发仓库、TypeScript 或 node_modules。
- 插件技能明确任务配置、具体授权、独立验收、后台任务的暂停与退出，以及当前聊天不会被自动接管。

## 验收

- 在独立 CODEX_HOME 中用实际 Codex CLI 安装并回读插件；确认技能可发现。
- 使用明确标注 simulated 的替换 app-server，验证后台启动、只读查询、暂停、原线程恢复、正常完成、重复启动拒绝和启动错误可见。
- 验证安装后的插件包在含空格与中文的目录运行，调用参数不经 shell 拼接。
- 重跑原内核测试与构建；保留实际安装、测试、版本和限制证据。

## 不包含

公开市场发布、Desktop 任意聊天接管、系统守护服务、机器重启自动拉起和新的权限授权。官方插件支持依据：https://developers.openai.com/plugins/build/plugins 。
