# 0.3.3 Desktop 验收检查点（2026-11-03）

本页记录已经发生的安装、信任发现和原聊天结果；没有执行新诊断、测试、安装、信任修改或验收聊天操作。#33 及 #34–#38 尚不能按原生验收完成关闭，也尚未合入 main、推送交付。

用户确实已审阅信任旧 0.3.2 并冷重启 Desktop。重启后原验收聊天 `01a1a0bf-c5d2-74e0-9eae-cf2d38a20cb7` 的真实 turn `01a1a127-8db6-71e2-be86-2d1bda46922a` 仍为 `PENDING_NATIVE_HOOK`，没有绑定 main session，也没有 controller B。对应读取游标为 `38ef7496-ad05-49e4-b232-ebae67370c45:3`。因此这次重启不能记作 0.3.3 原生成功，也不能记作 B/C/续跑已通过。

随后修复了六条 `commandWindows` 中仅 cmd 可展开的 `%PLUGIN_ROOT%`，统一使用宿主发现阶段替换的 `${PLUGIN_ROOT}`。本地真实 PowerShell/cmd 命令测试及 simulated 绑定回归见 `patch033.md`，它们不替代 Desktop 原生验收。

官方 Desktop 二进制于 2026-11-03 19:40（Asia/Singapore）执行 `plugin add needs-forever@needs-forever-spec33 --json` 成功，安装版本为 0.3.3，路径为 `C:\Users\will\.codex\plugins\cache\needs-forever-spec33\needs-forever\0.3.3`。安装来源 integration commit 为 `a4d2d46059848c921c2c7ec2c7fdfdbfa7484891`。原始凭据：项目根目录 `.scratch/main-session-supervision/live-desktop/candidate-shell-update033.json`，结果 `PASS`；安装后 27 个插件文件与已审查包逐字节一致，旧 0.2 插件和根工作区原有 14 个文件保持不变。归档 SHA256 为 `f2278edb1797933c410f2b4ea34236d0d46abb59490bb45941e8f49f0e1f1a95`，28 文件（含 marketplace）凭据为 `patch033-package.json`。

同次 fresh owned discovery 的原始凭据为 `.scratch/main-session-supervision/live-desktop/real-home-discovery.json`。它发现 0.3.3 的六个 hook 均已启用、均为 `trustStatus=modified`、没有 discovery errors。六条命令都显示展开后的 0.3.3 安装路径。这仅证明当前用户目录的发现和信任状态，不证明 Desktop owner 已执行 hook。安装过程未写入 trust。

下一步需要用户在 Settings > Hooks 重新审阅此次改变的全部六个定义：SessionStart、PreToolUse、PostToolUse、UserPromptSubmit、Stop、Interrupt，并按宿主要求重载或重启 Desktop。这次六个 `modified` 来自 0.3.3 的六条 Windows 命令修复，不表示用户先前对 0.3.2 的信任或重启没有发生。

收到用户完成提示后，只在原聊天、原工作目录 `C:\Users\will\Documents\Codex\2026-11-03\needs-forever-spec33-desktop` 恢复已有检查点。应使用 0.3.3 `scripts/control.mjs resume --state ".spec33-fixture\state.json"`；不能重新 `start`、替换 A、修改状态、伪造事件或用另一个 app-server 驱动 A。先确认原 A 正确绑定并自动出现 B，再继续真实监督判断、连续 Stop 续跑、DONE、暂停恢复及其余规定的原生验收。全部真实门槛通过后才能推进 main 合并、推送和 Issue 关闭。
