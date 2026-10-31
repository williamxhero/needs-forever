# Codex Supervisor v0.1

This checkout currently delivers ticket #23 of S1 (#20): task validation, an isolated app-server handshake, the first worker turn, persisted state, and read-only status. It was rebuilt from baseline `5d640e5`; archived implementations were not used.

Requires Node.js 24 or later. Dependencies are locked in `package-lock.json`.

```powershell
npm ci --ignore-scripts --registry https://registry.npmjs.org
npm run build
npm test
node scripts/run-s1-start-demo.mjs
```

The demo starts the actual CLI as a child process, connects it to the explicit JSONL fixture, reaches `WAIT_EXTERNAL`, then runs `status`. It prints its new evidence directory under `runs/ticket23/`. Every result is marked `simulated`. The original task, state, events, snapshot, summary and protocol trace remain available there. A captured run is committed in `docs/evidence/ticket-23/sample/`.

The public commands currently available are:

```powershell
node dist/src/cli.js start --task D:\absolute\task.json
node dist/src/cli.js status --state D:\absolute\runs\task-id\state.json
```

`start` validates schema version 1, an existing absolute workspace, a goal, nonempty acceptance criteria and authorization. Optional verification configuration is preserved. Both limits default to `null`. Default state is `runs/<task_id>/state.json`; `--state` can choose an explicit file. An existing state cannot be overwritten. `status` only reads the saved state; it does not start Codex or a judge.

`--test-fixture <file>` explicitly injects an app-server argv array and fixed judge result. It labels the entire run `simulated` and is only for local deterministic acceptance. Production defaults use the installed native Codex executable. No fake judge result is selected by default.

The protocol baseline is Codex CLI **0.166.0**. Other versions fail startup until their generated stable protocol and behavior have been checked. The launcher disables apps, plugins, hooks, multi-agent, browser/computer tools, memories and web search for its own processes. A discovery connection reads effective MCP names without creating threads; the second connection disables every inherited server and verifies effective settings. It checks the returned worker approval policy, workspace, writable roots and restricted network policy before starting the first turn. Global configuration is never changed.

Task exclusivity uses both a state-file lock and a lock keyed by the canonical workspace and task ID under the system temporary directory. Thus another `--state` cannot bypass the active-task lock. State writes use a temporary file and atomic rename; the event log is append-only. Snapshot IDs are locally generated UUIDs. Credential-shaped output is redacted before evidence is passed to the judge or logged.

Ticket #23 does not yet deliver continuation/completion gates (#24), resume/Ctrl+C/limits acceptance (#25), a real semantic judge or independent verification (S2), or automatic recovery/history reconciliation (S3). A normal live worker can execute its first turn, but live judging currently reports an explicit unimplemented error and preserves an `ACTIVE/RECOVERING` checkpoint. This is not a completed S1 or v0.1 release. Do not use this intermediate checkout to claim live task completion.

See `docs/evidence/ticket-23/README.md` for the test seam, observed red/green results, captured run and limits of the no-model live preflight.
