# Ticket 38 candidate report — delivery gates remain open

Date: 2026-11-03. SPEC #33 / ticket #38. Candidate plugin/core version: 0.3.0. Implementation baseline: integration `9b063d82d6614a0d4ff7e62dfcbcc93738e0587f`. This report records preparation and isolated discovery, not live Desktop A acceptance. No global install, trust write, model call, chat creation, main merge, push or issue closure occurred in this ticket worktree.

## Observed environment and installation

Windows release and Node version are captured by each install receipt (`os`, `node`): Windows 10.0.26300, Node v24.19.0. Running Desktop app version 26.928.20755 was established by the parent Desktop probe; its actual binary reports `codex-cli 0.159.0`. The separately installed npm executable reports `codex-cli 0.166.0`. These are distinct installations.

Every receipt records executable and exact argument arrays, neutral cwd, isolated CODEX_HOME, install output, initialize response, raw skills/list and hooks/list, installed path and every package file's SHA256. Both subprocess installation and discovery use windowsHide and direct argv. Only the owned fresh discovery app-server is terminated. No auth/config/trust is copied from the user's real home. The CLI itself creates config for the isolated marketplace and plugin installation. No hook handlers are invoked by this probe.

Before: `desktop0159-install.json` and `npm0166-install.json` show skills discovery and exact installed/candidate hashes, but empty hooks/list. Setting process-only `features.hooks=true`, then hooks+plugins=true, did not fix this. Those failing receipts are retained. Both features were enabled by default in the Desktop binary's isolated `features list` output.

Root cause: official `rust-v0.159.0`, commit `687a119f0fcaace47e1f1abcc77cec6c813fd6da`, selects root `plugin.json` AgentPlugin format before `.codex-plugin/plugin.json`; core-plugins/src/loader.rs:950–960 deliberately supplies no hook sources for AgentPlugin. Legacy format calls load_plugin_hooks, which finds hooks/hooks.json by default (1186–1240). Adding a hooks field to the root format cannot repair this branch.

After: the candidate keeps only canonical `.codex-plugin/plugin.json`, with plugin package version also 0.3.0. `desktop0159-legacy-final-install.json` and `npm0166-legacy-final-install.json` both PASS discovery and exact package equality. Six events are reported: sessionStart, preToolUse, postToolUse, stop, userPromptSubmit, interrupt. Every hook is `enabled=true`, `isManaged=false`, `trustStatus=untrusted`; Stop is synchronous with timeoutSec=600. `*-legacy-install.json` retains the first after-run: raw discovery was successful, while the script incorrectly compared protocol lowerCamelCase event names to manifest PascalCase names. The corrected final runs use the actual protocol spelling. Build and public packaging checks prevent reintroducing root AgentPlugin format or mismatched versions.

Untrusted discovery is expected and does not prove hook execution. The currently running Desktop owner was never attached, resumed or reconfigured by these probes. A fresh app-server using the Desktop binary does not establish that the Desktop UI loaded this candidate/home. A and C identities, native events, actual continuation and native verifier execution therefore remain absent for #38.

## TDD and regression evidence

Confirmed public seam: installed plugin controls and native lifecycle stdin/stdout → state/activity/artifacts; external host/model replacement is simulated.

- Demo preparation: missing preparation script failed first, then public preparation/start passed. Its unchanged verifier failed with absent outputs, deliberate route returned exit 23, exact three outputs made the verifier succeed, installed start stayed main-session/PENDING_NATIVE_HOOK without any native event. No claim of actual supervision follows from this test.
- Discovery receipt: original script ignored the requested isolated destination and did not produce the expected report (red). New explicit executable/candidate/directory interface plus external host fixture passes with six untrusted hooks and native effectiveness `not_run` (green). Actual Desktop/npm installation exposed and repaired the packaging failure above.
- Review fix, version: installed status exposed null after a successful version preflight (red); version is now copied after rereading persisted state and after the startup cancellation/deadline gate, and installed status reports `codex-cli 0.166.0` (green).
- Review fix, privacy: an external judge sends an unexpected server request whose method contains an explicitly fake sk canary. That refusal is a recoverable error. The canary appeared in persisted state (red). Recovery now redacts new and historical failure records before save and defensively redacts repeated failures before sending C. Installed status, state and the next C input contain no canary (green). Earlier RPC-error and malformed-JSON probes were already redacted/truncated upstream and could not reproduce the leak; they were replaced by the discriminating refused-request case.
- `npm test` first complete run: 107/107 pass, no skipped tests; output in `full-tests.txt`. After the additional occurrence contract below, all affected main-session/controller/supervision tests passed 32/32 (`occurrence-regression.txt`), followed by the final complete run: 108/108 pass, no skipped tests (`final-full-tests.txt`). These include legacy independent-worker regressions and installed runtime integrity checks.
- `npm run plugin:build`: PASS, 16 self-contained runtime modules. Public demo/discovery focused rerun: 2/2 pass. `git diff --check`: PASS.

