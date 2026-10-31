# Codex Supervisor v0.1

This checkout implements S1 (#20) tickets #23–#25: validated startup and status, same-worker continuation with fixed judge fixtures, correlated turn confirmation, durable pause/resume and cumulative limits. It was rebuilt from baseline `5d640e5`; archived implementations were not used. SPEC delivery still requires independent review, main integration, cleanup, remote verification and tracker closure by the coordinating agent.

Requires Node.js 24 or later. Dependencies are locked in `package-lock.json`.

```powershell
npm ci --ignore-scripts --registry https://registry.npmjs.org
npm run build
npm test
node scripts/run-s1-start-demo.mjs
node scripts/run-s1-continuation-demo.mjs
node scripts/run-s1-exit.mjs
```

The demo starts the actual CLI as a child process, connects it to the explicit JSONL fixture, reaches `WAIT_EXTERNAL`, then runs `status`. It prints its new evidence directory under `runs/ticket23/`. Every result is marked `simulated`. The original task, state, events, snapshot, summary and protocol trace remain available there. A captured run is committed in `docs/evidence/ticket-23/sample/`.

The public commands currently available are:

```powershell
node dist/src/cli.js start --task D:\absolute\task.json
node dist/src/cli.js status --state D:\absolute\runs\task-id\state.json
node dist/src/cli.js resume --state D:\absolute\runs\task-id\state.json
```

`start` validates schema version 1, an existing absolute workspace, a goal, nonempty acceptance criteria and authorization. Optional verification configuration is preserved. Both limits default to `null`. Default state is `runs/<task_id>/state.json`; `--state` can choose an explicit file. An existing state cannot be overwritten. `status` only reads the saved state; it does not start Codex or a judge.

`--test-fixture <file>` explicitly injects an app-server argv array and a fixed judge result or ordered array of results. Optional `judge_delay_ms` exposes in-flight judging deterministically; `judge_ignores_cancellation: true` models a late success for bounded fault tests. `simulate_verification: true` enables only the cancellation fixture; it cannot accept a task as DONE. It labels the entire run `simulated` and is only for local deterministic acceptance. Production defaults use the installed native Codex executable. No fake judge result is selected by default.

Each continuation saves a complete message with a delivery ID before sending. A matching RPC result confirms its actual turn ID. When the response is late or missing, the supervisor correlates an observed `turn/started` with a separate `userMessage.clientId` item for the pending delivery; an unrelated same-thread start is insufficient. One notification pump queues protocol events and request results, so a completed turn can be judged before its RPC response arrives. Duplicate, foreign and obsolete events cannot create additional work. Judge input is saved before the asynchronous judgment starts. A lost connection with an unknown send outcome preserves the sent action in `ACTIVE/RECOVERING` and exits with an explicit error; it never blindly resends. Automatic reconnect/history reconciliation is an S3 deliverable.

The protocol baseline is Codex CLI **0.166.0**. Other versions fail startup until their generated stable protocol and behavior have been checked. The launcher disables apps, plugins, hooks, multi-agent, browser/computer tools, memories and web search for its own processes. A discovery connection reads effective MCP names without creating threads; the second connection disables every inherited server and verifies effective settings. It checks the returned worker approval policy, workspace, writable roots and restricted network policy before starting the first turn. Global configuration is never changed.

Task exclusivity uses both a state-file lock and a lock keyed by the canonical workspace and task ID under the system temporary directory. Thus another `--state` cannot bypass the active-task lock. State writes use a temporary file and atomic rename; the event log is append-only. Snapshot IDs are locally generated UUIDs. Credential-shaped output is redacted before evidence is passed to the judge or logged.

Ctrl+C first saves `PAUSED`, increments the task version, records ACTIVE time and clears unsent actions/retries, then interrupts the owned worker and closes the owned app-server. The judge boundary supports cancellation. Late results cannot overwrite PAUSED. A sent delivery whose outcome is unknown is retained for reconciliation.

`resume --state FILE` uses the saved task contract and original worker ID. It never rereads the original input file implicitly. Explicit `--task FILE` can update the contract while preserving task ID and workspace. Resume increments the version and retains cumulative worker turns and ACTIVE seconds. DONE cannot reopen. ACTIVE time is checkpointed every 100 ms while the process runs; a crash can lose the unfinished checkpoint interval. A live lock prevents resume; explicit resume can reclaim a matching task/state lock only after proving its recorded PID is absent. It never kills another supervisor. An ambiguous or unprovable lock remains an error.

`max_worker_turns` stops before sending a round beyond the configured total. `max_minutes` stops at the cumulative ACTIVE duration, including judge/recovery time while this process runs. Reaching either limit saves `PAUSED/user_limit`; resume requires an explicit raised/removed limit. Both default to `null`.

Resume can review a known completed turn or continue observing a known in-progress turn returned by `thread/resume`. An interrupted known turn permits a fresh input. Unknown sent deliveries and absent saved turns remain `ACTIVE/RECOVERING` with an explicit S3 reconciliation error and no resend. Full reconnect, paginated history reconciliation and crash windows remain S3 scope.

This checkout does not yet deliver a real semantic judge or protected independent verification (S2), or automatic recovery/history reconciliation (S3). Fixed DONE is refused when independent verification is configured; the S1 verification fixture tests only cancellation. A normal live worker can execute its first turn, but live judging currently reports an explicit unimplemented error and preserves an `ACTIVE/RECOVERING` checkpoint. Do not use simulated success to claim live task completion.

See `docs/evidence/ticket-23/README.md` for the test seam, observed red/green results, captured run and limits of the no-model live preflight.
See `docs/evidence/ticket-24/README.md` for deterministic continuation evidence and its limits.
See `docs/evidence/ticket-25/README.md` and `docs/evidence/ticket-25/final/report.json` for the S1 simulated exit report. For a manual console interrupt against the simulated backend, run `node scripts/prepare-s1-pause-fixture.mjs worker` (or `judge` / `verification`), execute the printed argv, then press Ctrl+C. Those phases hold for 120 seconds. The backend remains simulated even when the console signal is real.
