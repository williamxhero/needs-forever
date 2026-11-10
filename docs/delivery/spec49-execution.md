# SPEC #49 execution record

Current SPEC: [C 2.0 evidence-constrained route planner](https://github.com/williamxhero/needs-forever/issues/49).

Started 2026-11-10 (Asia/Singapore). Baseline: `921708f637a1588fa135cb72ddda8cbbddc51cff`.
Integration branch: `codex/spec49-c2-integration`.

## Procedure and sources

The user invoked `implement-spec` and `implement-spec-to-done`. Skills are executed by loading their actual `SKILL.md` instructions; this environment does not provide a separate Skill invocation tool. The installed implementation procedure requires a fresh implementer in a dedicated worktree per ticket, a merger, TDD at approved public interfaces, and independent Standards and Spec reviews.

The user approved the five-ticket split on 2026-11-10. Each ticket body was uploaded using a UTF-8 file without BOM and read back for equality. GitHub native sub-issue and blocking relationships were created and independently queried.

| Ticket | Deliverable | Blocked by | Stage |
| --- | --- | --- | --- |
| #50 | Route contract and durable catalog/ledger | None | Integrated and targeted tests passed |
| #51 | Shared context and structured C2 planning | #50 | Integrated and targeted tests passed |
| #52 | B route delivery, correlation and repetition guard | #51 | Integrated and targeted tests passed |
| #53 | NFG route audit display | #51, #52 | Integrated and targeted tests passed |
| #54 | B0QI regression, installed runtime and delivery evidence | #50, #51, #52, #53 | Implemented; release acceptance prepared; independent review/delivery pending |

## Completion gates

Source: #49 Execution and Delivery; `implement-spec-to-done`, stages 2–5.

1. Read the complete SPEC and comments; validate the ticket graph and native relationships before code.
2. Implement each dependency frontier with red/green tests at the approved route-planning, supervisor and Web interfaces. Merge ticket branches into the integration branch through a merger.
3. Verify schema, route facts, persistent attempts, semantic repetition, context budgets, selected-route delivery, legacy compatibility and NFG asynchronous rendering.
4. Run full regression and installed-runtime checks. Label simulated model/host evidence separately from live model and actual local installation evidence. Verify the B0QI/Tushare scenario without weakening the original task acceptance or inventing provider availability.
5. Perform independent Standards and Spec reviews against the baseline, fix all actionable findings, and rerun impacted checks.
6. Merge the integration result into main and verify. Prove every created branch is included and worktrees contain no unsaved changes; archive the created worktrees and safely delete merged temporary branches.
7. Push main and fetch/read back identical local and remote SHAs.
8. Publish acceptance, review, delivery, cleanup and equality evidence to the tickets and SPEC; read back before closing completed tickets and #49.

Issue closure is not authorized by code completion alone. Required real acceptance that has not run remains an outstanding gate. Existing global NF/NFG hosting and B binding/recovery semantics remain in place.

## Public test interfaces

The approved SPEC and ticket split define these interfaces: route catalog/ledger and validated planner decisions; the supervisor's persisted state/events and installed CLI/Stop adapter; NFG HTTP/visible browser behavior. Tests must exercise these public interfaces rather than private helper call order.

## Progress

- Native graph readback: #49 has #50–#54 as its sub-issues; blocking edges match the table.
- Initial working tree was clean and main matched origin/main.
- #50 implementation worktree created from the baseline. No other SPEC is being implemented by this execution.
- #50 integrated on 2026-11-10: source `25877a82f115e3f1bef6acf37fe82699a5bf9679` included the then-current integration tip `58ab458a895720b2e68bbbb76720c146f8f721ba`; ordinary `--no-ff` merge commit `4f568bd61f259645324647cb025bb259f674767a` preserves both histories.
- #50 integration verification: `npm run plugin:build` passed (27 runtime modules); `node --test dist/test/routes.test.js` passed 7/7 with no skipped or failed tests. The build produced no tracked changes. Release-wide checks and issue delivery/closure remain outstanding.
- #51 integrated on 2026-11-10: source `c831843092eeafd5eb2820064045cf91b71e021c` contained the clean integration tip `5e17ffe19d6deae8db6db17d78393f4d982125f3`; ordinary `--no-ff` merge commit `9593bbe532ef62c4b2cd30b9e578fa20b76fa29d` preserves both histories.
- #51 integration verification: `npm run plugin:build` passed (31 runtime modules); `node --test dist/test/planning.test.js dist/test/routes.test.js` passed 18/18 (11 planning and 7 Route Catalog/Ledger tests), with zero failures, cancellations or skips. The build produced no tracked changes.
- #51 public API coverage: `validateDecision(raw, snapshot)` remains the active boundary with terminal proof gates; `validateC2Decision`, `routeInventoryDecision`, `readHistoricalDecision`, `buildC2Context`, `effectiveC2Mode`, `snapshotRouteEvidence`, `buildSnapshot` and `buildMainSessionSnapshot` expose planning validation, bounded shared context and historical reading. The current tests cover missing-fact inventory, Tushare-limit route substitution, invalid evidence/identity/availability/fallback/message rejection, semantic third-attempt rejection, terminal proof and explicit exhaustion gates, legacy/shadow/enforce behavior, both snapshot paths and the 24000-character budget, stable content digests, substantive alternatives, and built plugin runtime API parity. That runtime import test is build-artifact evidence; live model/host acceptance and actual installed-runtime delivery remain release gates.
- #52 integrated on 2026-11-10: source `80a71281f27a04dbe02c384268d43fcfb462348f` contained the clean integration tip `541e69ee7b5f11c8a3c4176f4a98b4586fbfe3cf`; ordinary `--no-ff` merge commit `37a5763a79b31edf724194330bd9946030652138` preserves both histories.
- #52 integration verification: `npm run plugin:build` passed (32 runtime modules); `node --test dist/test/routes.test.js dist/test/planning.test.js dist/test/route-execution.test.js` passed 27/27, with zero failures, cancellations, skips or todo tests. The build produced no tracked changes. See [ticket #52 implementation and evidence](ticket52-b-route-execution.md) for delivery correlation, persisted outcomes, source-linked evidence, repetition guards, bounded inventory fallback and recovery behavior. The full release suite and installed live acceptance remain outstanding.
- Root preflight operations note (reported by the coordinating agent): the existing global installed 0.3.4 daemon was absent. The coordinating agent restored its existing installed `scripts/daemon.mjs` with the saved three workspaces; PID `43712` served ports `8788` and `8790` with HTTP 200, and B0QI was `ACTIVE` / `WORKER` after 11 rounds. This restored the existing installation; no C2 candidate was deployed.
- Root pre-UI full regression at the #52 integration state: `.scratch/c2-pre-ui-test.log` records 184 tests, 164 passed and 20 failed. The failures comprise 19 tests in `test/cli.test.ts` using old fixtures and one installed-copy test in `test/plugin.test.ts`. #54 owns these repairs and the full regression rerun; the release is not green.
- #53 integrated on 2026-11-10: source `6d93f8c919695da98cbe07c1cada061fe1a2dcd1` contained the clean integration tip `096ff8c05037a45ca1e24ba24d7b48e0324bf58b`; ordinary `--no-ff` merge commit `e23d088ac885803a7b0b6fce16412c9a5c851bbd` preserves both histories.
- #53 integration verification: `npm run plugin:build` passed (32 runtime modules); `node --test dist/test/web.test.js` passed 16/16 with zero failures, cancellations, skips or todo tests. The build produced no tracked changes. See [ticket #53 implementation and evidence](ticket53-nfg-routes.md) for the route projection, complete audit fields and stable folded display.
- #53 public interface coverage: the source HTTP/API tests verify the complete C2 route audit and read-only virtual legacy route projection, including unchanged historical event bytes. Rendered-client tests execute the complete served inline script against the real loopback server with a small DOM adapter, exercise wired controls and the timer callback, and verify compact/expanded audit rendering, honest candidate status, task/Stop/plan expansion identity after round insertion, replacement-plan isolation, disabled refresh, and escaped hostile model text and keys. This is source API and rendered-client evidence; actual browser layout and installed-runtime acceptance remain #54 release gates.
- #54 implementation repaired explicit simulated legacy fixtures while retaining independent proof, added reproducible self-contained/installed C2 acceptance and a bounded actual-C historical Stop replay, updated README/v0.1 contracts and fixed near-budget Stop context. Two full release runs passed 191/191; the final run took 184.298 seconds with zero failures, cancellations or skips. Actual isolated CLI installation/discovery matched all package hashes; simulated-planner acceptance executed five real local subprocesses and verified alternate completion plus explicit exhaustion before WAIT_EXTERNAL. A new owned actual C selected a bounded diagnostic inventory on a real historical B0QI Stop, with source/contract hashes preserved and no contact with original A. See [ticket #54 evidence and limits](ticket54-c2-acceptance.md). These checks do not establish native live Stop effectiveness, production installation or original B0QI completion.
- Independent Standards/Spec reviews, production candidate installation/restart, main merge, clean temporary-resource removal, push/equality and evidence-backed issue closure remain coordinating-agent gates. No issue was closed, branch pushed or C2 candidate deployed by this ticket's implementation verification.
