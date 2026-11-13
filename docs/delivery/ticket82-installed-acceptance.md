# Ticket #82: installed runtime and B0QI acceptance

Ticket #82 is the release gate for SPEC #77 after the Supervision Round and
Judgment Round changes. The implementation commit is `6cfc51c`.

## Regression repaired

The existing adapter-occurrence regression exposed a real concurrency defect.
While one native Stop was in C, a duplicate Stop handler read an older checkpoint
and assigned it to the controller's shared in-memory `state` before rejecting
the duplicate occurrence. The first C result then reached B with an old
`supervision_round` projection and failed the single-admission delivery fence,
leaving the task in recovery without a direction.

The controller now rejects a duplicate or replay Stop before replacing the
active controller state. The active Stop keeps its admission and delivery fence;
each distinct later Stop still gets its own C judgment. The duplicate occurrence
is returned as a rejected adapter error and cannot mutate the active round.

## Verification

This worktree ran the build and plugin generation sequentially:

```text
npm run build                 passed
node scripts/build-plugin.mjs passed (42 runtime modules)
npm test                      267 passed, 0 failed, 0 cancelled, 0 skipped
git diff --check              passed
```

The targeted native Stop, recovery, pause, Supervision Round and NFG checks
passed 13/13. The complete output is retained in
`.scratch/spec77-ticket82-full-test.txt`; the red/green boundary is recorded in
`docs/evidence/spec77/ticket82-installed-acceptance.json`.

## Production boundary

The deployment helper is pinned to the primary checkout, so this worktree did
not modify the installed global package. The live state was read without
printing credentials: B0QI remains `PAUSED`/`IDLE` with `pause_reason=user`,
the original A is `01a1ae7a-9442-79e0-b32b-aa560f976453`, and the contract hash
is unchanged. No native Stop was fabricated or triggered while the user pause
was active. Deployment, daemon/B restart verification, and a fresh native
Stop→C→delivery observation are coordinating-agent gates after this commit is
merged to integration.
