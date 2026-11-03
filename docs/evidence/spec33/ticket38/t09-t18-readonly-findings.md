# T09 / T18 remaining native acceptance: read-only findings

Date: 2026-11-03. This investigation did not restart/kill apps, launch another profile, alter installed configuration/trust/cache, submit UI input, execute A, or manufacture native callback events.

## T18: an isolated Desktop profile is plausible, but Windows launch remains unverified

The installed Desktop bundle contains real CODEX_HOME and CODEX_ELECTRON_USER_DATA_PATH handling. A blanket claim that Desktop ignores CODEX_HOME would be incorrect.

Inspected installed file:

`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.1915.0_x64__2p2nqsd0c76g0\app\resources\app.asar`

Its package.json reports version **26.928.20755**, main `.vite/build/early-bootstrap.js`. WindowsApps directory/package version and internal application version are distinct values.

Actual product identity is **Codex**: package.json has name=`openai-codex-electron`, productName=`Codex`, description=`Codex`, codexBuildFlavor=`prod`. The adjacent AppxManifest.xml has Identity Name=`OpenAI.Codex`, Version=`26.928.1915.0`, and protocol=`codex`; it also retains legacy DisplayName/VisualElements=`ChatGPT` and Executable=`app/ChatGPT.exe`. A process filename or legacy MSIX display label alone should not be treated as proof of the ChatGPT Desktop product.

Read-only probe: `desktop-profile-readonly-probe.py`.
Evidence: `desktop-profile-readonly-evidence.json`, containing filename, zero-based decoded character offsets, excerpts, and SHA256 of each inspected JS file. These are minified bundles; offsets are character positions, not byte offsets or source line numbers.

| Installed bundle member | Character offset | Direct evidence |
| --- | ---: | --- |
| `.vite/build/bootstrap-Bj_1Kfw1.js` | 2171329 | `wwe()` first uses a nonempty CODEX_ELECTRON_USER_DATA_PATH and resolves it to an absolute path; otherwise defaults to appData/Codex. No macOS-only guard surrounds this choice. |
| same | 2201478 | `app.setPath(userData, wwe(...))` occurs before the single-instance-lock request. |
| same | 2201735 | `$9=Swe(...)` followed by `app.requestSingleInstanceLock()`. `Swe()` returns packaged && (!isMacOS || hasExplicitUserDataPath); a packaged Windows app requests the lock even for an explicit profile. |
| `.vite/build/startup-requirements-Da3KfG8r.js` | 99229, 99279, 100141 | When explicit Electron user-data is supplied, startup saves the incoming CODEX_HOME and restores it after shell environment loading. |
| same | 104466 | Supplied CODEX_HOME is resolved as an absolute path. |
| `.vite/build/application-network-startup-D74LEWDz.js` | 62950, 63236 | `yr()` and `br()` resolve process.env.CODEX_HOME before the default user `.codex` directory. |
| same | 260074 | Native app-server command builder `Ws()` creates env from `...process.env`, preserving CODEX_HOME. |
| same | 265909 | `sc()` explicitly sets CODEX_HOME=windowsCodexHome, but this is the **WSL** path, not the native Windows command builder; do not cite it as native injection. |
| `.vite/build/main-BGDKyzfM.js` | 1077677, 1078802 | An internal demo launcher sets both env variables and passes --user-data-dir when opening another app. It hardcodes `/Applications/ChatGPT.app` and `/usr/bin/open`. |
| same | 1080323 | `Lge()` only exposes that demo launcher under packaged, non-dev, **darwin**. It does not provide verified Windows profile-launch support. |

Interpretation:

1. A Windows launch with both distinct CODEX_HOME and CODEX_ELECTRON_USER_DATA_PATH is supported by concrete code paths; it is a reasonable experiment candidate.
2. That is not a completed Windows runtime test. Whether this Owl/MSIX installation accepts direct alternate-profile launch and whether its instance lock is truly isolated by that user-data root are unverified here. No supported Windows profile UI/launcher was found in the inspected paths.
3. Using only CODEX_HOME is insufficient for safe isolation: Electron UI/profile state would still use its default directory.
4. For T18, the plugin's **actual installed plugin root** must contain Chinese characters and a space, with real host trust and native callbacks. A Chinese workspace, alternate CLI/app-server, copied adapter shell test, or mock callbacks cannot substitute.
5. A future isolated profile must have separate profile/state directories, authentication and explicit user hook trust. Do not copy trust entries or credentials blindly or modify the default 0.2 profile as part of this read-only investigation.

