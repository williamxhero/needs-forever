# Native Desktop acceptance: Unicode and space path run

Recorded 2026-11-05 after the user confirmed that the isolated Desktop window was logged in and the installed hooks were trusted. This receipt is a real native Desktop run of plugin `needs-forever@0.3.3`; it is separate from simulated process tests.

## Receipt

- Main session A: `01a1a504-7a77-7402-bcc6-0526e245e550`
- Desktop: `codex-cli 0.159.0`; CLI: `codex-cli 0.166.0`
- Isolated `CODEX_HOME`: `.scratch/main-session-supervision/live-desktop/中文 空间验收/Codex Home`
- Workspace: `.scratch/main-session-supervision/live-desktop/中文 空间验收/Workspace 中文`
- Final state: `DONE / IDLE`, `mode=live`, `binding=RELEASED`
- Final host proof: `source=native-desktop`, `hook_effective=true`, `continuation_confirmed=true`
- Fixed verifier: `PASS all three Unicode installed-plugin task stages`
- State receipt: `.../Workspace 中文/.spec33-unicode/state.json`
- Event receipt: `.../Workspace 中文/.spec33-unicode/events.jsonl`
- Native run receipt: `.scratch/main-session-supervision/live-desktop/unicode-native-run-receipt.json`

## Observed behavior

The run bound the original A, started an independent B, created read-only C judges for synchronous Stop decisions, returned continuation directions to A, observed matching A tool activity, and completed the three-stage contract. The same A was explicitly resumed after a Desktop-owner exit; the resumed run re-bound the original session and reached `DONE` without replaying an old direction. The final events include `main_session_resume_prepared`, `main_session_bound`, `main_session_continuation_confirmed`, `verification_result`, and `main_session_terminal` with `action=DONE`.

The workspace contains exact stage 1, stage 2 and stage 3 JSON values, preserves the earlier stages, and leaves the protected verifier unchanged. This is native evidence for the binding/continuation, independent judge, verification, Unicode/space-path and same-A host-restart recovery paths covered by this exercise.

## Remaining limitation

This run does **not** establish T09. No receipt records a real human prompt submitted while C was still judging. The simulated T09 tests pass, but the native acceptance item remains `not_run` until a supported Desktop interaction produces that event sequence. It must not be inferred from `input_epoch=3`, ordinary tool activity, or a delegated message.
