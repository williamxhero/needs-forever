# Active-writer recovery and honest NFG delivery

## Problem

When the original A still owned an in-progress Codex writer, Codex rejected NF's
recovery `turn/start` with `-32600 already has an active writer`. The old path
recorded this as a terminal-looking send failure. NFG also treated a prepared
or returned direction as if A had received it, so a round could show an empty
`WORKER 收到` line while the original thread was still active.

## Durable behavior

- The same recovery `delivery_id` is retained across active-writer retries.
- Active-writer errors are recorded as `main_session_recovery_prompt_deferred`
  with the redacted reason, `retryable: true`, attempt number, and `retry_at`.
- Backoff is bounded at 5, 15, 30, and 60 seconds and remains constrained by
  the existing two-minute recovery deadline. Expiry becomes an explicit
  `INTERRUPTED` state and requires a new user resume.
- The detached recovery coordinator drives both native-rebind and ordinary
  continuation prompts, including persisted due times, so a deferred prompt
  does not wait for another Codex message or B restart.
- Unknown send outcomes remain non-retryable; NF never duplicates an uncertain
  message.
- NFG renders `WORKER 收到` only from an observed/confirmed delivery. A failed
  or deferred attempt shows its concrete reason and does not render an empty
  prompt block or a fabricated timestamp.
- A real A tool result or native Stop clears stale recovery diagnostics before
  the next B/C round is projected.

## Verification

The regression suite covers native rebind and ordinary continuation races,
automatic watchdog retry, same-delivery correlation, honest NFG projection, and
the recovery deadline. The complete suite passed **236/236** on 2026-11-11 after
rebuilding the self-contained runtime and integrity manifest.
