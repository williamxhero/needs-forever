# S1 independent review

Fixed point: `5d640e5781adadfcd42c3e8806129b1b3050e0d6`.
Candidate: `5fa39fc5466f56371facb0ae09c332cbdcdf3644`.
Diff: `git diff 5d640e5...5fa39fc`; nonempty (255 files, 6172 insertions).
Commit list was read with `git log 5d640e5..5fa39fc --oneline`.
Two separate read-only agents reviewed the axes independently. They made no
changes, executed no tests and did not operate the tracker.

## Standards

No documented-rule hard violations; one low-priority judgement call.

Possible Duplicated Code: `src/cli.ts:56` and `src/supervisor.ts:230` repeat
the cumulative worker-turn/time limit predicate, while `src/supervisor.ts:89`
separately calculates the time limit. Resume admission, send admission and
running-time pause depend on the same policy. Extract a shared pure policy to
avoid divergent boundaries or units. No current behavioral difference was found;
this maintenance suggestion is not independently a delivery blocker.

Sources: AGENTS.md, the three docs/agents entries and README. Generated protocol
style was excluded. No CODING_STANDARDS, CONTRIBUTING, GLOSSARY or ADR file exists.

Count: 0 hard violations, 1 judgement call. Worst within this axis: repeated
limit policy (low priority).

## Spec

Two P2 findings; no scope expansion found.

1. Re-read and validate resume state after acquiring the lock. In candidate
   `src/cli.ts:52–59,71–76`, a process reads `saved` before acquiring exclusivity.
   Another owner can then save DONE and release the lock. The new owner acquires
   the lock and writes its old ACTIVE object, reopening a stable terminal state.
   This violates S1's “DONE 不可重开” and “同一任务持有唯一锁”. The first read should
   only identify the lock; terminal state, task contract and cumulative limits
   need validation again inside it.
2. Reject changing goal or authorization on an ACTIVE checkpoint. Candidate
   `src/cli.ts:54–55,74` only constrains task ID/workspace for explicit `--task`.
   A crashed ACTIVE/in-progress checkpoint can therefore resume its old worker
   under changed/reduced authorization. This violates the inherited total SPEC's
   “变更目标或授权先暂停”. Compare inside the lock and require a durable PAUSED
   checkpoint first. Raising limits alone may retain its existing behavior.

Count: 2 P2 findings. Worst within this axis: stale resume can reopen DONE.

## Resolution

All findings resolved in `6094b4081e49d3f87ae0dbd2c9ec350c02c107ba`.
The original independent reviewers rechecked that commit read-only and confirmed
zero remaining Standards findings and zero remaining Spec findings.

Resume now rereads authoritative state under the task lock, validates DONE,
identity and limits there, and requires durable PAUSED before changing goal or
authorization. The race correction is established by source reasoning; the narrow
race was not dynamically reproduced. Actual public CLI RED/GREEN evidence for
the contract-replacement guard is in `docs/evidence/s1-review-fixes/`.
`rules.reachedLimits` centralizes the repeated policy without changing the
running-round time-limit semantics.

An independent merger rebuilt and ran the complete exit suite at the fix commit:
24/24 simulated tests and all 13 report checks PASS; the baseline range diff check
also passed. Neither reviewer substituted their source review for the merger's
test run. S1 acceptance is satisfied; main merge, cleanup, push and tracker
closure are separate remaining delivery operations.
