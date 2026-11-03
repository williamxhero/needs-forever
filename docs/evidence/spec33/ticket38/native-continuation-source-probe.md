# Native Stop continuation source probe

Date: 2026-11-03. Read-only official-source inspection; no model requests, plugin install, trust writes, Desktop chat reads, or product edits performed by this probe.

## Provenance and limits

Official repository: https://github.com/openai/codex

`git ls-remote --tags https://github.com/openai/codex.git '*0.159*'` verified annotated tag `rust-v0.159.0` (`377f7f557a6bdea0f3a2d26d4d899c66db4789d0`) peeling to commit `687a119f0fcaace47e1f1abcc77cec6c813fd6da`.

A shallow sparse clone of that exact tag is saved under `.scratch/main-session-supervision/official-codex-0159`. Source line numbers below refer to that commit. Earlier raw HTTP attempts returned 404 and the API returned 403; they are not evidence. Git transport succeeded and supplied the actual inspected contents.

The installed Desktop-owned binary previously reported `codex-cli 0.159.0`. Matching release version and public source does not prove binary byte identity or eliminate vendor modifications. This source probe establishes public-tag implementation, not successful live Desktop execution. #38 Desktop acceptance remains independently required.

## Stop block continues the same turn and does not invoke UserPromptSubmit

1. `codex-rs/core/src/session/turn.rs:647-655`: on every model response that requires no follow-up, the active turn calls `run_turn_stop_hooks`, passing current `stop_hook_active`.
2. `codex-rs/core/src/hook_runtime.rs:392-467`: root sessions select `StopHookTarget::Stop` (line 445), construct `StopRequest`, call `hooks.run_stop`, and emit hook lifecycle events. There is no guard skipping hooks when `stop_hook_active` is true.
3. `codex-rs/core/src/session/turn.rs:666-683`: a block builds `build_hook_prompt_message(continuation_fragments)`, directly records/emits that response item, accepts mailbox delivery for the current turn, sets `stop_hook_active=true`, and executes `continue` in the same turn loop. It does not enqueue a `TurnInput::UserInput` or call `inspect_pending_input`.
4. `codex-rs/core/src/session/turn.rs:845-893`: normal pending inputs pass through `run_hooks_and_record_inputs`, which calls `inspect_pending_input` at line 866.
5. `codex-rs/core/src/hook_runtime.rs:677-713`: `inspect_pending_input` invokes `hooks.run_user_prompt_submit` only in the `TurnInput::UserInput` branch. Response items, function results, and interagent communications bypass that callback.

Therefore, in this exact official public implementation, Stop's continuation is user-role model context but does **not** re-enter the UserPromptSubmit callback. No heuristic based on continuation wording is needed for this native path. External mechanisms that actually submit a new UserInput remain separate and can trigger UserPromptSubmit.

Pinned source:
- https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/session/turn.rs#L647-L683
- https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/hook_runtime.rs#L677-L713

## Repeated same-turn Stop is supported

The loop above invokes Stop again after each continuation. `stop_hook_active` is passed through as input, not used as a host-side suppression flag.

Official test `codex-rs/core/tests/suite/hooks.rs:1321`, `stop_hook_can_block_multiple_times_in_same_turn`, mounts three model responses and two blocking reasons. It asserts three Stop inputs, identical nonempty turn IDs for all three (`1376-1402`), and `stop_hook_active == [false, true, true]` (`1403-1410`). This is inspected upstream test code, not a test executed locally.

https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/tests/suite/hooks.rs#L1320-L1410

## Command stdin has no native per-invocation identity

