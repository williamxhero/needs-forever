# Standards review

No actionable documented-standard violations or Fowler-baseline smells found in `git diff 16077cfa963d0bd7bc6214e5c39822fa7d931d90 -- src test plugins`.

Reviewed `AGENTS.md`, `docs/agents/{domain,issue-tracker,triage-labels}.md`, README's bundle/evidence/ledger rules, `docs/main-session-architecture.md`, and `docs/route-observations.md`; no CONTRIBUTING/CODING_STANDARDS file, glossary, or ADR directory exists. Applied all twelve smell heuristics from the code-review skill; no new abstraction or duplication warrants a finding.

The outcome guard requires a nonempty reference set and a retained independent digest for every referenced ID before attaching a factual discriminating check. Missing/partial references therefore omit the attempt check while preserving the proposal on `route_execution`; the existing failure/progress/retry classification and ledger permission rules remain authoritative. The lifecycle generation/input-epoch/contract fence, source-Stop exclusion and completed-Stop idempotence checks remain intact.

Moving outcome capture, discovery and probe initialization inside the admitted Stop's existing try/catch correctly assigns failures to RECOVERING and retains its deadline, cancellation listeners and finally cleanup. The changed generated runtime matches the source changes and includes updated integrity entries, as README requires.

The added tests exercise omitted-digest bookkeeping and an installed second native Stop reaching a second C, with a distinct next hypothesis consistent with ledger policy. This was a read-only source review; I did not independently rerun tests or contact the original A. No production state was changed.

Findings: 0.

## Final narrow re-review

Re-read the final source/test diff against the same baseline, including the generated runtime. Findings remain **0**.

`checkEvidence` now derives exclusively from the proposal's retained `execution.evidence`. The all-reference guard therefore cannot mistake a different observation named `E1` in the next snapshot for omitted original proof. Persisted check IDs use the same ID-plus-digest transformation as the attempt evidence. Empty or partially retained references omit the factual check, while `route_execution.discriminating_check` keeps the original proposal for audit. Actual new observations still independently determine progress, failure and structured retry conditions.

The added reused-label regression asserts both sides: a new independent observation may yield `diagnostic`, but cannot fill the original check's missing proof; the proposed description remains intact. The parent reports the final targeted regressions 3/3 green. I inspected the test assertions without rerunning tests, modifying the runtime environment or contacting A. The earlier assessment of Stop recovery ownership, fences and cleanup remains applicable.
