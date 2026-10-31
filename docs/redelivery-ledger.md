# Codex Supervisor v0.1 redelivery

Restart requested by the user on 2026-10-31 (Asia/Singapore).

The previous attempt implemented S1 before its implementation tickets were
approved and published, then started S2 before S1 delivery. That attempt does not
count as accepted implementation or acceptance evidence.

## Baseline and preserved work

- Restart baseline: `5d640e5781adadfcd42c3e8806129b1b3050e0d6` (`main`).
- Fresh S1 integration branch: `spec/20-s1-redo`.
- Earlier integration is retained as `archive/pre-redo-supervisor-v01`.
- Earlier S1 and unfinished S2 managed worktrees were archived with recoverable
  snapshots. Their source is not used by the fresh implementation.
- Earlier generated `dist` output was moved into ignored restart archives so it
  cannot enter the new test run.
- The two original Markdown specifications remain unchanged. Their SHA256 values
  are `74444ECF532919C1D48BC3081FC27253C5E921E4D7BC15A8A2ABA10ECF8B9F00`
  and `D3BD138C3BE2D409FFC8CDF0956858EC86BF7BEF03980149CCEE24EB4F9F58D1`.

## Authorized workflow

The user approved all ticket breakdown decisions, including future breakdowns;
no additional granularity approval is required. This does not waive any technical
exit gate or delivery requirement.

For each child SPEC: publish tickets and native relationships, implement the
unblocked ticket frontier in separate worktrees using TDD, integrate with a
merger agent, verify the SPEC, run independent Standards and Spec reviews, fix
findings, merge to main, safely remove only delivered temporary resources, push,
and verify local/remote equality. S2 implementation starts after S1 delivery;
S3 implementation starts after S2 delivery.

Public test seam: CLI process to simulated app-server protocol, with persisted
state/events and process lifecycle as observable outputs. This is the seam
defined in #20 and covered by the approved breakdown. Results must distinguish
simulated, live, and not_run.

## S1 / #20 ticket graph

| Ticket | Behavior | Blocked by | Status |
| --- | --- | --- | --- |
| #23 | Start a task and query durable execution state | None | In progress |
| #24 | Same-thread continuation, confirmed sending, stable terminal state | #23 | Not started |
| #25 | Pause, explicit resume, cumulative limits and S1 exit acceptance | #24 | Not started |

All three tickets are native sub-issues of #20, carry `ready-for-agent`, and
have native blocked-by relationships. Published bodies were uploaded from UTF-8
without BOM files and compared exactly after readback, including GitHub's CRLF
line endings. Publication receipts are retained under ignored `.scratch/redo`.

## Approved future ticket graph

| SPEC | Ticket | Behavior | Blocked by | Status |
| --- | --- | --- | --- | --- |
| #21 / S2 | #26 | Fresh read-only judge, actual evidence, strict decision schema | #25 | Not started |
| #21 / S2 | #27 | Fixed independent verification and protected files | #26 | Not started |
| #21 / S2 | #28 | Deterministic requests and complete real S2 demonstration | #27 | Not started |
| #22 / S3 | #29 | Shared errors, unlimited backoff and repeat-failure diagnosis | #28 | Not started |
| #22 / S3 | #30 | Original-thread history reconciliation and safe recovery | #29 | Not started |
| #22 / S3 | #31 | Actual fault injection, complete acceptance and delivery | #30 | Not started |

Every future ticket was published from a UTF-8 without BOM body file, compared
exactly on readback, assigned `ready-for-agent`, attached to its native parent,
and checked for its native blocked-by relationship. Advance publication does
not authorize bypassing the previous SPEC's delivery gate.

During publication, GitHub REST reads returned repeated `EOF` with the default
HTTP transport. Repeating a read with process-local `GODEBUG=http2client=0`
succeeded. Publication resumed from existing receipts and completed without
duplicate issues. No persistent GitHub or system configuration was changed.

## Current verification

Repository identity and origin were checked from the project directory:
`williamxhero/needs-forever` and
`https://github.com/williamxhero/needs-forever.git`.

Node `24.19.0`, npm `11.19.1`, Codex CLI `0.166.0`, Windows. Official app-server
documentation was searched and fetched again. Exact wire shapes must still be
checked against the installed CLI's stable generated protocol definitions.

Fresh implementation acceptance has not run yet. Earlier test counts and live
probes are not reused as fresh acceptance passes. No S1, S2, S3, or total SPEC is
complete.
