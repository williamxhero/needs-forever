# Ticket #25 — S1 pause, explicit resume and exit evidence

Current SPEC: #20 only. Ticket #24 was merged before this implementation started. This ticket follows installed `implement-spec-to-done`, `implement-spec` and `tdd` procedures by loading their SKILL.md files; no dedicated Skill tool was available. Parent owns independent review, main merge, safe resource cleanup, push, tracker evidence and closure. These delivery steps are not claimed complete here.

The agreed seam remains the public CLI subprocess, JSONL app-server/fixed-judge boundary, and public persisted state/events/snapshots. No private runtime methods are invoked by tests. Fixtures are always explicitly selected and labeled simulated.

`node scripts/run-s1-exit.mjs docs/evidence/ticket-25/final` executes the full public CLI suite, captures actual TAP output and copies representative runs. `final/report.json` maps T01/T02/T05/T07/T08, explicit limits and supporting requirements to passing test names. All model and protocol scenario acceptance here is simulated. S2/S3 acceptance is `not_run`; the limited no-resend protection does not claim complete T12 reconciliation.

Representative artifacts under `final/` include the original task, complete state, append-only events, input snapshots, summary and protocol trace. They retain the actual source workspace and worker IDs from the captured runs. Paths identify evidence; replay uses a new run directory, because start correctly refuses an existing state.

Actual console Ctrl+C probes against the simulated backend were separately performed by the parent using Windows PTY. That earlier draft evidence is retained under `docs/evidence/s1-pty/` with its runtime hashes. Parent will rerun the candidate after integration; those probes do not represent live Codex/model acceptance.

## Observed red → green cycles

Each slice added one public CLI case, ran it RED, implemented the behavior, and reran its targeted case GREEN. The initial missing dependencies were installed from the lockfile; the absent `tsc` was an environment setup failure, not a behavioral RED.

| Public behavior | Actual initial RED | Minimal GREEN |
| --- | --- | --- |
| Worker pause saves before interruption | CLI timed out after 15 seconds; no pause handler | PAUSED/version 2 and checkpoint at turn/interrupt already PAUSED |
| Delayed judge result is invalid after pause | PAUSED persisted but ignored-result event absent | Late fixed success ignored by version/status guard; cancellation is supported by default |
| Verification-call cancellation | Configured verify rejected as S2-only before entering the fixture | Explicit simulated cancellation fixture reaches VERIFY and closes owned RPC on pause |
| Saved contract and original worker resume | CLI rejected `resume` as unsupported | thread/resume uses saved worker; changed original input is ignored; DONE cannot reopen |
| Cumulative turn limit | Repeated CONTINUE timed out after 15 seconds | Stops before excess send; unchanged limit rejects resume; raised limit preserves count |
| ACTIVE elapsed time and duration limit | Running worker remained ACTIVE until fixture was manually cleaned up; exit was 1 | 100 ms checkpoint persists cumulative time and duration limit pauses running work |
| Unknown sent action on resume | Resume replaced delivery ID and sent a second message | Preserves original pending action, enters RECOVERING and sends nothing |
| Known completed turn after pause | Resume added a second worker round | Resume reviews saved completed round; count remains one |
| Explicit recovery after supervisor crash | Stale supervisor lock rejected resume | Matching dead-owner locks reclaimed; saved ACTIVE time and worker count preserved |

The first full regression found that an added initialization AbortSignal closed the worker RPC before its interrupt request. The worker test failed because no interruption checkpoint existed. Fixed order is save PAUSED, request interrupt, abort/close. The targeted worker test passed after the correction, before the final full suite.

The first exit-report run had 23 passing tests but correctly returned failure because one report prefix omitted the article “a” in an existing passing test name. Correcting the report mapping did not change test or runtime behavior.

The state/time checkpoint is best effort for process crashes: up to one unpersisted checkpoint interval can be lost. A stale lock whose ownership/PID cannot be proved is left untouched. Unknown histories remain explicit S3 recovery conditions; no blind retry is introduced.
