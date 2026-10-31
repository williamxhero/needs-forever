# Ticket #26: isolated judge and evidence protocol

Scope: S2 #21 ticket #26 only. Public seam: actual CLI subprocess → replacement JSONL app-server → persisted state, events, snapshots and owned-process lifecycle. The production `AppServerJudge` implementation runs in these cases; the external model/server behavior is simulated. No live AI acceptance is claimed.

## Result

`final/report.json` and `final/tests.tap`: **38/38 simulated PASS**, comprising 24 retained S1 public CLI regressions and 14 judge/evidence cases. Platform: Windows 10.0.26300, Node v24.19.0; protocol fixture baseline: Codex CLI 0.166.0. Six captured runs preserve worker/judge IDs, raw judgment output, validation, event references, snapshots and protocol trace. The underlying ignored `runs/ticket26/` directories retain the complete task/fixture inputs as well.

Reproduce after installing locked dependencies:

```powershell
npm run build
node scripts/run-s2-judge-exit.mjs runs/ticket26-exit/independent
```

The runner does not build. It runs both public CLI test files once, saves TAP/status/platform information and copies the six relevant scenario artifacts. A fixture `real_judge: true` selects the production judge class while keeping the entire run marked simulated.

## Actual TDD cycles

Each numbered red log was captured before its matching implementation, followed by a targeted green run:

| Evidence | Behavior established |
| --- | --- |
| 01-red / 01-green | Fresh read-only judge threads, same-worker continuation and archival |
| 02-red / 02-green | Unknown fields/evidence and illegal action combinations rejected |
| 03-red / 03-green | Worker self-report alone cannot establish DONE or WAIT_EXTERNAL |
| 04-red / 04-green | 24k contract-preserving snapshot, actual source IDs, failure priority, recent instruction/results and repeated-failure hint |
| 05-red / 05-green | Streamed completed items supply final JSON even when the terminal turn's items are empty |
| 06-red / 06-green | Judge timeout stops the owned connection before recovery, with no additional judge |
| 09-red / 09-green | Same-thread foreign turn completion cannot supply the current judge result |
| 12-red / 12-green | Uncertain judge turn/start outcome settles the old owned connection before recovery |
| 13-red / 13-green | Streamed worker replies remain visible through the actual CLI |
| 14-red / 14-green | Connection exit while awaiting judge output propagates the real error immediately and settles the old call |

07-behavior records a fixture correction discovered while adding the T06 acceptance case: the old S1 duplicate fixture injected an empty completion for the current turn before its real evidence. The production judge correctly refused the resulting missing proof. Real-judge fixture mode now duplicates the actual completed event, while retaining S1's original ordering fixture for its fixed-judge regressions. This was a fixture correction, not a claimed runtime red/green cycle. 07-green passed the corrected behavior suite; 08-s1-regression passed all 24 S1 cases. Later additions are included in the final 38-case report.

10-incomplete additionally verifies that a cited but truncated tool output cannot justify DONE or WAIT_EXTERNAL. Other acceptance cases cover stable T06 waiting, fenced/appended/multiple JSON outputs, read-only policy expansion, archival failure and a paused in-flight judge. Final acceptance is the complete suite, not the earlier intermediate counts.

## Contract and lifecycle

- `src/judge.ts` exports the runtime schema and fixed prompt. Every new judge turn passes `outputSchema` and a readOnly/never override. The returned thread policy is checked before any turn.
- `Supervisor.pump` remains the sole notification consumer. It records actual item/plan/terminal evidence and routes judge observations. Exact thread/turn and task ACTIVE/version gates prevent stale scheduling.
- Every production evidence ID points to an actual persisted `event_id` and, where applicable, thread/turn/item identity. Tool/change data and worker prose are distinct. Missing plan/verification data is explicit; omitted payloads are marked and cannot support a terminal conclusion.
- Snapshots preserve the complete goal, acceptance and authorization. Oversized mandatory contracts fail explicitly rather than silently truncating those fields. A repeated failure hint requests a different hypothesis/route; it never itself triggers a terminal state.
- Valid and invalid raw judgment text and validation outcome are persisted. Completed judges are archived with their IDs retained. Archive failure does not invalidate a valid decision.
- Cancellation/timeout interrupts when a turn ID is known, then closes the owned app-server and awaits its exit. `Rpc.close()` shares its in-flight close promise so simultaneous callers all await actual termination.

## Boundaries still open

`live`: **not_run**. The required S2 live T01–T05 evidence follows integration of tickets #27/#28. Independent protected verification and incoming request handling are not implemented by #26. A configured verifier still refuses DONE through the existing S1 guard. Complete retry/backoff, server recovery and history reconciliation remain S3. Invalid judgments currently preserve ACTIVE/RECOVERING and report their real error; no retry cap or terminal success is inferred.

The red/green text logs are normalized to UTF-8/LF with trailing whitespace removed for repository checks; their original bytes are preserved under ignored `runs/ticket26/raw-tdd-logs/`. Captured runtime JSON artifacts retain their generated content. The merger must preserve ignored evidence before archiving this worktree.
