# Independent Spec review targeted test report

Date: 2026-11-03
Reviewer: /root/acceptance_gap_audit
Worktree: D:/WILL/TOOLS/needs-forever/.scratch/spec33-worktrees/cancelled-judge-archive
Base: 3d9742d947ffffd050faadba91faf74dd9564c97
Reviewed HEAD: 5e5c32b6b872057bc9ae7f20c07f540ea81df28e

## Evidence provenance

The test process output was returned by the execution tool and was not redirected to a file at execution time. This report is a later plain-text transcription of the already observed tool output, not the original process log, and does not claim byte-for-byte original log preservation. No tests were rerun to prepare this report.

Original command tool chunk: f968c2; process session: 66228. Completion tool chunk: 0e876e; observed process exit_code: 0.

## Exact executed command

```powershell
node --test --test-name-pattern='a timed out judge|terminated judge archive rejection|installed pause returns before|fresh archived read-only judges|PAUSED wins over a real judge' dist/test/judge-cli.test.js dist/test/main-supervision.test.js
```

## Observed completion output

```text
✔ real judge boundary continues the original worker then completes with fresh archived read-only judges (1591.162ms)
✔ a timed out judge terminates the owned connection without a second judge or inferred completion (3356.7069ms)
✔ terminated judge archive rejection or timeout is bounded and never restarts a model or infers completion (7714.2996ms)
✔ PAUSED wins over a real judge that is in flight and the owned judge connection terminates (2445.1994ms)
✔ installed pause returns before bounded C cleanup and cleanup failure cannot restart A (11104.9506ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 15656.3816
```

## Scope

These are deterministic isolated installed-plugin/process-boundary tests using the external app-server fixture, not native Desktop acceptance or evidence of historical C5 archival. No product files, real sessions, installation, trust or user configuration were changed. The full suite was not rerun.
