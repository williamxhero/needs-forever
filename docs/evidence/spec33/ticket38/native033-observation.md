# 0.3.3 native Desktop observation checkpoint

Date: 2026-11-03. Evidence class: actual Desktop A execution and real independent C model sessions. This is a bounded observation report, not final #33 release acceptance. All times below are UTC; Singapore local time is UTC+8. The sibling `native033-observation.json` contains sanitized exact event IDs, source paths/hashes/line numbers, selected policy fields and native log row references. It excludes controller authentication values, credentials, protected content and unneeded raw transcript text.

The original A is `01a1a0bf-c5d2-74e0-9eae-cf2d38a20cb7`, cwd `C:/Users/will/Documents/Codex/2026-11-03/needs-forever-spec33-desktop`. Actual turn `01a1a13a-6c80-7970-90c1-2485e1b09511` used installed candidate 0.3.3. Native provenance reports Desktop `codex-cli 0.159.0` separately from C CLI `codex-cli 0.166.0`. Source evidence is the original `.spec33-fixture/events.jsonl`, checkpoint and exact A/C rollouts; transcripts are diagnostic evidence, never the binding protocol.

## Observed matrix

| Gate | Current actual evidence | Remaining limit |
| --- | --- | --- |
| T01 | Original A bound at 11:45:39.292; B automatically started at 11:45:40.356. `main_session_id` matches A, `host.source=native-desktop`. | This run resumes the preserved original checkpoint; it does not manufacture a new start or second worker. |
| T02 | First real Stop produced independent C CONTINUE, then actual A stage2 tool evidence confirmed its delivery. | Returned hook text is counted separately from subsequent actual execution. |
| T03 | Two distinct actual Stops and two fresh Cs continued the same native A turn into stage2 and final stage. | This is real same-turn repetition, not a simulated substitute. |
| T04 | The deliberately unavailable route actually exited 23; A used the authorized direct-file alternative and preserved the failed-route marker. | A changed route before the first C. This does not yet prove the specific C-guided alternative-route scenario. |
| T06 | C3 returned DONE; fixed verifier exited 0, but B rejected completion with `workspace_changed=true`, `passed=false`, then returned CONTINUE. | This establishes gate rejection only. A genuine failing-verifier or protected-file-change live branch remains separately required. |
| T07 | Three stage artifacts and A's direct verifier passed. | B did not persist DONE/release: checkpoint self-mutation was diagnosed as contaminating the workspace comparison, and a fix is in progress. No T07 pass claimed. |
| T08 | Public pause persisted PAUSED/IDLE/user at 11:54:37.182; B is exited; zero direction-return events occur after that timestamp through A completion. | Latest C direction had already returned at 11:54:34.557. This is not a successful in-flight JUDGE cancellation race. |
| T09 | Not established in this run. | A newer human prompt during a still-running C requires its own actual observation. |
| T11 | Four Cs completed, archived, and did not recurse. A separate genuine ordinary Desktop chat also completed once with no task state, model/tool continuation or attributable B. | Point-in-time process metadata covers this exact ordinary workspace; it does not assert no global B/C processes or no generic host hook launches. |
| T15 | Earlier genuine Desktop restart was followed by successful original-A binding. | Closing/reopening an already-bound task and explicit same-A recovery remain separately required. |
| T18 | Updated installed 0.3.3 commands executed in actual Desktop PowerShell. | Chinese/space package-location cases currently have actual shell plus simulated-host evidence, not a live Desktop package installed at such a location. |
| T20 | A model/effort, approval and permission policy match before/during supervision; selected tool feature flags stay enabled in A while disabled in C. C actual read-only/restricted-network policies are independently visible. | Complete dynamic A tool inventory was not retained, so no byte-identical all-tools claim is made. |

## Two actual continuation chains

