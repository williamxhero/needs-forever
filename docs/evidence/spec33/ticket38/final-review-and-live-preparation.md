# Final review and authorized live preparation

Recorded 2026-11-03, after integration `4a053c31bea2aa325451b9705f9e21f4152113d2`. This supplement updates the historical pending-review/install status in `report.md`; it does not declare native acceptance or delivery complete. No runtime code changed for this record.

Final independent review at that integration revision: Standards has **0 findings / 0 blockers**; Spec has **0 unresolved code findings** after the generated demo contract correction. The earlier dispatch duplication suggestion is deferred as an advisory refactor; State structure is not a finding. Required live acceptance remains a separate completion gate.

The user explicitly authorized installing candidate 0.3.0 alongside the existing plugin and creating/driving an independent Desktop acceptance chat, including later test instructions and pause/resume. The user did not authorize scripted trust changes. Parent performed the installation and chat preparation; this record only copies and checks the resulting receipts.

## Installation and preservation evidence

`live-preparation/upgrade-probe.json` records an isolated upgrade experiment: canonical `needs-forever-local` replacement removes the old cached version. Therefore the real installation used a separate marketplace, `needs-forever-spec33`. `live-preparation/sidecar-install-probe.json` records the isolated side-by-side experiment, where old cache preservation and the new candidate package comparison pass.

Actual authorized installation receipt: `live-preparation/installation.json`, timestamp `2026-11-03T09:30:48.527Z`. Desktop binary reports `codex-cli 0.159.0`. Installed plugin identity is `needs-forever@needs-forever-spec33`, version 0.3.0, at `C:/Users/will/.codex/plugins/cache/needs-forever-spec33/needs-forever/0.3.0`. Its 26 package-file hashes match the previously verified release exactly. The original `needs-forever-local/needs-forever/0.2.0` package's before/after hashes match exactly; the original version is preserved. No trust was written by script.

`live-preparation/real-home-discovery.json`, timestamp `2026-11-03T09:34:21.69Z`, records a **fresh owned discovery app-server using the Desktop binary and real CODEX_HOME**. It is not execution by the existing Desktop owner or acceptance chat A. It discovers all six candidate hooks, all enabled, unmanaged and **untrusted**, with no warnings/errors. PostToolUse timeout is 60 seconds; Stop is synchronous with 600 seconds. The receipt explicitly retains `native_execution: not_run` and `trust_written: false`.

## Acceptance chat and fixture

Bootstrap Desktop chat A: `01a1a0bf-c5d2-74e0-9eae-cf2d38a20cb7`. Observed actual workspace/cwd: `C:/Users/will/Documents/Codex/2026-11-03/needs-forever-spec33-desktop`. The prepared three-stage fixture was relocated there **before task start**; it does not rely on changing only a shell command's workdir. `live-preparation/preparation.json` records task/state/control argv, A identity, the three original acceptance items' preparation context, and both protected script hashes. Its status remains preparation only / native acceptance not_run.

The fixture is under that workspace's `.spec33-fixture/`; its task has not started. The protected fixed verifier SHA256 is `67e694431651f1d05641c54bb582a52d955c19caee859bcd4af51bf2f4e7f4cb`; the unavailable-route script SHA256 is `6913afee30405571d3e098aca045a61b68b7ae0967afd87bbc6ab8eedcf0add8`.

Route receipts are preserved as `live-preparation/route-record.json`, `route-readback.json` and `route-receipt.json`. A inherits the Desktop configured `gpt-6.1-sol` / `xhigh` route; validation decision is `allow` with formal identity/configured-route readback. This readback is not supervision binding or execution evidence; the route receipt explicitly marks execution evidence unavailable.

## Remaining gates

At the receipt snapshot, the next required step is the user's own **Settings > Hooks review and trust** of the candidate, plus any Desktop-requested reload. No script may copy trusted hashes or bypass that review. Only afterward may the authorized prepared task start and establish the actual A binding, automatic B, independent C and native continuation evidence.

**T01 has not passed.** T01/T02/T03/T04/T06/T07/T08/T09/T11/T15/T18/T20 remain live `not_run`; neither real-home discovery nor creating A replaces those observations. Begin with T01 → T02 → T07, then expand the required native fault/recovery matrix. Required main merge, worktree cleanup, push/remote equality and tracker completion/closure remain outstanding. Ticket #38 and SPEC #33 must stay open until all required gates pass.

This documentation-only update uses the existing successful tests/review receipts. The full branch-range whitespace check is `git diff --check 1bae005697e902a9fc3b93f5f04bb333f8ccd87d...HEAD`; no unrelated full regression was repeated.

## Subsequent negative-entry evidence

The later `live-preparation/native-untrusted-entry.json` receipt records actual A's completed native tool turn `01a1a0c8-1b67-7943-b778-18323acaf758`: installed doctor/start/status ran successfully at the correct cwd, but the task stayed PAUSED/RECOVERING with PENDING_NATIVE_HOOK, no bound main session/controller and hook_effective false. This advances only the T16 pending-entry branch to **live_partial**. It does not establish why the current owner skipped binding, prove trusted hook execution, or pass T01/continuation/DONE. PAUSED is an initial pending checkpoint, not an observed user pause; the checkpoint and protected baseline are preserved. The detailed matrix and limits are updated in `report.md`; all required native completion and delivery gates remain open.
