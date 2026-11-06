# Current 0.3.4 acceptance preparation

Date: 2026-11-06. This is a current-baseline preparation receipt for SPEC #33 / ticket #38. It does not claim live Desktop execution.

## Baseline

- Repository: `williamxhero/needs-forever`
- Git baseline: `main@07afdc5`; local and `origin/main` are equal (`0/0`), with a clean worktree.
- Package version: `0.3.4`.
- Installed local plugin root used for preparation: `C:\Users\will\.codex\plugins\cache\needs-forever-local\needs-forever\0.3.4`.
- `node <plugin> scripts/control.mjs doctor`: PASS; Node `v24.19.0`, CLI `codex-cli 0.166.0`, plugin `0.3.4`.

## Fresh preparation

The current main-session demo was generated with `scripts/prepare-main-session-demo.mjs` and the 0.3.4 installed plugin:

- Directory: `.scratch/spec33-0.3.4-acceptance`
- Workspace: `.scratch/spec33-0.3.4-acceptance/workspace`
- Task: `.scratch/spec33-0.3.4-acceptance/task.json`
- Launch prompt: `.scratch/spec33-0.3.4-acceptance/desktop-launch-prompt.txt`
- Preparation receipt: `.scratch/spec33-0.3.4-acceptance/preparation.json`

The receipt records `live_desktop_acceptance=not_run`. The task preserves the three-stage contract, the deliberately failing first route, the fixed verifier and the one-stage-per-response pacing adapted for native Stop continuation.

## Isolated package discovery

`scripts/verify-plugin-install.mjs` was run against the repository candidate in `.scratch/spec33-0.3.4-install`.

- Discovery: PASS
- Installed package: 0.3.4
- Candidate and installed package hashes: equal
- Hook discovery: all six plugin hooks discovered
- `human_trust_required`: `true`
- `native_effectiveness`: `not_run`

This is an isolated discovery result. It does not prove that the existing Desktop owner has loaded, trusted or executed these hooks.

## Automated gates

- `npm test`: PASS, 128 tests, 128 passed, 0 failed, 0 skipped.
- `npm run build` and plugin generation: PASS, 18 executable runtime modules.
- `git diff --check`: PASS.

## Remaining native gates

The current 0.3.4 package still requires an authorized Desktop A with the actual workspace above. T09 requires a real human prompt while C is judging; T15 requires an actual Desktop/host exit and explicit resume of the same A; T18 requires the installed plugin itself to run from a Chinese path containing spaces. Simulated tests and the historical 0.3.3 Unicode receipt remain supporting evidence only. Until these native events are recorded, #38 and #33 remain open.
