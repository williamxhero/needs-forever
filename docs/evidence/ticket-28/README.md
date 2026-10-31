# Ticket 28 evidence

This ticket adds deterministic app-server request handling at the public CLI and JSONL transport boundary.

## Implemented contract

- Incoming JSON-RPC requests preserve the original `id` as either a string or number and receive a response with that exact id.
- Worker approval and permission requests are refused with the protocol-specific shapes; legacy approvals use `abort`.
- MCP elicitation and unregistered tool calls are cancelled without executing a tool.
- Ordinary non-secret input selects the first valid option. Secret questions receive no fabricated credential answer.
- Unknown methods return JSON-RPC `-32601`; an active worker turn receives an interrupt request for diagnosis after terminal confirmation.
- Judge requests are refused, recorded as judge failure, and never recurse into another judge.

## Validation

`npm test` covers the existing 48-test S1/S2 regression plus the public CLI request test (`50/50` expected after this ticket's test is included). The request test uses the fixture app-server only to exercise the JSONL seam; it does not claim live model behavior.

The complete live local-gate run against Codex `0.166.0` is recorded at `runs/ticket28-live-local-gate`: one real worker completed three turns on one thread, real judge decisions were `CONTINUE`, `CONTINUE`, then `DONE`, the required route failed before the direct-file recovery route, and the fixed verifier returned exit code 0. This supplies live T01/T02/T03/T05 evidence. Controlled T04 is recorded separately in `live-t04i-excerpt.txt` and proves supervisor verifier exit 41, same-worker repair feedback, then exit 0 and final DONE. Earlier and post-correction incomplete runs remain explicitly negative evidence; no simulated result is labelled live.
