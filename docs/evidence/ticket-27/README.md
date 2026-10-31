# Ticket #27: fixed independent verification

This implementation remains inside the current S2 #21 SPEC. S1 #20 was delivered first. `/to-tickets` was revalidated by the coordinating agent before this ticket became ready. The implementer loaded the installed `implement-spec-to-done`, `implement-spec`, `tdd`, `tests.md` and `mocking.md` files and followed them; no dedicated Skill-tool invocation is claimed. Implementation began on `ticket/27-redo` from integration commit `b4336b030f015d3a18b6432bedf3aecc0c2476cb` and incorporated the later integration documentation through `62a463c`.

The agreed public boundary is the actual CLI subprocess, replacement JSONL app-server, public checkpoint/events/snapshots, artifacts and process lifecycle. The replacement server and all model choices are **simulated**. The demo's failing-route and verifier commands are actual local Node subprocesses; the replacement server does not enforce the Codex sandbox.

## Observed red/green slices

1. The fixed-argv test first failed with `Independent verification is delivered by S2; fixture DONE cannot bypass configured verify.` after dependencies were installed and the test compiled. The first green implemented the verifier and pre-worker protected baseline. That initial red was observed in tool output; it is not retroactively presented as a saved raw run.
2. `server-timeout-red.txt` failed because the server's actual timeout error escaped and exited the CLI. `server-timeout-green.txt` passed after preserving the redacted RPC message and returning the recognized command-timeout evidence to the original worker on the still-healthy connection. A generic RPC code alone is not classified as a timeout.
3. `malformed-result-red.txt` showed an exitCode-only response incorrectly reaching DONE. `malformed-result-green.txt` passed once missing stdout/stderr and noninteger exit codes were rejected.
4. `protected-restore-red.txt` showed that hashes alone did not give the worker the original protected content. `protected-restore-green.txt` passed after the failure instruction included saved original content and expected SHA-256 for restoration.
5. `hung-verification-red.txt` exceeded the test's 20-second safety timeout when a server ignored the requested command deadline. `hung-verification-green.txt` passed with the deadline-plus-one-second watchdog, confirmed exit of the owned server, exact saved-worker resume and failure delivery before eventual completion. The fixture was corrected to preserve globally unique worker-turn identities across its simulated connections; a real server does not recycle turn IDs.

The nonzero T04, before/during/missing protected files, resume baseline and PAUSED cases are behavioral regression coverage of those vertical slices. No failing result is invented for tests that passed when first added.

## Final acceptance and reproducible entries

`final/report.json` and `final/tests.tap` record **48/48 simulated PASS**: all 24 S1 tests, all 14 ticket #26 judge tests and 10 verification tests. Its samples preserve the actual final runs' task, state, events, protocol, snapshots, summary and workspace files. Run after building:

```powershell
npm run build
node scripts/run-s2-verification-exit.mjs
node scripts/run-s2-simulated-demo.mjs
node scripts/prepare-s2-demo.mjs
```

`demo/report.json` records three worker turns on one worker identity with `CONTINUE`, `CONTINUE`, `DONE`. The deliberately failing first route returned 23, its marker survived, all three artifacts were produced and the protected fixed verifier independently returned 0. The prepared live entry prints a fresh task/state/workspace and argv without starting a model. The full three-stage goal remains present; the worker's exercise contract limits each turn to one unfinished stage.

The implementation stores each original protected file's bytes as base64 and its SHA-256 in `state.protected_baseline` before creating the worker. Explicit resume retains that baseline and, without `--task`, the saved argv. Before/after comparisons reject changes and missing files, and the original worker receives failure evidence through `sendNext`. A nonzero result cannot complete; a zero result also requires unchanged hashes and the still-current ACTIVE/version gate. PAUSED is persisted before cancellation and wins over late verification.

`../s2-protocol/timeout.json` separately records the real installed Windows 0.166.0 behavior: server-side timeout is RPC `-32603` with `sandbox error: command timed out`, child execution is stopped and that connection remains usable. `../s2-protocol/findings.md` records that stable `command/exec/terminate` is unsupported here and closing the owned server terminates its command. The implementation uses that scoped fallback for a genuinely unsettled independent call; it does not implement general S3 fault/history recovery.

All final public-boundary tests are simulated. Live T01–T05, request handling #28, independent review, main delivery, remote equality and Issue closure remain coordinating S2 gates and are **not_run by this ticket**.

## Evidence handling

Ignored raw runs remain under this worktree's `runs/ticket27/` and `runs/ticket27-demo/` for the merger to back up before cleanup. Committed PowerShell text transcripts normalize CRLF to LF and remove trailing whitespace; no outcome text is changed. The final report's test TAP is normalized by its runner. Runtime JSON, JSONL and protected workspace content are copied from actual final runs without content rewriting. The original two published Spec files are unchanged.
