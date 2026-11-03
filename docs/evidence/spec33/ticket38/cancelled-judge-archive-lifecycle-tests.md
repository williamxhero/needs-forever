# Known C and turn acknowledgement are separate cancellation boundaries

Date: 2026-11-03. This follow-up changes tests and their external app-server
fixture only. Product runtime and the 0.3.3 candidate archive remain byte
identical to `5e5c32b6b872057bc9ae7f20c07f540ea81df28e`.

## Second full-suite failure diagnosis

The integration run at `6101a107035b69e67c685724a5532438d4f25196`
reported 124 tests, 123 passes and one failure in 98761.763 ms. The original
output is retained as `full-suite-cancelled-judge-archive-sync-red.txt`.

Its failed fixture is
`integration/runs/ticket26/judge-timeout-1793712461967`:

| Time (UTC) | Actual observation |
| --- | --- |
| 13:27:43.657 | Original app-server PID 50520 creates readonly C `judge-1`. |
| 13:27:43.876 | Its deadline terminates the owned server with known `thread_id:judge-1`, but `turn_id:null`. |
| 13:27:45.413 | Independent isolated cleanup PID 48420 successfully archives exactly `judge-1`. |
| 13:27:45.414 | The original judgment timeout remains the recorded recovery reason; no decision is inferred. |

The external trace contains C's readonly `thread/start` but no received C
`turn/start`. The old test had already passed its timeout, process-exit and
exact archival assertions. It then tried to recover C's owner PID from a
nonexistent turn/start record and threw `Cannot read properties of undefined
(reading 'pid')`. The production cleanup succeeded; the failed assumption
was that a known C must already have an acknowledged or received turn.

The original owner is now identified through its readonly thread creation
request. The cleanup server is separately identified through the exact C
archival request, and both owned processes must be gone. No test identifies
the original judge through a generic first/last initialize or spawned process.

## Causal tests and unchanged gates

The timeout regression is split into two explicit cases. Both use an actual
held external C and a 1-second fixture judgment deadline, with bounded public
protocol/event observations rather than a single total-process timer.

- In the unconfirmed case, the fixture holds the turn/start response for
  2 seconds. The real earlier deadline must terminate known `judge-1` with
  `turn_id:null`, then archive only that C.
- In the confirmed case, the fixture acknowledges turn/start immediately and
  holds the result. The real deadline must terminate `judge-turn-1`, then
  archive only that C.

Both cases require the C request to reach the external fixture before awaiting
the deadline, exactly one worker and one C turn request, no second readonly
thread, no cleanup model/resume requests, identical guarded argv/cwd/MCP
configuration, RECOVERING without a decision, exact C archival and dead owned
servers. The separate rejection/cleanup-timeout test now observes these same
milestones and bounds cleanup after termination; it retains explicit errors,
no retry, no model restart and no inferred completion.

The 1-second fixture deadline covers normal thread/start scheduling. No
product judgment, cancellation or cleanup deadline is changed. Each observed
phase is bounded to 5 seconds, including the unchanged 3-second cleanup
operation deadline and owned process exit.

The pause test no longer starts a 100 ms timer from the worker turn. The
external app-server first receives and acknowledges C's turn/start, then
emits the existing test pause notification while C is held. The test requires
the exact confirmed turn ID to terminate, separate original/cleanup process
exit, exact C archival, durable PAUSED and no new model/resume/delivery.

## Bounded audit of similar assumptions

Only the concrete related cases were changed:

| Case | Existing assumption | Final causal boundary |
| --- | --- | --- |
| `judge-cli` known-C timeout | 100 ms necessarily permits a C turn record | Separate acknowledged/unacknowledged cases with explicit held C and owner from thread/start. |
| `judge-cli` cleanup rejection/timeout | Same 100 ms necessarily permits exactly two turn requests | Confirm held C request and its termination before observing bounded cleanup. |
| `judge-cli` pause-real-judge | Pause 100 ms after worker send necessarily reaches an active C | Pause is emitted only after the actual C turn/start acknowledgement. |
| `main-supervision` input during JUDGE | A 1500 ms delay reserves enough time for a cold input-hook process | Hold the first C and observe its actual turn/start before submitting input. |
| `verification-cli` pause-independent | Pause 100 ms after worker send necessarily reaches command/exec | Pause is emitted only after command/exec reaches the external verifier fixture; the verifier is held. |

The verifier pause test also identifies the owner through command/exec,
requires its process exit, and explicitly checks that durable `paused`
precedes `owned_calls_cancelled`. Its no-success/stale-result gates remain.

The recovery timeout test was already changed to explicit held-C phases in
`87e412b`. Installed `pause-C-cleanup` already holds C and waits for its turn
request. `adapter-occurrence` permits the first direction to have returned
before duplicate detection, so its 500 ms delay is not used as an assumption
that a C is still running. Simulated FixtureJudge/worker timers were not
generalized into this change.

## Verification

- `npm run build`: PASS.
- Targeted lifecycle/cleanup/pause cases: **4/4 PASS**.
- One complete `judge-cli.test.js` run: **17/17 PASS**, zero failures,
  cancellations or skips (21689.500 ms).
- Targeted held-JUDGE input test: **1/1 PASS** (2478.482 ms).
- One complete `main-supervision.test.js` plus `verification-cli.test.js` run:
  **29/29 PASS**, zero failures, cancellations or skips (63649.416 ms).
- `git diff --check`: PASS; source and installed plugin byte comparison against
  `5e5c32b` has zero differences.
- Candidate archive SHA256 remains
  `395c8b568c97823d734bd0ed6567237235c077f81f0e2fce36f766ce8f2dda46`.

No package was regenerated or installed; no real session or hook trust was
changed. The integration owner retains the single combined full-suite gate.
