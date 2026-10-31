# T01–T15 acceptance matrix

| Scenario | Mode | Result | Evidence |
| --- | --- | --- | --- |
| T01 same worker continues after an early finish | live reused | PASS | `docs/evidence/ticket-28/final/live-local-gate-excerpt.txt`; worker thread `01a1934b-e35d-7d01-8f80-654988ee6b97` |
| T02 two early finishes are both pushed | live reused | PASS | ticket-28 local gate, three worker turns on one thread |
| T03 failed route changes to a verifiable route | live reused | PASS | ticket-28 local gate, unavailable route then direct-file route |
| T04 independent verification failure returns to the worker | live reused | PASS | `docs/evidence/ticket-28/final/live-t04i-excerpt.txt` |
| T05 DONE is stable and duplicate events do not restart work | live reused | PASS | ticket-28 local gate and S1 regression |
| T06 WAIT_EXTERNAL is concrete and stable | simulated reused | PASS | `docs/evidence/ticket-26/final/external-wait-*` |
| T07 stale results cannot cross task versions | simulated reused | PASS | ticket-25 pause/resume and ticket-26 judge boundary tests |
| T08 Ctrl+C during worker, judge and verification | live | PASS | `final/t08-pty/{worker,judge,verification}`; real Windows PTY Ctrl+C, all three end `PAUSED`, version increments, cancellation recorded |
| T09 judge timeout and invalid JSON recover | simulated | PASS | ticket-29 regression and `npm test` |
| T10 service failure/backoff and quota distinction | simulated | PASS | ticket-29 recovery tests; 5/15/60/300 second policy |
| T11 thread/process recovery with same worker | live | PASS | `final/t11/t11-app-server-exit.json` native app-server exit; `final/t11/thread-unload/result.json` native `thread/unsubscribe` unload with `notLoaded`/`thread/closed`, one reconnect, same worker ID, and verifier PASS |
| T12 unknown send result is reconciled before resend | simulated | PASS | ticket-30 periodic and explicit reconciliation tests |
| T13 missed request is answered or cancelled deterministically | simulated reused | PASS | ticket-28 request handling evidence |
| T14 cumulative limits survive recovery | simulated reused | PASS | ticket-25 limit and resume evidence |
| T15 missed terminal notification is reconciled once | simulated | PASS | ticket-30 paginated history and periodic reconcile tests |

T11 uses two live injections against the managed app-server: native process termination and native `thread/unsubscribe` unload. Both recover the saved worker identity and finish independent verification.