- `codex-rs/hooks/src/schema.rs:588-601`, `StopCommandInput`, consists of `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `stop_hook_active`, and `last_assistant_message`.
- `codex-rs/hooks/src/events/stop.rs:150-165` constructs exactly that struct and serializes it with `serde_json::to_string`.
- `codex-rs/hooks/src/engine/command_runner.rs:263-267` writes that serialized JSON directly to child stdin.
- `UserPromptSubmitCommandInput` (`schema.rs:567-583`) adds optional subagent IDs and prompt, but has no human/internal origin field or event/run identity.

The public protocol's `HookRunSummary.id` and continuation fragment `hook_run_id` must not be mistaken for a unique Stop occurrence. `ConfiguredHandler::run_id()` (`engine/mod.rs:158-164`) is deterministically `{event_name_label}:{display_order}:{source_path}`; `dispatcher.rs:237-249` places it into completed summaries. Repeated executions of the same configured Stop handler therefore reuse that ID.

Implementation implication: create a fresh adapter occurrence ID per native command process invocation and reuse it only for transport retries within that invocation. Do not deduplicate newly invoked Stop commands by `session_id + turn_id`, payload equality, `stop_hook_active`, or public `hookRunId`.

Pinned source:
- https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/hooks/src/schema.rs#L567-L601
- https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/hooks/src/events/stop.rs#L150-L165
- https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/hooks/src/engine/command_runner.rs#L263-L267
- https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/hooks/src/engine/mod.rs#L158-L164

## Additional #38 plugin hook discovery finding

- `codex-rs/core-plugins/src/loader.rs:1186-1240`: **Legacy** plugin hooks load from explicit manifest hooks when supplied, otherwise automatically from `hooks/hooks.json`. Explicit manifest `hooks` is not required.
- `loader.rs:950-960`: **AgentPlugin** manifests are explicitly assigned empty hook sources and warnings; only Legacy enters `load_plugin_hooks`.
- `codex-rs/utils/plugins/src/plugin_namespace.rs:12,48-65`: AgentPlugin is root `plugin.json` with the supported Agent Plugins `$schema`, and is preferred over legacy hidden manifests. It is not a `.agent-plugin/` directory. A dual-manifest artifact can therefore discover skills while silently skipping Legacy hooks in this release.
- `codex-rs/hooks/src/engine/discovery.rs:695-718`: untrusted hooks are included in list entries before execution trust filtering. Untrusted status by itself does not explain an empty `hooks/list`.
- `codex-rs/app-server/src/request_processors/catalog_processor.rs:652-668`: plugin hook sources require both `Feature::CodexHooks` and `Feature::Plugins`.
- `codex-rs/features/src/lib.rs:1220-1225,1452-1457`: keys `hooks` and `plugins` are both stable and enabled by default in the public tag. Local config/policy may override them.
- `codex-rs/plugin/src/load_outcome.rs:188-192`: only active plugins contribute hook sources. Active means enabled and no plugin load error (`load_outcome.rs:39-40`).

Pinned source:
- https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core-plugins/src/loader.rs#L950-L960
- https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core-plugins/src/loader.rs#L1186-L1240
- https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/utils/plugins/src/plugin_namespace.rs#L48-L65

## Supported 0.159 occurrence boundary and Windows startup fallback

A further bounded source read confirms `events/stop.rs:214` invokes the handler dispatcher once; `engine/dispatcher.rs:126-151` schedules each configured synchronous handler once and `execute_handler` calls `run_command` once. `command_runner.rs:263-324` writes one stdin payload and settles completion, failure or timeout without a handler retry loop. For this supported version, a native handler invocation is therefore the observable occurrence boundary. A relay-generated UUID belongs to the adapter transport envelope and must remain fixed across that invocation's IPC attempts; new invocations keep distinct UUIDs even with identical stdin/session/turn. Already accepted transport disconnect remains unknown and must not replay a direction.

The Windows contained-spawn fallback does not establish a second executed hook. Inspected with `git show HEAD:codex-rs/utils/pty/src/win/job.rs` at the same pinned commit: `prepare_suspended_spawn` sets CREATE_SUSPENDED and kill_on_drop(true); `spawn_contained` starts suspended, assigns the job, resumes only after successful assignment, and returns Ok only on a successful NtResumeProcess status. Errors drop the owned child. This is a process-start fallback before normal hook stdin handling, not an application-level rerun protocol.

Independent Spec review accepted this adapter contract as a way to implement the SPEC identity requirement without fabricating host occurrence metadata or deduplicating valid same-turn Stops. Public IPC retransmission tests and real Desktop live gates remain necessary; no live success follows from this source inspection alone.
