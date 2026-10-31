# Codex Supervisor v0.1

This checkout delivers tickets #23 and #24 of S1 (#20): validated startup and status, same-worker continuation with fixed judge fixtures, correlated turn confirmation and stable simulated DONE. It was rebuilt from baseline `5d640e5`; archived implementations were not used.

Requires Node.js 24 or later. Dependencies are locked in `package-lock.json`.

```powershell
npm ci --ignore-scripts --registry https://registry.npmjs.org
npm run build
npm test
node scripts/run-s1-start-demo.mjs
node scripts/run-s1-continuation-demo.mjs
```

The demo starts the actual CLI as a child process, connects it to the explicit JSONL fixture, reaches `WAIT_EXTERNAL`, then runs `status`. It prints its new evidence directory under `runs/ticket23/`. Every result is marked `simulated`. The original task, state, events, snapshot, summary and protocol trace remain available there. A captured run is committed in `docs/evidence/ticket-23/sample/`.

The public commands currently available are:

```powershell
node dist/src/cli.js start --task D:\absolute\task.json
node dist/src/cli.js status --state D:\absolute\runs\task-id\state.json
```

`start` validates schema version 1, an existing absolute workspace, a goal, nonempty acceptance criteria and authorization. Optional verification configuration is preserved. Both limits default to `null`. Default state is `runs/<task_id>/state.json`; `--state` can choose an explicit file. An existing state cannot be overwritten. `status` only reads the saved state; it does not start Codex or a judge.

`--test-fixture <file>` explicitly injects an app-server argv array and a fixed judge result or ordered array of results. Optional `judge_delay_ms` exposes in-flight judging deterministically. It labels the entire run `simulated` and is only for local deterministic acceptance. Production defaults use the installed native Codex executable. No fake judge result is selected by default.

Each continuation saves a complete message with a delivery ID before sending. A matching RPC result confirms its actual turn ID. When the response is late or missing, the supervisor correlates an observed `turn/started` with a separate `userMessage.clientId` item for the pending delivery; an unrelated same-thread start is insufficient. One notification pump queues protocol events and request results, so a completed turn can be judged before its RPC response arrives. Duplicate, foreign and obsolete events cannot create additional work. Judge input is saved before the asynchronous judgment starts. A lost connection with an unknown send outcome preserves the sent action in `ACTIVE/RECOVERING` and exits with an explicit error; it never blindly resends. Automatic reconnect/history reconciliation is an S3 deliverable.

The protocol baseline is Codex CLI **0.166.0**. Other versions fail startup until their generated stable protocol and behavior have been checked. The launcher disables apps, plugins, hooks, multi-agent, browser/computer tools, memories and web search for its own processes. A discovery connection reads effective MCP names without creating threads; the second connection disables every inherited server and verifies effective settings. It checks the returned worker approval policy, workspace, writable roots and restricted network policy before starting the first turn. Global configuration is never changed.

Task exclusivity uses both a state-file lock and a lock keyed by the canonical workspace and task ID under the system temporary directory. Thus another `--state` cannot bypass the active-task lock. State writes use a temporary file and atomic rename; the event log is append-only. Snapshot IDs are locally generated UUIDs. Credential-shaped output is redacted before evidence is passed to the judge or logged.

This checkout does not yet deliver resume/Ctrl+C/limits acceptance (#25), a real semantic judge or independent verification (S2), or automatic recovery/history reconciliation (S3). Fixed DONE is refused when independent verification is configured; failed/interrupted worker terminals enter recovery rather than passing the fixed DONE judge. A normal live worker can execute its first turn, but live judging currently reports an explicit unimplemented error and preserves an `ACTIVE/RECOVERING` checkpoint. This is not a completed S1 or v0.1 release. Do not use this intermediate checkout to claim live task completion.

See `docs/evidence/ticket-23/README.md` for the test seam, observed red/green results, captured run and limits of the no-model live preflight.
See `docs/evidence/ticket-24/README.md` for deterministic continuation evidence and its limits.
