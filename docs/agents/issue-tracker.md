# Issue tracker: GitHub

Issues、SPEC 和 tickets 位于 williamxhero/needs-forever，使用 gh CLI 操作。

## Conventions

- 从 git remote 确认目标；发布前通过 gh repo view 核验仓库身份。
- 创建、编辑 Issue 或发表评论时，将完整正文写入 UTF-8 无 BOM 文件，通过 --body-file 上传；禁止通过 PowerShell 管道传递中文正文。
- 上传后通过 gh issue view --json body 回读，与本地正文逐字核对。
- 读取 Issue：gh issue view <number> --json number,title,body,labels,comments。
- 查询 Issue：gh issue list --state open --json number,title,labels。
- 多个子 SPEC 使用一个总 SPEC，以 Markdown todo list 列全子 SPEC 的真实 Issue 引用，并同时建立 GitHub 原生父子关系；单一简单 SPEC 无需另建总 SPEC。
- 使用 GitHub 原生子 Issue 与依赖关系；SPEC 的正文引用不能代替系统关系。必需关系不可用或无权限时明确报告未完成。
- 标签名称按 triage-labels.md 映射。
- 发布 SPEC 时创建独立 Issue，并应用 ready-for-agent。
- 关闭 Issue 前核对验收证据，先记录结论，再关闭。
- 历史 Claude Code／loop-forever Issues 保留原状；Codex Supervisor v0.1 使用独立 SPEC。

## Pull requests as a triage surface

**PRs as a request surface: no.**
