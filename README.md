# Codex Supervisor v0.1

The Needs Forever plugin defaults to supervising the current Desktop main session (#33). That session is worker A; an independent hidden Node.js process B controls synchronous Stop hooks and creates a fresh read-only supervisor C for each judgment. The core's original independent-worker mode remains available for existing checkpoints.

## Codex plugin

Install the bundled plugin from this repository:

```powershell
codex plugin marketplace add D:\WILL\TOOLS\needs-forever
codex plugin add needs-forever@needs-forever-local
codex plugin list --marketplace needs-forever-local --json
```

Review the plugin hooks in Codex Settings > Hooks and reload as required by the host. Invoke `$needs-forever:supervise` in the intended Desktop chat with the local task, acceptance criteria and authorization. For example: “用 $needs-forever:supervise 完成 D:/projects/example 的本地构建修复，验收使用现有 verify.mjs，仅授权修改该项目。” The skill writes the contract and runs installed `control.mjs start` from that workspace. Native pre/post hook receipts correlate this invocation to A; after binding, B starts automatically. Until that receipt exists, the task remains pending and must not be reported as supervised.

The installed `scripts/control.mjs` supports `doctor`, `start`, `status`, `pause` and `resume`, using Node.js >=24 without npm install or a checkout. Records default to `<workspace>/.codex-supervisor/<task_id>/state.json`. Other chats can query or pause a task; an already bound task resumes only through a fresh native receipt from the original A. `status` separately reports B reachability, host process presence, hook effectiveness and actual continuation confirmation. A returned direction alone does not prove A executed it. `DONE` cannot resume.

Supervision is opt-in through the skill's explicit start/resume command. Ordinary chats, doctor/status calls and natural-language mentions do not activate it; unrelated lifecycle callbacks return `{}` without task writes, B/C creation or continuation instructions. Released tasks stay neutral. The hook definitions contain no unconditional supervision status text. Desktop can still globally dispatch the hook script and show its own generic hook activity before the script checks the session; that host behavior is not evidence of supervision.

Interrupt or `pause` saves PAUSED before canceling owned judgment/verification. New native user input invalidates old judgment and pending direction without changing the contract or authorization. A hook timeout, host restart or bundle change requires explicit recovery. `resume` rotates the run and controller handles, preserves original A, artifacts, verifier baseline and cumulative limits, then waits for a new Stop. Unknown old deliveries are retained as audit history and never replayed. Leases are reclaimed only after matching their owner and proving ESRCH; no saved PID is killed.

The canonical manifest is `plugins/needs-forever/.codex-plugin/plugin.json`; `.agents/plugins/marketplace.json` exposes the package. `npm run plugin:build` regenerates its bundled JavaScript from the core. Commit the generated runtime with source changes: installations do not execute build scripts. `npm test` checks bundle parity and the isolated copied-package lifecycle. `node scripts/verify-plugin-install.mjs` verifies real CLI installation, skill/hook discovery and installed-package hashes in an isolated CODEX_HOME without starting a model.

Desktop and CLI versions are checked separately: the private C protocol remains pinned to CLI 0.166.0, while native Desktop hooks require their own actual-host verification and trust. `doctor` alone does not prove native hook support or trust. Main-session implementation evidence is under `docs/evidence/spec33/`; process-level replacement-host/model tests are simulated. Required real Desktop acceptance remains a separate release gate. See [the current architecture](docs/main-session-architecture.md) for boundaries and host limitations.

Candidate 0.3.0 uses `plugins/needs-forever/.codex-plugin/plugin.json` as its canonical manifest. Do not add an AgentPlugin root `plugin.json`: Desktop 0.159 selects that format first and deliberately omits plugin hooks. Fresh isolated installations using Desktop binary 0.159 and CLI 0.166 discover all six packaged hooks with `enabled=true, trustStatus=untrusted`; this proves discovery and package integrity only. Native execution in the running Desktop still requires the user's Hooks review and live acceptance.

For a no-model installation receipt, run `node scripts/verify-plugin-install.mjs --candidate ABSOLUTE_MARKETPLACE_ROOT --directory FRESH_PROBE_DIRECTORY --codex-argv '["ABSOLUTE_CODEX_EXECUTABLE"]'`. The script installs only into its isolated `CODEX_HOME`, records exact argv and package hashes, and reads skills/hooks without changing trust. Prepare the three-stage Desktop exercise with `node scripts/prepare-main-session-demo.mjs --directory FRESH_DEMO_DIRECTORY --plugin ABSOLUTE_INSTALLED_PLUGIN`; use its saved `desktop-launch-prompt.txt` in the intended Desktop chat after reviewing hooks. Preparation does not start a model or bind a chat.

Checkpoints without `control_mode` retain the original independent-worker behavior. New compatibility tasks require explicit `start --control-mode independent-worker`. The core CLI below is that legacy execution entry and rejects main-session checkpoints before acquiring or changing their worker state.

## Core CLI

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

Setting `real_judge: true` in that explicit fixture runs the production judge implementation against the replacement JSONL server. `judge_timeout_ms` can shorten its 120-second default solely for fault tests. These runs remain `simulated`; they do not claim actual AI model execution.

Each completed worker turn creates one fresh judge with `read-only`/`never`, verifies its returned policy and supplies the stable `outputSchema` on its turn. A single notification pump collects streamed completed items as well as terminal items. The judge is archived after termination, with its ID retained; an archive error is recorded without changing a valid decision. Timeout or cancellation settles the old owned connection before recovery. Recoverable failures use visible 5/15/60/300-second backoff, then reconnect and reconcile the original worker history before retrying.

`src/judge.ts` exports the exact runtime `decisionSchema` and `judgeInstructions`. Validation rejects fences/extra text, unknown fields or evidence IDs, invalid field combinations and unsupported terminal conclusions. DONE and WAIT_EXTERNAL need cited actual tool/change/verification evidence; a worker's claims alone do not qualify. Truncated evidence requires CONTINUE to gather concise proof. The semantic judge must assess every original acceptance item and whether other authorized work remains; shape validation alone does not prove those conclusions.

Judge input is limited to 24,000 serialized characters. It preserves the original goal, all acceptance items and authorization, prioritizes failure/change evidence, includes observed plans/remaining items, the latest recorded verification, the last two supervision instructions/results and repeated-failure hints. Three identical recovery failures rebuild the next snapshot with an explicit instruction to change the hypothesis, add a distinguishing check or use a different route. Every evidence ID points to an actual `events.jsonl` event/item. Missing material and truncation are explicit. An oversized mandatory contract produces an explicit error rather than silently shortening the goal or acceptance.

Each continuation saves a complete message with a delivery ID before sending. A matching RPC result confirms its actual turn ID. When the response is late or missing, the supervisor correlates an observed `turn/started` with a separate `userMessage.clientId` item for the pending delivery; an unrelated same-thread start is insufficient. One notification pump queues protocol events and request results, so a completed turn can be judged before its RPC response arrives. Duplicate, foreign and obsolete events cannot create additional work. Judge input is saved before the asynchronous judgment starts. A lost connection with an unknown send outcome preserves the sent action in `ACTIVE/RECOVERING`, reconnects the same worker and checks its history. The supervisor resends only after the saved history proves that delivery did not execute; an observed delivery is followed instead of duplicated.

The protocol baseline is Codex CLI **0.166.0**. Other versions fail startup until their generated stable protocol and behavior have been checked. The launcher disables apps, plugins, hooks, multi-agent, browser/computer tools, memories and web search for its own processes. A discovery connection reads effective MCP names without creating threads; the second connection disables every inherited server and verifies effective settings. It checks the returned worker approval policy, workspace, writable roots and restricted network policy before starting the first turn. Global configuration is never changed.

Task exclusivity uses both a state-file lock and a lock keyed by the canonical workspace and task ID under the system temporary directory. Thus another `--state` cannot bypass the active-task lock. State writes use a temporary file and atomic rename; the event log is append-only. Snapshot IDs are locally generated UUIDs. Credential-shaped output is redacted before evidence is passed to the judge or logged.

Ctrl+C first saves `PAUSED`, increments the task version, records ACTIVE time and clears unsent actions/retries, then interrupts the owned worker and closes the owned app-server. The judge boundary supports cancellation. Late results cannot overwrite PAUSED. A sent delivery whose outcome is unknown is retained for reconciliation.

`resume --state FILE` uses the saved task contract and original worker ID. It never rereads the original input file implicitly. Explicit `--task FILE` can update the contract while preserving task ID and workspace. Resume increments the version and retains cumulative worker turns and ACTIVE seconds. DONE cannot reopen. ACTIVE time is checkpointed every 100 ms while the process runs; a crash can lose the unfinished checkpoint interval. A live lock prevents resume; explicit resume can reclaim a matching task/state lock only after proving its recorded PID is absent. It never kills another supervisor. An ambiguous or unprovable lock remains an error.

Resume rereads and validates the checkpoint after acquiring the task lock; the earlier read supplies only its lock identity. Changing the goal or authorization requires an already persisted PAUSED checkpoint. A limits-only update can resume an ACTIVE checkpoint under the existing safeguards. A pending sent delivery is reconciled against resumed history before any resend.

`max_worker_turns` stops before sending a round beyond the configured total. `max_minutes` stops at the cumulative ACTIVE duration, including judge/recovery time while this process runs. Reaching either limit saves `PAUSED/user_limit`; resume requires an explicit raised/removed limit. Both default to `null`.

Resume can review a known completed turn or continue observing a known in-progress turn returned by `thread/resume`. An interrupted known turn permits a fresh input. Unknown sent deliveries remain pending until resumed history proves absence, after which a new delivery is prepared. A missing saved active turn remains an explicit recovery error with no resend.

Configured independent verification runs only after a valid DONE judgment, using the saved task's argv array directly through `command/exec`. Its explicit sandbox permits writes only in the task workspace, disables network and excludes temporary roots. Before the first worker turn, `protected_files` are saved with SHA-256 hashes and original content in `state.protected_baseline`; resume retains that baseline. Changed or missing protected files prevent execution or invalidate a successful check. The original worker receives the actual exit/stdout/stderr/hash evidence and original content needed for restoration, through the same durable sending entry.

The installed Windows 0.166.0 server reports a command timeout as an RPC error containing `sandbox error: command timed out`; measured probes show it terminates the command and leaves the server usable. That actual error is retained, redacted and returned to the worker. A command that fails to settle by its timeout plus one second is terminated by closing this program's owned app-server. Only then does this specific idle-worker path reconnect, verify the exact saved worker identity/policy and send the failure evidence. Other recoverable faults use the same bounded recovery loop and history reconciliation. Pause saves its state and version before cancellation; late verification cannot set DONE.

To prepare the isolated three-stage live exercise without starting a model, run `node scripts/prepare-s2-demo.mjs`. Its printed argv starts the live supervisor. The exercise includes a deliberately failing first route, an authorized direct-file alternative and a protected independent Node verifier. `node scripts/run-s2-simulated-demo.mjs` runs the same exercise through the replacement JSONL server, with actual local route/verifier subprocesses and simulated worker/judge decisions. The replacement server does not enforce the real Codex sandbox. Both entries retain state, events, snapshots and artifacts under their printed run directory.

Request handling and recovery/history reconciliation are covered by the S2/S3 implementation and deterministic fault fixtures. The S1 verification fixture still tests only cancellation. Deterministic ticket evidence does not constitute S2's required live T01–T05 acceptance.

See `docs/evidence/ticket-23/README.md` for the test seam, observed red/green results, captured run and limits of the no-model live preflight.
See `docs/evidence/ticket-24/README.md` for deterministic continuation evidence and its limits.
See `docs/evidence/ticket-27/README.md` for protected verification red/green evidence, its simulated exit report and demo entry.
See `docs/evidence/ticket-25/README.md` and `docs/evidence/ticket-25/final/report.json` for the S1 simulated exit report. For a manual console interrupt against the simulated backend, run `node scripts/prepare-s1-pause-fixture.mjs worker` (or `judge` / `verification`), execute the printed argv, then press Ctrl+C. Those phases hold for 120 seconds. The backend remains simulated even when the console signal is real.
