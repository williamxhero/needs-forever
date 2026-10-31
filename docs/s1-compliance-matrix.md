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
| T05 stable DONE, no re-opening | #24/#25 | Repeated terminal notification after fixed valid DONE; explicit resume refusal remains #25 | PASS simulated duplicates; resume not_run |
| T07 in-flight/already-handled dedupe, stale/foreign events | #24/#25 | Duplicate/out-of-order/foreign injections and late old-delivery failure; pause-version gate remains #25 | PASS simulated notifications; pause not_run |
| Unknown delivery retained, no blind resend | #24/#25 | Lost start response preserves sent action and RECOVERING, one wire send; checkpoint resume remains #25 | PASS simulated disconnect; resume not_run |
| T08 pause during worker, fixed judge, verification fixture | #25 | Three simulated CLI runs, cancellation and late-result assertions | not_run |
| Exact original worker ID/task on explicit resume | #25 | Modified input source ignored unless --task is explicit | not_run |
| Task version, ACTIVE and expected-turn asynchronous gates | #25 | Late judge, verification, recovery and send confirmation injections | not_run |
| Cumulative explicit limits; no default total limits | #25 | Restart with preserved totals; user_limit requires raised limit | not_run |
| Run instructions, task example, protocol test entry, sample artifacts | #23–#25 | Reproducible commands and retained red/green/acceptance output | not_run |
| Independent Standards and Spec reviews, findings resolved | S1 exit | Separate reviewer reports against baseline `5d640e5` | not_run |
| Main merge, safe cleanup, push, remote equality | S1 delivery | Commit IDs, ancestry checks, clean worktrees, ls-remote equality | not_run |

The S1 exit gate requires every row to be satisfied, with simulated results
labelled as such. No S2 implementation begins before S1 delivery. The real judge,
protected verifier and full input policy belong to S2; full retry and recovery
belong to S3. Pending capabilities must not be represented as implemented or
passed.
