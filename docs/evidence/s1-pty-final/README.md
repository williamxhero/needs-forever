# S1 candidate Ctrl+C verification

The coordinating agent independently reran all three manual Windows PTY checks
on built candidate `5fa39fc5466f56371facb0ae09c332cbdcdf3644`, after the ticket
#25 merger passed. This supersedes the draft-only probe for candidate evidence.

Each phase directory contains its saved ACTIVE pre-signal state, final state,
events, protocol trace, task, fixture and stripped console transcript. Sending
actual Ctrl+C in each PTY produced PAUSED/IDLE, version 2, reason `user`; the
owned server exited and the state lock was released. The worker fixture read
PAUSED/version 2 at interrupt. No judge or verification result changed the task
to DONE. `receipt.json` records the observed server identities and results.

The backend and verification call remain simulated. This verifies the real
console signal route, not live AI judging or an independent acceptance command.
Absolute paths identify historical artifacts. Reproduce with the public fixture
preparation script and a new evidence directory. PowerShell returns 1 after
Ctrl+C; task outcome is established by saved state and process termination.
