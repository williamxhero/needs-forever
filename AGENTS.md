# Project Write Scope

- The active project workspace is the default write scope. Every repository beneath that workspace belongs to the same project and may be modified directly when needed for the requested outcome.
- A repository outside the active project workspace is read-only unless the user places it in scope. Follow any more-specific `AGENTS.md` instructions found within the project.
- When MarketHub、CPA、SearXNG、Task Center、爬虫服务 refer to runtime or data, they mean services on “小电脑” (yosef-server), not this local machine.
- GitHub 中文正文禁止通过 PowerShell 管道传给 gh，必须使用 UTF-8 无 BOM 文件上传并回读验收。

## Agent skills

### Issue tracker

需求、SPEC 和 tickets 使用 GitHub Issues；操作前读取 `docs/agents/issue-tracker.md`。

### Triage labels

分诊和发布 SPEC 前读取 `docs/agents/triage-labels.md`。

### Domain docs

领域文档采用 single-context；探索代码前按 `docs/agents/domain.md` 读取术语与相关 ADR。
