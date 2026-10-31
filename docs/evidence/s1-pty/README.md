# S1 manual Windows Ctrl+C probe

The parent controller independently started three actual CLI processes in Windows
PTY sessions against the ticket #25 simulated app-server and fixed judge. Before
each signal the saved state was ACTIVE in WORKER, JUDGE, or VERIFY respectively.
Sending the actual console Ctrl+C character produced PAUSED/IDLE, version 2 and
reason `user` in all three cases. Each owned server exited and each state-file
lock was released. The worker fixture observed the saved PAUSED/version 2 state
when it received turn/interrupt. Judge and verification paths recorded discarded
late results rather than DONE.

`receipt.json` contains the observations. Phase directories contain the actual
task, fixture, state, events, protocol trace, summary, snapshots and console text.
Console control sequences were stripped from the saved text; underlying JSON
artifacts are copied unchanged. Absolute paths identify these historical runs.
They are not portable resume instructions. The outer PowerShell PTY returned 1
after Ctrl+C; acceptance used durable state and owned-process termination instead
of treating that shell code as the supervisor's verdict.

These are **simulated** backend results with a real OS signal. No live model or
real independent verifier is claimed. The runtime was copied from the unfinished
ticket #25 build to isolate it from concurrent compilation; `runtime-hashes.json`
identifies its JavaScript files. This supplementary probe does not replace the
final candidate's automated tests, S1 exit checks or independent code reviews.
The original copied runtime and raw artifacts remain under
`.scratch/new-workflow/pty-runtime/` and `.scratch/new-workflow/pty/`.
