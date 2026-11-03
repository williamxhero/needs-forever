# Native recovery observation (read-only)

Original A: `01a1a0bf-c5d2-74e0-9eae-cf2d38a20cb7`; recovery turn `01a1a156-2103-7da1-8e73-b3f6dd81a78d`.

- T04 route: original rollout line 469, actual chunk `0496ae`, exit 23; marker exact `unavailable-route exit 23\n`. One matching execution event. First final line 474 (12:18:24.542Z) precedes real C hook prompt line 477 (12:18:52.261Z).
- C1 direction event `d2f2b3c1…` authorizes direct-file alternative. A tool `exec-d521bae6…` / event `d5bde17a…` writes exact payload; continuation event `e95e1642…` confirms original A and same turn executed.
- C2 rejected insufficient historical proof; C3 rejected truncated 24k-budget evidence. A gathered concise actual transcript evidence; C4 `33d37ac9…` accepted R1-R3 as DONE.
- B independently executed fixed argv, real exit 17 and `INDEPENDENT_GATE_NOT_READY`, `workspace_changed=false`. A subsequently created exact `ready\n` and local same-argv verifier exited 0. This local success does not establish final B success.
- Historical receipt `native-minimal-runtime-fix033.json` observed six original artifact/script/marker hashes at 12:16:35.419Z, before the first recovery tool. All six still match. Do not claim a historical nineteen-file hash manifest: the wider check uses A mtime and its local before/after comparison.
- T08 parent pause at 12:38:08.290Z: state PAUSED/IDLE/BOUND; C5 termination event at 12:38:08.340Z; C5 interrupted; original A completed and idle. C5 archived=false in SQLite at this observation. No late direction/decision/verifier result observed after pause. Observer did not resume.

Selected event IDs, exact timestamps, hashes, and limitations are in the companion JSON. This task remains intentionally paused before final independent B verification.
