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

## Current workflow (2026-11-01)

The user invoked `implement-spec-to-done` for #19. The sole current SPEC is #20.
Its full body and comments, #19's full contract, native child relationships and
SPEC dependency edges were read again. Order: #20, then #21, then #22.

Skills are executed by loading their installed SKILL.md files and following the
complete procedures; this environment exposes no dedicated skill-call tool.
The current `/to-tickets` phase revalidates existing #23/#24/#25, including
coverage, labels, native parent and blocker links. Their order remains
#23 -> #24 -> #25. No later SPEC is decomposed or implemented in this phase.

Ticket #23's policy criterion is clarified to match #20: validate the actual
worker policy in S1, use a fixed judge for deterministic tests, and validate the
real judge's read-only policy in S2. The total requirement remains unchanged.

After current-ticket revalidation, resume the unfinished #23 worktree as a
draft: no earlier passing test is assumed to be current acceptance. Complete
each ready ticket with TDD, then integrate using a merger agent. Re-read all S1
criteria, run its complete simulated acceptance and independent Standards/Spec
reviews, resolve findings, merge to main, preserve evidence and clean only
delivered temporary resources, push and verify remote equality. Publish and
read back completion evidence, close S1's tickets and #20, and confirm CLOSED.
Only then may #21 enter its own `/to-tickets` phase. The same gate applies
between #21 and #22, followed by total #19 acceptance and closure.

The user's standing approval covers breakdown decisions, not exceptions to
this sequence. Resume/transition records must identify the current SPEC and
actual evidence for closing its predecessor.

## Earlier workflow record (superseded)

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
| #23 | Start a task and query durable execution state | None | Integrated; S1 delivery gate pending |
| #24 | Same-thread continuation, confirmed sending, stable terminal state | #23 | Integrated; S1 delivery gate pending |
| #25 | Pause, explicit resume, cumulative limits and S1 exit acceptance | #24 | Integrated; S1 delivery gate pending |

All three tickets are native sub-issues of #20, carry `ready-for-agent`, and
have native blocked-by relationships. Published bodies were uploaded from UTF-8
without BOM files and compared exactly after readback, including GitHub's CRLF
line endings. Publication receipts are retained under ignored `.scratch/redo`.

## Historical premature ticket publication

#26–#28 under #21 and #29–#31 under #22 were published before the preceding
SPECs were closed. That was a workflow error. These issues are preserved as
unstarted historical records; their earlier publication is not completion of
any phase in the current workflow. Do not start or further refine them now.
Revalidate only when their owning SPEC becomes current after its predecessor
is delivered and CLOSED. The original publication receipts remain historical.

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

Ticket #23 was independently merged and verified at
`7671cd2e3805507f190db2962b0ff1dea14b53de`. The merger reran `npm test`:
7/7 simulated tests passed; the integration diff check passed and both source
and integration worktrees were clean. All 105 generated protocol dependencies
were compared with their recorded installed-CLI source (only `.js` imports
changed), and all 12 captured sample hashes matched. The original ticket run
files were copied to `.scratch/new-workflow/evidence/ticket23-raw/ticket23`
before any future worktree cleanup. Tracked evidence is under
`docs/evidence/ticket-23/`.

Ticket #24 was independently merged at
`b03b49eccfb942e31da5af2ce11b082aaf364477`. The merger ran 14/14 simulated
tests on runtime commit `b7a9a3a`; the final commit only normalizes evidence
text and documents that normalization. The first range diff check failed on
CRLF/trailing whitespace in recorded logs; after that correction,
`git diff --check dc22d41..HEAD` passed. Both worktrees were clean and all
14 representative sample files matched the source demo. Raw runs and the
original log bytes are preserved under `.scratch/new-workflow/evidence/`.
Windows rename contention recurred; the implementation preserves the prior
checkpoint while retrying the same rename for at most five seconds with jitter.
The process holding the file was not identified; complete elimination of
Windows sharing contention is not claimed.

Ticket #25 was integrated at `5fa39fc5466f56371facb0ae09c332cbdcdf3644`.
Independent exit acceptance passed 23/23 simulated tests. Actual Windows PTY
Ctrl+C probes covered WORKER, JUDGE and VERIFY on that candidate; all saved
PAUSED before cancellation and released the owned process and lock. Their
backend is simulated, not a live AI or verifier. Evidence: `docs/evidence/s1-pty-final/`.

Independent Standards and Spec reviews then found repeated limit policy and two
resume contract issues. One implementer fixed all findings in `6094b40`;
independent reviewers confirmed zero unresolved findings, and the merger rebuilt
and ran the full exit acceptance: 24/24 simulated tests, all 13 checks PASS.
See `docs/delivery/s1-review.md` and `docs/evidence/s1-review-fixes/`. Raw runs
are preserved under `.scratch/new-workflow/evidence/s1-review-fix-raw/runs`.
The resume race fix is supported by source analysis, not an invented dynamic RED.

Current stage: S1 acceptance passed, delivery operations pending. No S1, S2, S3,
or total SPEC is complete yet; no implementation Issue has been closed. S2 must
remain unstarted until main merge, safe cleanup, push, remote equality and S1
tracker closure are verified. Delivery receipts will record the actual transition.
