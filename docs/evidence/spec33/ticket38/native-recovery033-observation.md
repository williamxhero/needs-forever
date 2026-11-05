# Native recovery observation (read-only)

Original A: `01a1a0bf-c5d2-74e0-9eae-cf2d38a20cb7`; recovery turn `01a1a156-2103-7da1-8e73-b3f6dd81a78d`.

- T04 route: original rollout line 469, actual chunk `0496ae`, exit 23; marker exact `unavailable-route exit 23\n`. One matching execution event. First final line 474 (12:18:24.542Z) precedes real C hook prompt line 477 (12:18:52.261Z).
- C1 direction event `d2f2b3c1…` authorizes direct-file alternative. A tool `exec-d521bae6…` / event `d5bde17a…` writes exact payload; continuation event `e95e1642…` confirms original A and same turn executed.
- C2 rejected insufficient historical proof; C3 rejected truncated 24k-budget evidence. A gathered concise actual transcript evidence; C4 `33d37ac9…` accepted R1-R3 as DONE.
- B independently executed fixed argv, real exit 17 and `INDEPENDENT_GATE_NOT_READY`, `workspace_changed=false`. A subsequently created exact `ready\n` and local same-argv verifier exited 0. This local success does not establish final B success.
- Historical receipt `native-minimal-runtime-fix033.json` observed six original artifact/script/marker hashes at 12:16:35.419Z, before the first recovery tool. All six still match. Do not claim a historical nineteen-file hash manifest: the wider check uses A mtime and its local before/after comparison.
- T08 parent pause at 12:38:08.290Z: state PAUSED/IDLE/BOUND; C5 termination event at 12:38:08.340Z; C5 interrupted; original A completed and idle. C5 archived=false in SQLite at this observation. No late direction/decision/verifier result observed after pause. Observer did not resume.

Selected event IDs, exact timestamps, hashes, and limitations are in the companion JSON. At that observation the task was intentionally paused before final independent B verification; the explicit resume and completion below supersede that provisional status.

Pause stability recheck at 12:42:24.633Z: still PAUSED/IDLE with unchanged state timestamp and 53 events; no late decision, verifier, continuation or resume event. C5 remains unarchived.

## Explicit same-A resume and final independent pass

Parent explicitly instructed original A to resume the same checkpoint. New A turn `01a1a16e-b0eb-7581-9fbe-34889a730f62` executed installed resume; original rollout result line 659/chunk `b43b97` returned exit0 with `PENDING_NATIVE_HOOK` before the fresh correlated native receipt.

- Resume preparation `bca6d5f7…`, 12:42:58.973Z; new generation `6d90ebe1-95d0-4c47-bd99-43bf2739ba81`, original A unchanged.
- Fresh binding `03d80b9b…`, 12:43:03.450Z; operation `resume`, native tool `exec-9a779b50-f796-4343-8a9c-f84690602dd6`. New B PID 47668 started 12:43:04.932Z.
- A concise recheck `f6e747d1…` preserved original evidence and scripts, without running verifier in this response. New C `01a1a170-b5df-7250-aaa5-c7adece96582` completed and archived; decision `da51bca6…` DONE at 12:45:36.241Z.
- Actual B-owned verification `736673d5…`, 12:45:44.591Z, fixed argv `node .spec33-recovery/verify-recovery.mjs`, exit0, passed=true, workspace_changed=false. Output: `PASS original failed route; PASS direct-file recovery; PASS independent repair gate`.
- Terminal `752d55d1…` DONE at 12:45:44.649Z. Final state DONE/IDLE/RELEASED; controller lifecycle exited, PID47668 absent via Get-Process. Original A new turn completed at 12:45:44Z; thread idle. Six historical original-file hashes still match; both recovery protected hashes unchanged.

T06 actual independent failure → repair → independent success is complete. T08 actual JUDGE pause → no automatic resume → explicit same-A resume is evidenced. C5 from the paused judgment remains unarchived; resumed C6 was archived. No successful VERIFY-phase pause is claimed: the parent reported watcher2 failed reading an atomic replacement with PermissionError and produced no pause receipt.
