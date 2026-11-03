# Ticket #34: main-session identity and packaged hook boundary

Date: 2026-11-03. Parent SPEC: #33. Evidence classification: **simulated** host callbacks, plus actual Windows CMD package-command execution. No Desktop Stop continuation or native hook effectiveness is claimed here.

## Public contract

- Installed `scripts/main-session.mjs prepare --task ABS --state ABS [--test-fixture ABS]` saves the full task, initial protected verifier baseline, contract hash/version, run generation, and a pending binding. No session-id input is accepted, no environment session-id is trusted, and no worker/app-server is created. Native binding remains `PAUSED / RECOVERING / PENDING_NATIVE_HOOK` until correlated metadata is available.
- Installed `scripts/main-session.mjs status --state ABS` is read-only. It exposes control mode, binding, actual separately observed Desktop/CLI versions, evidence mode, hook effectiveness and recovery condition. Checkpoints lacking `control_mode` are reported as `independent-worker`; the existing worker entry point and tests remain intact.
- Default packaged `hooks/hooks.json` supplies SessionStart, PreToolUse, PostToolUse, Stop, UserPromptSubmit and Interrupt. Hook trust belongs to Codex Settings > Hooks. Nothing edits trust or global configuration. Windows uses the documented `commandWindows` override with `%PLUGIN_ROOT%`; POSIX uses `${PLUGIN_ROOT}`.
- A preparation PreToolUse observation stores only command fingerprints, session/cwd/tool-use identity and package identity. Matching PostToolUse must contain the unpredictable preparation receipt challenge and the exact task/state paths, including inside Code Mode input, and the task contract hash must still match. Ordinary unbound tool calls create no observation artifacts. Agent and unrelated-session callbacks do not bind or dispatch.
- Runtime `handleLifecycle(input, host, pluginRoot)` returns `{ bound: true, state_path }` on binding, or `{ state_path, stop_request }` for an active, matching Stop. The returned internal envelopes are **not** host stdout. The packaged entry point currently returns only `{}`; #35 owns synchronous B dispatch and host decisions.
- A Stop envelope contains task id/version/hash, main session, run generation, optional turn id, locally unique `stop_attempt_id`, `stop_hook_active`, deadline, evidence mode and a redacted bounded assistant message. A genuinely later Stop in the same turn is permitted. Retries to B must reuse the same generated envelope; #37 owns transport deduplication, ordering and execution confirmation.
- Identity binding is distinct from controller readiness and hook effectiveness. This slice never claims active supervision from configuration presence, a launched process, fixture input or a manually replayed handler. `hook_effective` remains false for this slice. #35 must prove a valid B round trip, and #38 must record actual trusted Desktop callback evidence before claiming live support.

## Native host adapter and limits

`inspectHookHost` checks installed `PLUGIN_ROOT`, the actual Windows process ancestry and the installed Desktop executable's own `--version`, separately from CLI `--version`. Missing or unsupported ancestry stays unverified; no CLI-only fallback is made. The local trust boundary is same-user execution, not cryptographic remote attestation. Intentional manual same-user callback replay can reproduce ancestry and must never be presented as native live acceptance evidence.

The adapter's cold PowerShell ancestry/version check can take about four seconds on this machine. Interrupt callbacks have a three-second host deadline: the later controller adapter must route already bound callbacks through its fast IPC path rather than repeat this cold probe. This ticket does not claim Interrupt pause behavior, B startup, readiness, continuation, judge execution or race handling.

## TDD evidence

The agreed seam was an installed plugin copy and native lifecycle stdin/stdout, inspected through public status. Only the external host was replaced, via explicit `--test-fixture`; all such states remain `mode=simulated` and `hook_effective=false`. Each slice below was run red before minimal implementation, then green; the red failures were observed in this worktree's execution stream.

| Slice | Red command and observed failure | Green result |
| --- | --- | --- |
| Pending identity | `node --test --test-name-pattern='preparation stays pending' dist/test/main-session.test.js`: installed `scripts/main-session.mjs` missing (`MODULE_NOT_FOUND`) | 1/1 pass; guessed CODEX_THREAD_ID/CODEX_SESSION_ID cannot bind |
| Structured receipt correlation | `node --test --test-name-pattern='structured host callback' dist/test/main-session.test.js`: installed `scripts/lifecycle.mjs` missing (`MODULE_NOT_FOUND`) | 1/1 pass; unrelated tool id ignored, matching pre/post binds only simulated identity |
| Code Mode / neutral paths | `node --test --test-name-pattern='neutral task filenames' dist/test/main-session.test.js`: ordinary unbound callback created observation artifacts (`true !== false`) | 1/1 pass; no unrelated artifact, valid neutral task/state paths bind through Code Mode |
| Stop identity | `node --test --test-name-pattern='bound Stop callback' dist/test/main-session.test.js`: `last_stop` absent (`Cannot read properties of undefined (reading 'session_id')`) | 1/1 pass; distinct attempts in same turn, agent/foreign events ignored, optional turn id, redaction |
| Windows installation path | `node --test --test-name-pattern='Windows native hook command' dist/test/main-session.test.js`: CMD treated `${PLUGIN_ROOT}` literally and could not find installed lifecycle script | 1/1 pass after `commandWindows`, through real CMD with Chinese/space installation path |

The complete regression after slices 1–4 ran **78 tests, 78 pass, 0 fail**. Slice 5 changed only packaged command-shell selection and added its targeted process test. The final targeted installed-copy run and build/integrity result are in `final-checks.txt`. No prior test result is represented as an actual Desktop Stop test.

## Primary interface references

- Official Hooks documentation fetched on 2026-11-03: https://learn.chatgpt.com/docs/hooks (stdin fields, trust, default plugin hooks discovery, synchronous Stop decision, optional Windows override).
- Official plugin packaging documentation fetched on 2026-11-03: https://developers.openai.com/plugins/build/plugins (PLUGIN_ROOT/PLUGIN_DATA and default hooks path).
- Official source checked on 2026-11-03: https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/command_runner.rs (`COMSPEC`, default `cmd.exe /C`, command execution).
- Official source checked on 2026-11-03: https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs (`command_windows` selection and plugin environment).

Live Desktop acceptance and supported installed-version/trust evidence remain required under #38.