Additional occurrence contract: an external relay process talks to the real installed B's public authenticated named-pipe protocol. Initially, duplicate requests returned empty success (red). The adapter now generates one UUID per native command invocation in the IPC envelope, distinct from native stdin metadata; B durably records accepted occurrences before C and reuses that identity as StopRequest.stop_attempt_id. Concurrent and completed replays explicitly fail without disturbing the original hook or causing another C/delivery. A new invocation with identical stdin remains independent. The public test proves one C/delivery for replay, three further judgments for three identical native invocations, and rejection of an old occurrence after new input, pause and same-A resume. Existing disconnect/deadline tests still pass. No automatic IPC retry was added: an admitted disconnected occurrence stays unknown and cannot replay a direction.

Final candidate is staged under worktree `runs/spec33-candidate/final-package/` and archived as `runs/spec33-candidate/needs-forever-0.3.0-final.tar.gz`. SHA256: `3070e743b25becca85ca36fec618f610dc1783f94530436cbc19a6cc36fafca4`. The archive contains the local marketplace and complete plugin, including canonical dot-directory manifest. `desktop0159-release-install.json` and `npm0166-release-install.json` are the final candidate receipts: both discovery PASS, package hashes match, all six hooks remain untrusted, and PostToolUse now has timeoutSec=60 to cover native-host inspection plus the bounded startup preflight (formerly 30). runtime/integrity.json provides executable module hashes. Earlier non-final archives and receipts remain diagnostic history, not the final candidate.

## Acceptance matrix

`simulated` means actual process-level tests with replacement host/model; it does not mean native Desktop passed. Every required native case is still `not_run`. References are the source public test suites whose observed full run is captured above.

| Case | Available evidence | Real Desktop A result |
| --- | --- | --- |
| T01 | simulated: installed pending/binding and automatic independent B; live isolated installation/discovery only | not_run |
| T02 | simulated: Stop returns direction, only subsequent matching A tool activity confirms continuation (`main-supervision`) | not_run |
| T03 | simulated: fresh C on consecutive Stops within same turn; no session+turn dedup | not_run |
| T04 | partial simulated preparation: deliberate exit 23, exact alternate-route files checked; actual C-guided alternative remains untested | not_run |
| T05 | simulated: unsupported DONE/WAIT_EXTERNAL claims refused | not_run |
| T06 | simulated: verifier failure, protected-file change and workspace-change completion refusal | not_run |
| T07 | simulated: stable fixed verification reaches DONE/releases binding | not_run |
| T08 | simulated: Interrupt/pause durable before late judgment; same-A explicit recovery; native work/verification interruption still needed | not_run |
| T09 | simulated: human input invalidates delayed judgment; later current-epoch Stop remains valid | not_run |
| T10 | simulated: persisted adapter-occurrence admission, concurrent/completed replay rejection, three identical fresh invocations; foreign/stale Stops and B leases | not_run |
| T11 | simulated: foreign/independent C callbacks cannot supervise A or recurse | not_run |
| T12 | simulated: invalid judgment retries within callback; refused-request recovery redacts secret formats | not_run |
| T13 | simulated: timeout/disconnected hook become recovery checkpoints without replay | not_run |
| T14 | simulated: traced external condition returns WAIT_EXTERNAL and recovery details | not_run |
| T15 | simulated: host restart requires explicit same-A native receipt, baseline/counters retained | not_run |
| T16 | live isolated: six discovered hooks explicitly untrusted; simulated pending binding refuses to claim active supervision | not_run |
| T17 | simulated: status is read-only, cumulative explicit limits pause, default limits absent | not_run |
| T18 | simulated Windows native command and installed copies in Chinese/space paths; live isolated package discovery/integrity at recorded paths | not_run |
| T19 | simulated: full existing independent-worker regression in 107-test suite | not_run |
| T20 | simulated: C readonly sandbox/tool isolation configuration and no thread/resume A requests; live Desktop permissions untested | not_run |