Official docs consulted: the current OpenAI environment-variable page explicitly lists CODEX_HOME for CLI/IDE extension/app-server/installers; the Windows app page documents the native PowerShell environment and default user .codex directory. Neither inspected page documented a Windows parallel Desktop profile launch. Installed code is therefore the direct evidence above; this note does not claim a documented cross-platform feature guarantee.

## T09: queued human input can be invisible to B until after Stop judgment

Pinned official public source: tag `rust-v0.159.0`, commit `687a119f0fcaace47e1f1abcc77cec6c813fd6da` in `official-codex-0159`. The installed host reported 0.159.0; matching public release version is not a proof that every packaged byte is identical.

The relevant ordering is precise:

1. `codex-rs/core/src/session/turn_input.rs:694-718`: steering a UserInput creates a `TurnInput::UserInput`, reserves acceptance order, appends it to pending input, calls `extend_pending_input_and_accept_mailbox_delivery_for_turn_state`, and returns the accepted active turn ID. It does **not** invoke UserPromptSubmit in this path.
2. `codex-rs/core/src/session/turn.rs:424-446`: the model loop conditionally drains pending input; only then calls `run_hooks_and_record_inputs` with PersistContext::SteeredUserInput.
3. `codex-rs/core/src/hook_runtime.rs:677-713`: inspect_pending_input invokes hooks.run_user_prompt_submit only for TurnInput::UserInput. ResponseItem, FunctionCallOutput and InterAgentCommunication bypass it.
4. `codex-rs/core/src/session/turn.rs:647-655`: when sampling requires no follow-up, the loop **awaits run_turn_stop_hooks** synchronously.
5. `codex-rs/core/src/session/turn.rs:666-683`: a Stop block builds and records the hook continuation response item, accepts mailbox delivery, sets stop_hook_active=true, and continues the loop. The pending-input inspection from step 2 is reached on the later loop iteration.

Consequently, input steered while a synchronous Stop hook is waiting on true C can be accepted into the host pending queue without having invoked UserPromptSubmit. A B implementation whose human-input invalidation is driven by that callback may not yet see a changed input_epoch when the existing C judgment returns. On a block, the prior continuation is recorded before the next queue inspection in this path. This is a **source-backed host-boundary risk**, not a claim that a live native T09 failure was reproduced.

Required remaining native test: during actual JUDGE, submit real human input through supported Desktop input, record whether the UI steers or interrupts/restarts, observe the native callback/epoch timing, C cancellation/stale-result rejection, and any old continuation/DONE commit. If the host queues the input until after C commits, T09 remains open and the limitation needs a supported design response. Do not fabricate immediate callbacks to make the gate pass.

The current send_message_to_thread route is not a human-input test: observed delivery is a codex_delegation FunctionCallOutput; the explicit type match at hook_runtime.rs:705-708 skips UserPromptSubmit. It can exercise continuation scenarios but cannot establish native human-input invalidation.

## Computer Use scope clarification for the owner

Read the installed Computer Use SKILL.md and complete docs/guidance.md without initializing or operating sky. The exact denial is: `Do not automate the ChatGPT desktop app UI or Codex CLI or Codex extensions within Windows apps.` This text does not literally ban the independent **Codex Desktop** product established by the package metadata above. Treating the legacy executable name as a product-wide prohibition would overstate the instruction.

A real, user-authorized acceptance input into a verified Codex Desktop test chat is distinct from shipping a runtime B implementation that drives A with forbidden UI fallback. That distinction does not permit automated authentication, hook trust/security setting changes, guessed window handles, or inputs without sky's required observe/act/refresh workflow. The parent owns any UI action and must apply the actual current skill/tool requirements. No UI action was taken in this read-only assignment.

Current conclusion: **neither T09 nor T18 is passed by this investigation**. The exact unresolved host behavior is now localized without disturbing the live 0.2 or 0.3.3 sessions.
