# Bounded file runner and recovery cancellation measurement

Date: 2026-11-03. Product source, runtime and the reviewed 0.3.3 candidate
are unchanged. This follow-up changes the root test runner and one test.

## Preserved failing evidence

The integration owner retained the third full run: 125 tests, 121 passes,
4 failures, 123105.5609 ms. Its tracked output is
`full-suite-cancelled-judge-archive-lifecycle-red.txt`, SHA256
`e6a5cc353a7e7314ab08b20117a6f7f14b3d70d95f74eeb2eff47c6b40c7abff`.
The separate original raw output has SHA256
`8841e0c4d08496691b740af936559823c1f001a859fc3ed9dcaddc49e6a40d67`.
Neither file was overwritten or retried in place.

The integration fixtures remain under `runs/ticket29`:

| Fixture | Actual progress before the shared 5-second process watchdog |
| --- | --- |
| `real-invalid-json-1793713344671` | C1 created at 13:42:27.530 UTC and normally archived at 27.661; retry scheduled at 27.662, then killed during the next connection's config/read. |
| `worker-disconnect-1793713349770` | Original worker reconnected at 13:42:33.433 UTC; absent delivery reconciled at 33.435; a subsequent service-unavailable recovery started at 33.439 before watchdog termination during another connection startup. |
| `repeated-judge-failures-1793713376077` | C1, C2 and C3 normally archived at 13:42:57.435, 58.210 and 59.789 UTC, then killed during the fourth connection startup. |
| `pause-recovery-1793713383750` | Five-second backoff armed at 13:43:06.564 UTC; durable PAUSED at 06.639 (+75 ms); owned calls cancelled at 06.710 (+71 ms). The 3024 ms whole-process measurement included cold startup. |

The first three failures progressed through their intended recovery and did
not enter the isolated cancelled-C cleanup path. The worker-disconnect case
uses FixtureJudge. The invalid-output cases completed and normally archived
their judges. The pause trace proves cancellation occurred promptly; the old
test measured a different interval.

## Runner resource bound

The integration owner reported `os.availableParallelism() = 12`, 12 logical
cores, 11 test files, 32 GiB RAM with about 5 GiB free, and 63 Node processes
plus 5 Codex processes on a machine running other user work. These are the
owner's contemporaneous observations, not a newly sampled machine profile.
The default file runner could launch all 11 files together, each of which
can spawn multiple external CLI/app-server fixtures.

Root `npm test` now sets `node --test --test-concurrency=2`. This limits file
fanout and leaves case-internal concurrency and all product concurrency
semantics unchanged. The shared synchronous 5-second process watchdog stays
at 5 seconds. No product timeout, cleanup deadline, recovery delay or retry
policy changes. No unrelated process was terminated.

This resource bound is not evidence of product behavior under concurrency.
The existing case-internal concurrent delivery, duplicate-event and
cancellation assertions remain the product concurrency evidence.

## Cancellation boundary

The recovery pause test now waits for a real persisted
`recovery_retry_scheduled` event plus saved RECOVERING state, confirms the
five-second timer and saved retry deadline, and sends the CLI's public stdin
Ctrl+C. It measures input-to-PAUSED/exit with the existing strict two-second
cancellation limit, excluding initial startup.

It requires durable PAUSED before `owned_calls_cancelled`, retry deadline
cleared, one recovery schedule, no decision or DONE, no reconnect, delivery
or recovery after pause, exactly one worker/thread turn, and exit of the
exact owned server identified by thread/start. Failure cleanup first uses
the same public cancellation input and only targets this test's CLI.

## Single bounded validation

- `npm run build`: PASS.
- One invocation of `node --test --test-concurrency=2
  dist/test/recovery-cli.test.js dist/test/judge-cli.test.js
  dist/test/main-controller.test.js`: **44/44 PASS**, no failures,
  cancellations, skips or todo; 28075.4016 ms.
- Output preserved in `cancelled-judge-archive-bounded-runner-tests.txt`.
- Previously failing invalid JSON, disconnect, repeated failure and recovery
  pause cases completed in 766.7288, 1036.7052, 1132.4056 and 404.4322 ms
  respectively in this run. These are observed durations, not new deadlines.
- The pause fixture's events recorded backoff at 13:52:28.488 UTC, PAUSED at
  28.507, then owned cancellation at 28.527.

The full 125-test gate remains assigned to the integration owner after
independent review; this agent did not run another full suite. No candidate
was rebuilt or installed, no real chat or hook trust was changed. The
unchanged candidate archive SHA256 is
`395c8b568c97823d734bd0ed6567237235c077f81f0e2fce36f766ce8f2dda46`.
