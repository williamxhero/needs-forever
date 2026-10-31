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

`npm test` covers the existing 48-test S1/S2 regression plus the public CLI request test (`49/49` expected after this ticket's test is included). The request test uses the fixture app-server only to exercise the JSONL seam; it does not claim live model behavior.

The live three-stage entry was started against Codex `0.166.0` in an isolated workspace. The real worker completed stage 1 and emitted real worker IDs/events; the first judge remained in progress beyond the bounded observation window. The run was interrupted and is recorded as `not_run` for complete T01-T05 acceptance. No simulated result is labelled live.
