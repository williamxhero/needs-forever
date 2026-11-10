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
| #51 | Shared context and structured C2 planning | #50 | Not started |
| #52 | B route delivery, correlation and repetition guard | #51 | Not started |
| #53 | NFG route audit display | #51, #52 | Not started |
| #54 | B0QI regression, installed runtime and delivery evidence | #50, #51, #52, #53 | Not started |

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
