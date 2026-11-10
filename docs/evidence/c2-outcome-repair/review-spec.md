# Spec review

PASS — zero unresolved findings.

Reviewed the final `git diff 16077cfa963d0bd7bc6214e5c39822fa7d931d90 -- src test plugins` against SPEC #49, its execution record, recovery-resume and c2-stop-repair.

The original **P2, “Resolve proposed check references against their original observations,” is resolved** at `src/route-execution.ts:90–92` and the matching bundled runtime. Previously, a missing original digest could be replaced by an unrelated next-Stop observation using the same snapshot-local E1 label, violating the SPEC’s audit contract. The final code resolves check references exclusively through `execution.evidence`, requires every original reference to be present, and derives factual check IDs from the preserved original digest. The proposed check remains available on `state.route_execution` for audit.

Independent in-memory verification through the built public APIs passed three cases: a reused next-Stop label cannot replace omitted original evidence; a fully preserved check maps exclusively to its original digest despite label reuse; and a partially missing original check remains absent even when the next Stop supplies the missing label. Distinct new observations still produce an honest diagnostic outcome. No files, original A, production state or external provider were involved in these reproductions.

The added public regression covers the reproduced label-substitution defect. The other added regressions cover an omitted-digest attempt without false factual proof and an installed second Stop reaching C. Moving capture/discovery/probe into the admitted Stop’s existing try/catch is within scope and preserves current authorization/admission, pause/cancel, deadline, lifecycle and single-send guards. No unsupported completion, provider availability or production acceptance claims were added.

Full serial regression and fresh production acceptance remain separate parent-owned gates; this review does not claim those have passed.
