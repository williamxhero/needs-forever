# Gate evidence

- **T13 / deterministic request handling:** `test/cli.test.ts` test `server requests preserve string ids and receive deterministic refusals` exercises the public CLI with a fixture app-server. It verifies exact string id `approval-string-id`, numeric id `73`, protocol-specific permission refusal, and first valid ordinary option selection.
- **T06:** the existing `T06 WAIT_EXTERNAL cites an actual failed route, stays idle and notifies once despite duplicates` regression remains green in the 49-test run.
- **Unknown request:** `Supervisor.handleServerRequest` returns JSON-RPC `-32601` and requests `turn/interrupt` for an active worker turn; no permissive result is fabricated. Judge requests use the refusal path and reject the active judge terminal, preventing recursive judging.
- **Pause gate:** existing `T08 simulated worker pause is saved before interrupting its owned turn`, delayed judge, and verification cancellation tests remain green. The durable `PAUSED` checkpoint wins over late results.
- **Live attempt:** `runs/ticket28-live/state.json` and `events.jsonl` contain the real worker and judge IDs. The real worker completed stage 1; the real judge remained in progress beyond the bounded observation window. The process was interrupted, so complete T01-T05 are explicitly `not_run_to_completion`.
