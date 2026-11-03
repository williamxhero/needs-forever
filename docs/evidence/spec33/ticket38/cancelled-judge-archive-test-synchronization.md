# Parallel-suite test synchronization follow-up

Date: 2026-11-03. Product code and candidate package remain exactly those of
`5e5c32b6b872057bc9ae7f20c07f540ea81df28e`.

The integration owner's first full run reported 124 tests, 122 passes and two
failures in 109811 ms. Its original output remains in
`full-suite-cancelled-judge-archive-red.txt`. This follow-up changes only test
setup and observations; it does not change cancellation, deadlines, archive
policy or any production runtime bytes.

## Recovery fixture failure

The failed run was
`integration/runs/ticket29/real-judge-timeout-recovery-1793711336323`.
Its event log provides the specific sequence:

| Time (UTC) | Observation |
| --- | --- |
| 13:08:57.866 | First 50 ms judgment expires before a thread/start response; `judge_terminated` has `thread_id:null`, `turn_id:null`. |
| 13:08:58.848 | Reconnected app-server creates the first actual held C, `judge-1`. |
| 13:08:58.952 | That held C is terminated on the next judgment timeout. |
| 13:09:00.206 | Independent cleanup successfully archives `judge-1`, 1.254 seconds after termination. |
| 13:09:01.313 | Recovery reconnects the original worker again. |
| 13:09:01.334 | Fresh `judge-2` is created; the 5-second parent spawnSync watchdog then kills the CLI. |

There is no archive rejection or hanging cleanup in that evidence. The
50 ms fixture deadline, which includes thread/start scheduling, produced an
extra startup timeout under parallel load. The global 5-second harness
watchdog then interrupted a live recovery sequence.

The test now uses an explicitly held first C, a 1-second fixture judgment
deadline that covers normal thread/start scheduling, and asynchronous bounded
observations of each public protocol/event milestone. It checks known-C start,
real timeout, owner process exit, exact isolated archival, original-worker
resume, fresh C and successful DONE. Every phase has a 5-second observation
bound. It also requires exactly one judgment timeout, no anonymous-C timeout,
exact C IDs, exactly one worker turn and exact archival targets. Thus an
unintended startup race cannot silently count as the intended cancellation.

## Human-input fixture failure

The failed run was
`integration/runs/main-controller/input-precedence-1793711324703`.
It recorded Stop at 13:08:46.775 and returned the old direction at
13:08:47.406. Its old test used a 600 ms delayed mock decision while spawning
separate status and input-hook processes. Observing JUDGE did not reserve the
remaining delay for the subsequent cold process startup; under full-suite
load, the direction could already have returned before the input arrived.

The test now uses the public installed Stop/control boundary with the external
app-server fixture. It waits for the exact first C turn/start and verifies
JUDGE while that C is explicitly held. Only then does it submit the human
input. It still requires the old Stop to return `{}`, the new input epoch and
instruction to persist without a delivery, and the later same-turn Stop to
return a new direction. No arbitrary fixed decision delay determines the
input ordering.

## Verification

- The two affected tests pass together through their public boundaries.
- `node --test dist/test/main-controller.test.js dist/test/recovery-cli.test.js`:
  **27/27 PASS**, zero failures, cancellations or skips (21103.645 ms).
- `npm run build`: PASS.
- `git diff --check`: PASS.
- Candidate SHA256 remains
  `395c8b568c97823d734bd0ed6567237235c077f81f0e2fce36f766ce8f2dda46`.

No archive was overwritten or regenerated, and no installation, real-session
operation or hook trust change was performed. The integration owner will run
the full suite once after the incremental test review.
