# NFG module extraction and pi-nf task source

## Delivered

- `src/web.ts` was split into `src/NFG/`:
  - `types.ts` — the existing NFG read model (`TaskSummary`, `TaskRecord`, `TaskStateView`, `WorkRound`, ...).
  - `projection.ts` — Codex state/event projection (`stateView`, `makeRounds`, `routeAuditForRound`, recovery projection).
  - `catalog.ts` — task discovery across `.codex-supervisor` and `.pi-nf`, with a `source` discriminator.
  - `server.ts` — `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/control`, `/tasks/*` page.
  - `ui.ts` — the served page and client script.
  - `pi-nf.ts` — read-only adapter for pi-nf audit projections.
- `src/web.ts` was deleted; CLI, daemon CLI, root exports and tests import `./NFG/index.js`.
- The plugin runtime now ships `runtime/src/NFG/`, and the committed runtime manifest/integrity/receipt were regenerated (49 modules).

## pi-nf tasks in NFG

- NFG discovers `<workspace>/.pi-nf/<task_id>/audit.json` in every registered workspace.
- The file is pi-nf's own read-only audit projection (pi-nf recomputes it from committed
  pi-durable documents/entries and never reads it back). NFG maps it onto the fields NFG
  already has; no NFG display field was added.
- Rounds render as: A completed a run (`nf.judge_started`), the supervisor judgment
  (`decision`, including the C2 route audit), and the direction delivery
  (`send_prepared`/`send_confirmed`). "WORKER 收到" is only shown when pi-nf recorded the
  direction submission as `placed` or `done`.
- pi-nf tasks are read-only in NFG: the record API returns `readOnly: true`, the page hides
  pause/resume/delete, and `POST /api/tasks/<id>/control` returns 409. Those operations
  need the pi-nf writer lease and stay with the pi-nf CLI.
- Duplicate task IDs keep the Codex source; malformed projections are not discoverable.

## Runtime packaging fix

`verifyInstalledRuntime` resolved manifest paths to integrity entries by suffix, which is
ambiguous once the runtime contains nested modules (`src/index.js` and `src/NFG/index.js`
both end with `/index.js`). It now resolves the runtime directory prefix as a whole and
requires exactly one complete mapping.

## Verification

- `npm test`: 317/319 pass. The two failures are the pre-existing PowerShell cases that
  spawn `pwsh.exe`, which is not installed in this environment; they do not touch NFG.
- `test/web.test.ts`: 21/21, unchanged Codex projection behavior and controls.
- `test/pi-nf.test.ts`: 4/4, covering catalog projection, read-only API/control, served
  client rendering and malformed projections.
- `test/install-discovery.test.js` and `test/plugin.test.js`: pass with the nested runtime.
- End-to-end: a real pi-nf SQLite task (faux worker/judge) published `audit.json`; NFG
  listed it, rendered two rounds with the C2 route audit, and rejected control with 409.
  The temporary run directory was removed.

## Limits

- This is not live model/provider or Desktop acceptance.
- NFG shows pi-nf only when the task workspace is registered with the daemon
  (`--workspace`) and pi-nf published its projection there (or with `--out`).
- NFG does not drive pi-nf pause/resume/delete; `audit.json` is display-only.
