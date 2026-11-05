# Installed 0.3.2: native acceptance continuation checkpoint

Date: 2026-11-03. Reviewed integration: `f5c896bce05f07f1052199ac8d2f38698749a765`; implementation: `5960bec274421bb5d0382ed2690ea4864db3f244`. Parent confirmed final Standards and Spec reviews passed with zero findings. This checkpoint records existing evidence only; it changes no code, installed files, trust or task state.

## Installation and discovery

The existing local receipt `.scratch/main-session-supervision/live-desktop/candidate-neutral-update.json`, timestamp `2026-11-03T10:52:51.171Z`, records official `plugin add needs-forever@needs-forever-spec33 --json` exit 0 and **PASS** for 0.3.2. All **27 plugin files** match the reviewed candidate exactly. Archive SHA256 is `ff330da0b14972a1fcfad3ce5a70983f3864658003774118c73e80ff9358f5d0`; complete package hashes are in [patch032-package.json](patch032-package.json). The archive also contains the marketplace file, hence its total of 28 files. Legacy 0.2 bytes and the original 14 root files remain unchanged; no trust was written.

The existing `real-home-discovery.json`, timestamp `2026-11-03T10:52:57.659Z`, reports six enabled hooks: **five trusted, Stop modified**, with no errors or warnings. Stop has no unconditional status message. This discovery came from a fresh owned Desktop-binary server using the real user home; it does **not** prove execution by the existing Desktop owner or a native continuation.

## Original A and the next action

The authorized original A remains `01a1a0bf-c5d2-74e0-9eae-cf2d38a20cb7` (`SPEC33 Desktop 验收`). Its original workspace-relative `.spec33-fixture/state.json` still reports `PAUSED` / `RECOVERING`, `PENDING_NATIVE_HOOK`, `binding.operation=resume`, `main_session_id=null`, `controller=null`, `hook_effective=false`, and `continuation_confirmed=false`. `pause_reason=null`: this is pending native setup, not a user-requested pause. No automatic B has started.

Resume sequence:

1. The user reviews only the modified **Stop** entry in Codex Settings > Hooks, then genuinely closes/reopens Desktop to refresh the owner. Do not script trust or force-kill Desktop.
2. In the **same A and original workspace**, issue one supported direct literal command: `node "<installed-0.3.2>/scripts/control.mjs" resume --state "<original-absolute-state-path>"`. Existing authorization covers driving this acceptance recovery; preserve the original task, verifier baseline, model, tools and permissions.
3. Observe genuine native receipts establishing `BOUND`, the exact original A identity, and automatic B; then verify actual A activity following Stop directions. Do not treat returned directions as execution proof.

The checkpoint already exists: **do not run start again**, delete/edit state, fabricate native events, replace A or use a second app-server to execute A. Installation/trust and ordinary task requests do not independently authorize supervision; the skill's explicit human opt-in policy still applies. Generic host hook dispatch/UI may precede plugin code and is not suppressed by this policy.

## Remaining delivery gate

The required real Desktop matrix remains **unaccepted**. Pending/untrusted-entry observations and simulated tests do not establish trusted startup, native continuation, pause/resume, DONE or genuine Desktop-restart acceptance. Continue T01/T02/T07 first, then the remaining required native cases recorded in the SPEC.

Parent recorded progress in #33 comment `6601843993`, uploaded from UTF-8 without BOM and read back exactly; #33–#38 remain OPEN. No main merge, push, cleanup or closure occurs before the native gates and the remaining delivery checks pass. Preserve unrelated root work, the running legacy 0.2 task and the registered sidecar marketplace source. The current local continuation note is `.scratch/main-session-supervision/live-desktop/next-steps032.md`; earlier next-steps notes are historical.
