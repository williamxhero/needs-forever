# Ticket #37 evidence

All new process tests use an installed copied package with native-hook stdin/stdout and public control commands, durable status and model-protocol/artifact observations. Host identity/model responses are explicit external replacements: **simulated**, not real Desktop acceptance.

Vertical red/green observations:

- Native Interrupt during delayed judgment initially returned ACTIVE instead of PAUSED. The same installed-process assertion passed after durable pause and cancellation fencing.
- New input invalidated judgment, but same-turn observed usage initially stayed zero. Counting distinct observed native turns made the canceled-old/later-valid-Stop case pass with exactly one turn.
- Explicit same-A resume initially failed with the unsupported-command error; the implemented challenge correlation, owned retirement and generation rotation passed. A foreign A cannot activate the checkpoint.
- Public plugin status initially omitted main-session control mode. Routing before legacy mutation now exposes the correct mode; direct core CLI rejects main-session resume, and default plugin start remains pending native binding.
- Pause during pending native binding initially allowed the late PostToolUse receipt to activate B. Durable pending pause now prevents activation.

Additional checks cover delayed real-judge-boundary and isolated-verifier responses invalidated by fresh input, current-epoch evidence and prompt context, visible 5-second retry after invalid C JSON, concurrent independent registrations in one workspace, foreign/stale/identified duplicate Stops, host SessionStart recovery without replay, cumulative turn/time limits, and existing missing-mode independent-worker control behavior. Current task snapshots are redacted before sending to C, not only on persistence.

The first full regression ran 104 tests: 103 passed and the prior host-only missing-supervisor fixture timed out because the new recoverable-error loop retried its permanent fixture configuration error. The fix identifies the absent explicitly required fixture adapter before the retry loop and retains RECOVERING immediately. Real transient judge/transport failures continue to use deadline-bounded backoff.

Native host/event-id and internal continuation-prompt limitations are recorded in `docs/main-session-architecture.md`. Fixture `event_id` support is not proof that Desktop provides that field. Required live Desktop gates belong to #38. No global installation/configuration/trust changes, new Desktop chats, real model run or host restart was performed here.

Final build, copied-package targeted checks and full regression results are recorded in `validation.json`. Generated runtime and integrity manifest are committed with source.
