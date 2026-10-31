# S2 / #21 completion method and acceptance map

Current SPEC: #21. Predecessor #20 was delivered on main `de23e6a` and
read back CLOSED/completed before this phase began. This map follows the full
#21 body/comments, total #19 contract and installed implement-spec-to-done.

## Required sequence

1. Read full current SPEC and comments; execute installed `/to-tickets`.
   Revalidate/reuse approved #26 -> #27 -> #28 with native parent/blocker edges.
2. Execute installed `/implement-spec`: each ticket in its own worktree through
   public CLI TDD, integration by a separate merger. Do not close tickets early.
3. Run S2 exit acceptance, including actual Codex/model T01-T05. Preserve
   commands, installed version, platform, worker/judge IDs, event sequence,
   snapshots, fixed verifier output and resulting artifacts.
4. Independent Standards and Spec reviews; one implementer resolves findings,
   then independent recheck. Simulated and live evidence remain distinguished.
5. Merge verified integration to main; verify all candidate commits included and
   each temporary worktree clean. Back up ignored raw evidence before recoverable
   archive; delete only merged temporary branches. Push main, prove remote equality.
6. Upload/read back exact completion records with UTF-8/no-BOM body files. Close
   #26/#27/#28 and #21 as completed and read back CLOSED/completed. Update #19 todo
   and confirm native relations. Only then may #22 enter `/to-tickets`.

Source: #21 “执行与交付”, #19 inherited state/authorization/acceptance contract,
`docs/agents/issue-tracker.md`, and installed skills. The user approved all ticket
breakdowns; confirmation is not repeated. Skills execute by loading actual
SKILL.md and following their procedures, not by claiming an unavailable tool call.

## Acceptance

| Requirement | Owner | Evidence | Result |
| --- | --- | --- | --- |
| Stable installed outputSchema; single strict JSON; valid evidence IDs and action combinations | #26 | `docs/evidence/ticket-26/`, `docs/delivery/ticket26-merger.json` | PASS simulated at `c0af536` |
| Default 24,000-character bounded snapshot; original contract preserved; missing evidence marked | #26 | Contract/priority/source/truncation public CLI cases | PASS simulated |
| New isolated readOnly/never judge per review; worker idle; one call; archive IDs | #26 | Two real implementation judge invocations through simulated JSONL; 114 installed generated types audited | PASS simulated; live pending #28 |
| Worker self-report/insufficient evidence cannot produce DONE/WAIT | #26 | Self-report-only and truncated evidence rejection cases | PASS simulated |
| T06 evidence-supported external wait; no late wake or repeated notification | #26/#28 | Captured external-wait run, duplicates and single notification | PASS simulated #26; request-related checks pending #28 |
| ACTIVE/version/expected-turn gates; cancelled call ends before another judge | #26–#28 | Timeout, lost turn/start outcome, connection exit, expected judge turn and PAUSED checks | PASS simulated judge and verifier; request pending |
| Fixed argv verifier in worker sandbox with timeout; failure returns to original worker | #27 | `docs/evidence/ticket-27/`, `docs/delivery/ticket27-merger.json` | PASS simulated at `3a52285`; actual Node verifier in simulated transport |
| Protected baseline before worker, preserved on resume, pre/post verifier checks | #27 | Original baseline/argv survive resume; pre/post tamper cases | PASS simulated |
| Before/during verifier tamper, missing file, nonzero, timeout, pause/late success | #27 | Ten public CLI verification cases; installed runtime timeout/cancel probes in `docs/evidence/s2-protocol/` | PASS simulated product cases; real runtime probes are capabilities only |
| T13 ordinary defaults, authorization denial, unsupported cancellation and judge request failure | #28 | Pending | not_run |
| T01/T02 live: one/two premature finishes trigger same-worker confirmed starts | #28 | Pending | not_run |
| T03 live: failed route followed by materially different successful route | #28 | Pending | not_run |
| T04 live: actual judge DONE rejected by real independent verifier, followed by repair | #28 | Pending | not_run |
| T05 live: complete goal and verifier PASS persist stable DONE | #28 | Pending | not_run |
| Reproducible three-stage demo with protected verifier; full S1 regression | #27/#28 | `scripts/prepare-s2-demo.mjs`, `scripts/run-s2-simulated-demo.mjs`; #27 merger 48/48 including S1 24/24 | PASS simulated; live pending #28 |
| Independent review and findings resolved | S2 exit | Pending | not_run |
| Main ancestry, clean worktrees, safe cleanup, push and equality | S2 delivery | Pending | not_run |
| Completion records exact readback and CLOSED/completed; total todo updated | S2 delivery | Pending | not_run |

Complete retries/reconnect/history reconciliation and live T08/T11 remain S3.
Their absence cannot be reported as S2 evidence or used to close total #19.
