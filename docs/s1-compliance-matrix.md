# S1 / #20 acceptance map

This map applies only to the fresh development beginning at `5d640e5`.
Earlier implementation tests are not evidence for this delivery.

| Required behavior | Ticket | Acceptance evidence | Current result |
| --- | --- | --- | --- |
| Public start/status and schema version 1 task snapshot | #23 | `docs/evidence/ticket-23/`, independent receipt `docs/delivery/ticket23-merger.json` | PASS simulated at `7671cd2` |
| Exact installed protocol, initialization, matched request IDs | #23 | Codex 0.166.0 generated types compared by merger; recorded fixture wire trace | PASS provenance and simulated wire audit |
| Per-process isolation and explicit worker sandbox/approval | #23 | Effective-config no-model live preflight; returned worker policy and rejection of expanded sandbox in CLI fixture | PASS simulated worker; no-model live config probe only |
| Atomic state, append-only events, snapshots, summary, task lock | #23 | Captured public output files, concurrent CLI exclusion, Windows rename correction; merger rerun | PASS simulated at `7671cd2` |
| T01 same-worker continuation | #24 | `docs/evidence/ticket-24/`, independent receipt `docs/delivery/ticket24-merger.json` | PASS simulated |
| T02 two consecutive premature completions | #24 | Two CONTINUE decisions and three server-confirmed turns in one worker | PASS simulated |
| Pure fixed rules and one sendNext path | #24 | Rules/controller source plus public continuation evidence | PASS simulated; S3 error recovery pending |
| Prepared before sending; correlation ID; confirmed turn ID | #24 | Fixture checks persisted full action before wire send; started+clientId also works without response | PASS simulated |
| T05 stable DONE, no re-opening | #24/#25 | Repeated terminal notification and explicit resume refusal | PASS simulated |
| T07 in-flight/already-handled dedupe, stale/foreign events | #24/#25 | Duplicate/out-of-order/foreign injections, old-delivery failure and late judge | PASS simulated |
| Unknown delivery retained, no blind resend | #24/#25 | Lost response and explicit resume retain sent action in RECOVERING | PASS simulated; full reconciliation remains S3 |
| T08 pause during worker, fixed judge, verification fixture | #25 | CLI suite and actual Windows PTY Ctrl+C at `5fa39fc`, `docs/evidence/s1-pty-final/` | PASS simulated backend with real OS signal |
| Exact original worker ID/task on explicit resume | #25 | Modified input source ignored unless --task is explicit; DONE refusal | PASS simulated |
| Task version, ACTIVE and expected-turn asynchronous gates | #25 | Late judge/verification/send guards and ACTIVE replacement rejection | PASS simulated |
| Cumulative explicit limits; no default total limits | #25 | Cross-restart totals, raised-limit admission and ACTIVE time checkpoints | PASS simulated |
| Run instructions, task example, protocol test entry, sample artifacts | #23–#25 | README, examples and six retained sample runs; 24/24 final suite at `6094b40` | PASS |
| Independent Standards and Spec reviews, findings resolved | S1 exit | `docs/delivery/s1-review.md`; both independent rechecks of `6094b40` | PASS, zero remaining findings |
| Main merge, safe cleanup, push, remote equality | S1 delivery | `docs/delivery/s1-delivery.json`; main and remote `de23e6a`, three worktrees archived and five merged branches deleted | PASS |

The S1 exit gate requires every row to be satisfied, with simulated results
labelled as such. No S2 implementation begins before S1 delivery. The real judge,
protected verifier and full input policy belong to S2; full retry and recovery
belong to S3. Pending capabilities must not be represented as implemented or
passed.

S1 is now delivered: #23/#24/#25 and #20 were read back CLOSED/completed,
and #19's S1 todo agrees. Only after that confirmation did current S2 begin.