1. Stop `1953ce54-572e-48e5-961f-7ad13b84602d` at 11:47:32.624 created C1 `01a1a13c-69a9-7833-a44e-51533296fa8c`. C1 directed Stage 2 and was archived. B returned delivery `f2994727-1be7-4f2b-83c1-f0ecdac60124` at 11:47:44.499 with execution_confirmed=false. The actual stage2 tool `exec-153f4e87-aa42-4365-b3ed-d617e672cc19` completed at 11:48:10.744; event `cb34005d-81d4-4e3c-9e76-bcb08e724574` confirms that delivery using matching A/turn/tool evidence.
2. Stop `e3b6873f-4a37-4b92-aacd-e5b6a774cb52` at 11:48:20.640 created C2 `01a1a13d-254c-7940-a797-4f608f0ddca9`. C2 directed Stage 3 and was archived. Delivery `58eb5527-d5df-4f1f-9ed0-0f79661adc98` returned at 11:48:39.816. Actual final-stage tool `exec-d579b60b-c21a-4a31-b31d-740690f2f30b` completed at 11:49:05.402; event `f9ad4dbd-b78b-48de-9a7e-12ff4ad50977` confirms its execution. Both chains retain the original A and the same native turn.

The JSON retains the two exact C directions and their event IDs. C3 `01a1a13e-2216-72b1-bf20-254829bd7d44` subsequently judged DONE, but verification event `727f3f18-6856-4333-b4cf-108bfa100094` at 11:49:47.499 rejected completion despite exitCode=0. This is why C wording is not reported as task completion.

## Isolation and non-recursion evidence

C1/C2/C3/C4 (`01a1a141-f9f7-7481-9772-b3040cca4dbb`) are distinct archived CLI0.166 threads. Each archived rollout has exactly one task_started, one task_complete and zero function/custom tool calls. Their actual thread settings show approval never, managed filesystem root read access and restricted network; their turn contexts show sandbox read-only. Native feedback rows 184782829, 184784764, 184788174 and 184800896 independently show apps/browser_use/computer_use/hooks/plugins=false. All recorded native Stop events in this generation belong to A, never a C.

The separate ordinary Desktop chat `01a1a147-3fc3-7b20-9a00-b9c01549fb5a` (`SPEC33 普通聊天无监督验收`) completed native turn `01a1a147-440a-7872-ae08-5b416ec1f547` after its bootstrap reply. Its exact rollout records one task start/completion and zero function/custom tool calls. The workspace `C:/Users/will/Documents/Codex/2026-11-03/spec33-ordinary-neutral` contains only empty host-created outputs/work directories, zero files and no `.codex-supervisor` registration. A narrowly attributed process snapshot found no Node controller for that workspace. Effective feedback row 184818026 shows hooks/plugins/apps/browser_use/computer_use remain enabled for this ordinary chat. No automatic model/tool continuation was observed. Transient native HookStarted/Completed records are not retained in its rollout, so the durable record does not establish exactly which neutral hook command ran; installation does not imply globally zero hook dispatch or Node launches.

A before turn `01a1a127-8db6-71e2-be86-2d1bda46922a` and during the bound turn remains gpt-6.1-sol/xhigh, approval never, danger-full-access, same cwd and permission profile. A feedback rows 184721715 and 184789931 preserve apps/browser_use/computer_use/hooks/plugins=true across C judgments. This demonstrates that C-local restrictions did not change those A settings. The production connection also validates disabled web/MCP features before C creation, and validates readOnly/networkAccess=false/never on thread creation. Actual successful C runs traversed those guards; the detailed MCP config/read responses themselves are not retained, so that final detail is an implementation-backed inference.

## Pause timeline and final checkpoint

C4's CONTINUE returned at 11:54:34.557. The public pause saved the original state at 11:54:37.182, 2.625 seconds later. Original A completed its native turn at 11:55:45.612. Observed state is PAUSED/IDLE with pause_reason=user, binding still BOUND to original A, controller lifecycle exited. There is no direction-return event after the pause. Work already delivered before pause may finish; these timestamps do not prove that an active C was cancelled or that late C results were suppressed.

No implementation, original checkpoint, chat, trust, installation or configuration was changed while collecting this report. #33 remains open pending corrected native T07 and the remaining actual matrix branches.
