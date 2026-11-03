# Explicit control intent: read-only startup examples stay neutral

The newly confirmed loose-match bug allowed `rg start <installed-control>`, an echoed Node startup example, and a Code Mode string example to create `hook-observations` although the chat never invoked supervision. This change enforces the accepted opt-in requirement; it does not redefine those commands as startup.

## Public RED and GREEN

All checks use copied installed plugins and lifecycle native stdin/stdout. No private recognizer functions are tested. Only the existing external host/model fixtures are replaced.

`explicit-intent-red.txt` records three independently failing installed-copy tests against the previous a40025a adapter and bundled lifecycle implementation: rg, echo and Code Mode example each created `.codex-supervisor` (0/3 passed). Both old files were restored to the new candidate immediately after this RED probe.

`npm run plugin:build` passed. `explicit-intent-regression.txt` records the subsequent installed main-session, controller, supervision and plugin suites: **44/44 passed**. Coverage includes all three regression cases, comment/string/dead-branch examples, ordinary/doctor/status lifecycle callbacks before preparation, byte-identical state for a foreign uninvoked chat beside a pending task, and neutral callbacks after DONE. Legitimate direct Node, JSON Code Mode, unquoted-key Code Mode, assigned-result Code Mode, and absolute Node via PowerShell `&` still bind and start B. Existing same-A resume, Stop, continuation, pause, cancellation, independent verification and legacy worker behavior remain green.

## Implementation and supported entry

One shared `controlIntent` module guards both the native adapter's pre-observation filter and lifecycle receipt correlation. It tokenizes one literal Node command, checks exact installed script and operation argv positions, and correlates task/state flags as paths. It never evaluates shell or JavaScript. Code Mode accepts only a top-level literal `await tools.exec_command(...)`, optional `text(...)` wrapping, or a literal assigned result optionally displayed by `text(result)`.

Compound/dynamic/conditional JavaScript or shell forms remain neutral; a real preparation performed through an unsupported form stays pending. The prepare/start/resume receipt, skill and architecture document explain the supported grammar and explicit direct `resume --state FILE` recovery. Ordinary read/search/echo examples create no observations. The canonical SPEC records the user's opt-in supplement.

The host may still launch globally matching hook scripts and emit generic HookStarted UI before the plugin can inspect a session. Unconditional supervision `statusMessage` remains removed. No claim is made that this plugin can suppress host dispatch or all generic hook UI.

## Candidate and limits

`explicit-intent-package.json` records the new self-contained 0.3.0 archive, all 28 file hashes, its SHA256 and successful extraction/source parity. Archive: `runs/spec33-candidate/needs-forever-0.3.0-explicit-intent.tar.gz`; SHA256: `b43a73ece4ca44932ca89e7784f4d423d5eed7ab6037c86e196a412f5f9fbdaf`.

No installed package, hook trust, Desktop chat/checkpoint, global configuration or tracker state was changed by this repair. The previous archive and installed candidate do not include these bytes. Parent owns review, integration and the separately required real Desktop acceptance; simulated regressions do not satisfy that release gate.
