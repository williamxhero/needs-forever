# Ticket 31 evidence: recovery and complete acceptance

Ticket #31 is the final vertical slice for S3. It combines the existing S1/S2 evidence with the S3 recovery implementation, live foreground pause runs, and a live app-server process exit run.

## Reproduce

```powershell
npm ci --ignore-scripts --registry https://registry.npmjs.org
npm test
npm run build
node scripts/run-ticket31-live.mjs runs/ticket31-live/<run> --phase WORKER
node scripts/run-ticket31-live.mjs runs/ticket31-live/<run> --phase JUDGE
node scripts/run-ticket31-live.mjs runs/ticket31-live/<run> --phase VERIFY
node scripts/run-ticket31-live.mjs runs/ticket31-live/<run> --t11
```

The committed harness is deterministic and process-safe. The committed live T08 evidence under `final/t08-pty/` was captured separately in a real Windows PTY: each phase received an actual console Ctrl+C, exited through the normal signal path, and persisted `PAUSED` before owned calls were cancelled. The harness's stdin control-byte path remains available for unattended reproduction when a PTY is not available.

The T11 run waits until a real worker turn has completed, kills the owned native app-server process, and verifies one reconnect, the same worker thread ID, preserved artifacts, and final independent verification. Killing the server before the first turn is persisted is retained as negative evidence because the native thread store can legitimately contain an empty rollout at that point.

## Evidence layout

- `final/t08-pty/worker`, `final/t08-pty/judge`, `final/t08-pty/verification`: live PAUSED states and event logs for the three real Ctrl+C windows.
- `final/t11`: live app-server process-exit recovery, including state, events, verifier and task.
- `final/report.json`: machine-readable T01–T15 matrix and exact command/version records.
- `final/matrix.md`: reviewer-facing matrix with reused evidence and limitations.

Simulated evidence is labelled as simulated and is never counted as live. Reused S1/S2 evidence names its source version and run directory.
