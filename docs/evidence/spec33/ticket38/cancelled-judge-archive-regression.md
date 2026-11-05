# Cancelled judge archival regression

Date: 2026-11-03. Base: `3d9742d947ffffd050faadba91faf74dd9564c97`.

This is deterministic public-boundary evidence using the external app-server
fixture and an isolated copy of the installed plugin. It is not a claim that
the previously interrupted native C5 has been archived. No real chat,
installation, hook trust or user configuration was changed by this patch.

## Failure and cause

Before the fix, running
`node --test --test-name-pattern='a timed out judge' dist/test/judge-cli.test.js`
failed with `The cancelled C must be archived even after its owned connection
exits.` Expected archive targets: `["judge-1"]`; actual: `[]`.

The terminal cleanup only archived when `!termination`. Cancellation and
timeout correctly closed their owned app-server, but that condition then
skipped archival of the known persistent C.

The generated `ThreadArchiveParams` has only `threadId`. Cached official host
source at `rust-v0.159.0`, `thread_processor.rs:1709`, first optionally persists
a loaded thread, then directly reads and archives through `thread_store`.
Archival does not require `thread/resume`. The new cleanup therefore never
loads C into a model, starts another turn or targets A.

## Final behavior

The durable PAUSED checkpoint and its immediate abort/owned-server shutdown
remain in their original order. After that shutdown finishes, the known C ID
gets one independent cleanup attempt using the same argv and workspace,
verified disabled features/MCP configuration and no model or tool requests.
Cleanup has a fresh 3-second operational deadline; its synchronous version
probe has a 1-second timeout. Owned child shutdown retains its existing
2-second force-exit fallback.

Success emits `judge_archived` with `via: isolated_cleanup`. Rejection or
deadline failure emits `judge_archive_failed`, exact C ID and error. There is
no cleanup retry or task restart; the cancellation/timeout result still wins.
No pending-cleanup recovery mechanism is added by this bounded fix.

## Verification

- `npm run plugin:build`: PASS (TypeScript and 17 generated runtime modules).
- `node --test dist/test/judge-cli.test.js dist/test/main-supervision.test.js`:
  **35/35 PASS**, zero failed, cancelled or skipped.
- `node --test dist/test/cli.test.js dist/test/recovery-cli.test.js dist/test/verification-cli.test.js`:
  **52/52 PASS**, zero failed, cancelled or skipped.
- `git diff --check`: PASS.

The cancellation/timeout tests establish exact `["judge-1"]` archival, a
separate cleanup PID with unchanged guarded argv and cwd, no cleanup
`thread/start`, `thread/resume` or `turn/start`, and no surviving owned servers.
Cleanup rejection and a held archival RPC both retain RECOVERING with no
decision, and emit explicit cleanup failure without another model attempt.

The installed Stop/control test holds both C and the eventual archival RPC.
Public pause returns in under 2.5 seconds while cleanup has its independent
3-second deadline. Stop returns `{}`; state remains PAUSED with no pending
delivery, no decision and no confirmed continuation. Both the former C server
and the timed-out cleanup server exit. The existing delayed-C pause regression
also verifies one archived C and no additional model or resume.

The combined full suite is reserved for the integration owner after merge.

## Candidate package

See `cancelled-judge-archive-package.json` for the archive SHA256 and all 28
archive-file hashes (27 plugin files plus marketplace metadata). Archive/source
parity and the runtime integrity manifest were checked. Exactly four runtime
JavaScript files and `runtime/integrity.json` change from the base; hooks,
scripts, skills, marketplace/package metadata and version 0.3.3 remain byte
identical. The archive was created without installation or trust changes.
