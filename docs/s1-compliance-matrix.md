# S1 / #20 acceptance map

This map applies only to the fresh development beginning at `5d640e5`.
Earlier implementation tests are not evidence for this delivery.

| Required behavior | Ticket | Acceptance evidence | Current result |
| --- | --- | --- | --- |
| Public start/status and schema version 1 task snapshot | #23 | CLI process with simulated JSONL server; saved original contract | not_run |
| Exact installed protocol, initialization, matched request IDs | #23 | Generated stable types and fake-server wire audit; record installed version | not_run |
| Per-process isolation and explicit worker sandbox/approval | #23 | Effective configuration plus returned worker policy checks | not_run |
| Atomic state, append-only events, snapshots, summary, task lock | #23 | Public output files and concurrent CLI process | not_run |
| T01 same-worker continuation | #24 | Confirmed next turn from actual fake-server response/event | not_run |
| T02 two consecutive premature completions | #24 | Two decisions and two distinct confirmed turns, one worker ID | not_run |
| Pure fixed rules and one sendNext path | #24 | Source inspection plus public continuation evidence | not_run |
| Prepared before sending; correlation ID; confirmed turn ID | #24 | Protocol boundary inspects already persisted action | not_run |
| T05 stable DONE, no re-opening | #24 | Repeated terminal notification after fixed valid DONE | not_run |
| T07 in-flight/already-handled dedupe, stale/foreign events | #24 | Fake-server duplicate, out-of-order and foreign-thread injections | not_run |
| Unknown delivery retained, no blind resend | #24/#25 | Lost start response and checkpoint resume; no duplicate turn/start | not_run |
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
