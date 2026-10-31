# S1 independent review fixes

Source: `docs/delivery/s1-review.md`, reviewing candidate `5fa39fc` against `5d640e5`. All three findings were handled by the same fix implementer on `fix/20-s1-review`, based on the latest S1 integration. No S2/S3 work or tracker operation was performed.

## Spec P2: stale resume checkpoint

The first resume read now supplies only task ID and workspace for acquiring the matching lock. Under that lock, the CLI reads the state again, validates schema and DONE, validates the complete saved task and unchanged identity, then checks explicit task replacement and cumulative limits. The earlier object never becomes the resumed state. Start continues using its single validated task input, avoiding a second start-file read under a different identity's lock.

This race was fixed by static reasoning over the lock/read/write path. No deterministic public reproduction of the narrow filesystem scheduling window was obtained, and no test-only internal hooks were introduced. The existing public CLI concurrency-lock, DONE-cannot-reopen and cumulative-limit tests remain regression evidence; they do not prove the original race was dynamically reproduced.

## Spec P2: changing an ACTIVE contract

Added a public CLI test that starts a fixture whose sending outcome becomes unknown, leaving an actual ACTIVE checkpoint. It then attempts separate explicit goal and authorization replacements. The expected behavior is rejection requiring a durable PAUSED state, with the checkpoint bytes, task version and protocol trace unchanged.

Actual RED: `npm run build` succeeded; `node --test --test-name-pattern='ACTIVE resume rejects changed' dist/test/cli.test.js` failed because stderr was `Unknown sent delivery retained; S3 reconciliation required before any resend.` rather than the required `durable PAUSED` rejection. The old path had already replaced the saved contract and incremented its version.

Minimal GREEN: reject changed goal or authorization unless the locked checkpoint is PAUSED. The same targeted test passed, covering both replacements and exact checkpoint/trace preservation. The guard was then placed inside the lock as part of the stale-checkpoint correction.

`red-contract/` retains the actual first failing run: state version 2 contains the replaced goal while its pending message still contains the original goal. `green-contract/` retains the final passing run: version 1 and the original saved goal/authorization remain unchanged after both rejected replacements. These are actual CLI artifacts, normalized only for UTF-8/LF formatting.

## Standards: one cumulative-limit policy

`rules.reachedLimits` is the single pure calculation of cumulative turn and ACTIVE-time boundaries. Resume admission and send admission check either boundary; the periodic checkpoint checks only time so the currently permitted worker round can finish. No additional framework or private-method test was added. Existing public total-turn/total-time behavior remains the policy regression.

## Verification

After all code changes, the targeted public CLI set for ACTIVE contract rejection, concurrent task lock, DONE stability, turn limits and duration limits passed 5/5. The full exit suite and actual artifacts are captured under `final/`; S2/S3 and delivery steps remain explicitly `not_run` in that report until the coordinator completes its gates.

The pause/cancellation route was unchanged. The interval's duplicated numeric condition was replaced with the equivalent pure policy result. Parent's previously captured candidate PTY evidence remains identified by its own commit and hashes; this report does not claim a new live model run.