## Concrete live entry and remaining gates

An isolated three-stage workspace and full launch prompt are prepared at `runs/spec33-candidate/corrected-desktop-demo/`. Tracked copies: `desktop-demo-preparation.json`, `desktop-demo-task.json` and `desktop-launch-prompt.txt`. The prompt explicitly starts installed control.mjs (default main-session), retains all three acceptance items, uses a fixed protected verifier plus unavailable first route, and asks A to end each response after at most one unfinished stage between consecutive Stop attempts. A continued response performs the next stage even when Desktop retains the same native turn. Preparation did not execute the prompt, create a checkpoint or start a model. Its command currently references the isolated installation; a real Desktop installation must regenerate the prompt with the actual installed plugin path. Open the actual Desktop chat at the generated demo workspace: changing only exec_command workdir inside a repository chat leaves native event.cwd unchanged and cannot bind this task.

Next required human-host gate: review/install the concrete candidate in the intended Desktop, review its hooks through Settings > Hooks and reload if requested, then run the prepared goal in an authorized Desktop chat. Do not copy trust hashes or use a bypass. Begin with genuine T01 → T02 → T07, record A/C identities and event/delivery/tool evidence, then expand the required native failure/recovery matrix. Trust review alone cannot close behavior gaps.

Exact-version source supports internal Stop continuation staying in the original turn: core/src/session/turn.rs:666–683 records the hook block prompt directly, sets stop_hook_active and continues the loop; UserPromptSubmit dispatch is on TurnInput::UserInput in hook_runtime.rs:677–713. The exact dispatcher executes each configured synchronous handler once without an application rerun loop. On Windows its fallback starts suspended with kill_on_drop, assigns the job, then resumes; failed setup does not establish a previously executed hook. This supports native command invocation as the adapter occurrence boundary for 0.159, without inventing event_id or origin/isHuman stdin fields. Pinned-source evidence and line references are tracked in `native-continuation-source-probe.md`. This remains source-backed evidence and simulated public-IPC coverage, not an observed live T02/T03 result or a blanket compatibility guarantee for future host versions.

Final independent Standards/Spec review, any resulting fixes, all required native acceptance, main merge/cleanup/push/equality and tracker closure remain parent-owned delivery gates. Ticket #38 and SPEC #33 must remain open until those gates pass.

## Final review correction

Based on integration `5f0cae8949df0a1ece1f042cea4c22380ccdcaf0`, the final Spec review identified an inherited legacy demo constraint, “one unfinished stage per turn,” which conflicts with supported native same-turn Stop continuation. The main-session preparation now changes only that exercise pacing to one unfinished stage per response between consecutive Stop attempts and expressly permits the next stage in the same native turn. The legacy `prepare-s2-demo.mjs` contract remains unchanged. The public generated-contract test failed on the old per-turn wording (`demo-boundary-red.txt`) and passed after correction (`demo-boundary-green.txt`), while still checking all three acceptance entries, the deliberate route failure, exact independent verifier output and pending main-session start. `npm run build` passed; this localized preparation/documentation correction does not change installed plugin bytes, so the candidate archive and SHA256 above remain valid.

The saved task/prompt/preparation have been regenerated from the corrected script without starting a model or native chat. README now consistently names the sole canonical manifest. Final Standards review reports zero hard findings and zero blockers; dispatch duplication is deferred as an advisory refactor, and State structure is not a finding. Final Spec approval of this correction remains pending independent verification.

Final branch-wide whitespace verification uses `git diff --check 1bae005697e902a9fc3b93f5f04bb333f8ccd87d...HEAD`, rather than only the unstaged diff. The earlier branch check failed on CRLF evidence text in ticket34/final-checks.txt and ticket38 evidence; those affected tracked files were normalized to LF without changing their lines' content. The complete fixed branch check passes; no unaffected regression suite was repeated for this line-ending correction.
