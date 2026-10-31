# Ticket #24: deterministic continuation

Scope: current S1 #20 only. The public seam is the real CLI subprocess connected to a separate simulated JSONL app-server and a fixed judge. These are simulated results, not live model judging or independent verification.

Three observed red/green slices are retained without reconstructing failures afterward:

Tracked `.txt` evidence is normalized to UTF-8 without BOM and LF line endings, with trailing whitespace removed from each line for Git diff checks. Diagnostic text, paths and results are preserved. Exact pre-normalization byte copies remain in the root workspace at `.scratch/new-workflow/ticket24-raw-text/`; the original sample also remains in the run directory identified below.

1. `red1.txt`: two early finishes failed because ticket #23 accepted only WAIT_EXTERNAL. `green1.txt`: all eight then-current tests passed after ordered fixed decisions, same-thread continuation and complete persisted messages were added.
2. `red2.txt`: started-without-response remained blocked until the fixture server exited. `green2.txt`: the target passed after request results and notifications entered one queue; empty-items started events are confirmed only with a separate matching userMessage.clientId.
3. `red3.txt`: a late failure from an already confirmed old delivery incorrectly cancelled the next worker. `green3.txt`: the target passed after stale delivery/version failure results were ignored.

Additional CLI coverage checks response-after-completion with duplicate, foreign-thread, unrelated same-thread and already handled events; an unknown send outcome retained as ACTIVE/RECOVERING without resend; failed worker terminals refused before judging; and saved judge input while a delayed result remains pending. `green-final.txt` records the final full suite, including all #23 regressions. The test for pending judging verifies only one saved snapshot despite duplicate terminal events.

Two full-suite attempts exposed Windows EPERM replacing state.json during concurrent read polling: the existing task-lock test (20 ms polling) and the pending-judge test (10 ms polling). Exact paths and stacks remain in `windows-rename-red.txt` and `windows-rename-red2.txt`; the lock test passed when run alone. This locates the failures at concurrent file replacement, but does not identify the process holding the Windows handle. The state store now retries the same atomic rename for up to five seconds with jitter, avoiding a fixed retry interval aligned with a polling reader. It preserves the old checkpoint and never unlinks it. The final full suite passed 14/14 after this change. Persistent external file locking beyond that bound remains an explicit failure, and one passing suite does not establish that all Windows filesystem contention has been eliminated.

Reproduce after `npm ci` and `npm run build`:

```powershell
npm test
node scripts/run-s1-continuation-demo.mjs
```

`sample/` contains the actual captured demo output: one worker ID, three distinct actual fixture turn IDs, two CONTINUE decisions followed by fixed DONE, protocol trace, checkpoints observed by the fixture at send time, append-only events, three judge snapshots and a read-only status result. The original run was `runs/ticket24/demo-1793464356278`; embedded absolute paths identify that original run, rather than a portable replay fixture.

The protocol fixture emits actual 0.166.0 notification shapes for the relevant fields: turn/started has empty items; userMessage.clientId is delivered separately as item/started. No server-side execution idempotency is claimed. Delivery IDs only correlate the supervisor's persisted message with observed input. Response IDs alone do not imply a turn started.

Limits: no real judge or independent verification, no automatic reconnect/history reconciliation, and no pause/resume/cumulative-limit acceptance yet. Those remain S2, S3 and current S1 ticket #25 respectively. In this intermediate version an unknown connection outcome saves an explicit checkpoint and returns failure; it is not an automatic recovery pass. S1 is still open pending its remaining ticket, independent review and required delivery gates.
