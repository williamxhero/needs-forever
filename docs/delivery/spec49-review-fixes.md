# SPEC #49 independent-review repairs

Implementation branch: `codex/spec49-review-fixes`. Implementation freeze:
`eda2c0a1cee394cd082c71f37fb7bec18d39b68c`, including integration `d749157`.
Date: 2026-11-10. This worker owns review repairs and verification; the coordinating
agent owns independent re-review, production deployment, main merge, cleanup,
push/equality and Issue closure. No production installation, original-A contact,
main merge, push or Issue changes were performed by this work.

## Review findings and fixes

The original invalid model hypothesis `The provider is authenticated` was rejected
correctly but its human-readable error reached the infrastructure authentication
classifier. The public CLI red reproduced zero inventory fallbacks instead of one.
`JudgeOutputError` now marks all active output-validation failures explicitly;
classification preserves bounded model retry/fallback regardless of authentication
or quota words. Real transport authentication/quota errors keep their classification.
The same classifier is used by ordinary and native paths.

The native continuation previously persisted raw `next_message` while only its
separate audit decision was redacted. A public installed enforce-mode red returned
the synthetic `sk-abcdefghijklmnop` marker. Active validation now redacts the entire
decision before validating selected-action/message equality and before admission.
The green verifies native return, selected action, checkpoint, execution identity,
event log and recovery prompt without that fake marker. No real credential was used.

Catalog ingestion now runs at the production Stop boundary. Exact, bounded current
tool-result hints identify nested artifacts, and B independently checks their
workspace scope, all symlink/junction parents, regular-file identity and bounded
read. Generic root discovery uses this same probe/authorization boundary. Original
goal/authorization/acceptance exclusions cover explicit protected paths and guarded
holdout names; ambiguous read restrictions remain unverified. `.scratch`/`.cache`
task artifacts are supported while credential directories and other hidden path
components are rejected. Source-event, contract-scope and probe digests survive
State persistence/restart. JSON hints cannot grant permission or assert provider
availability, authentication or quota. [The contract](../route-observations.md)
documents the exact format, supported fields and limits.

A second review identified that provider/API hints still could not graduate and
that observed-but-failed artifacts could prevent a valid external wait indefinitely.
The explicit NF-owned `route-probe` CLI now provides the API seam. Original A invokes
one literal Node command under its existing authorization; C and hint ingestion
never initiate network access. The two-second credential-free GET emits only
bounded status/body-digest/retry metadata with a per-scope HMAC receipt. Admission
requires the actual matching command, source result, full current contract/version
and native generation/input epoch, freshness and signature. The original Task/hash
is unchanged; no new allowlist is required for existing contracts. Native direct
and supported literal Code Mode wrappers share the opt-in recognizer; dynamic,
conditional, echo and compound commands remain unverified.

The canonical actual URL plus `http-get` operation supplies API identity. A completed
2xx request establishes this unauthenticated operation only. 401, 403, 429, 5xx and
transport failures preserve only directly proven facts, with missing fields unknown.
Actual probe results can record an API attempt while the selected route is inventory;
proposals/sends do not count. Confirmed API execution owns its normal Stop outcome
without an extra probe attempt. Source and Catalog digests remove receipt transport
identity (signature, nonce/scope, issuance time) but retain URL/result/body digest.
Identical responses do not become progress; changed body/status remains evidence.

Catalog readability is not task relevance. After a latest correlated independent
failure, C may explicitly exclude an observed artifact by citing both route ID and
current proof ID in `external.attempted`, while retaining every existing independent
terminal/completeness/exhaustion gate. An exit1 never automatically changes Catalog
status to exhausted. A signed 429 during inventory also yields a real API attempt,
so a genuinely exhausted task can reach WAIT_EXTERNAL without manual State edits.

The optional duplicated-enum suggestion was left unchanged to keep the repair
focused on the actionable behavioral defects.

## Public red/green evidence

Tests use the pre-agreed public planning/context/admission boundaries, persisted
protocol events, actual CLI and installed native lifecycle. The TDD and
implement-spec instructions were loaded from their installed SKILL.md files;
no unavailable Skill-tool invocation is claimed.

Observed reds included auth-prose fallback count `0 !== 1`, raw synthetic secret in
native direction, missing source-linked nested artifact, rejected legitimate
`.scratch` audit, unavailable API route (`change_hypothesis` after unsupported probe),
and observed artifact rejected from an explicitly evidenced WAIT_EXTERNAL. The
corresponding public regressions now cover:

- Three invalid authentication-worded C outputs produce one bounded inventory
  fallback, without a fictitious external credential dependency.
- Real subprocess inventory → independent B file probe → persist/restart → selected
  executable alternate, plus actual ordinary/native production send correlation.
- Parent symlink/junction, outside workspace, model/input-only/stale/foreign/version/
  contract/truncated/credential and forged-availability rejection.
- Original holdout/path exclusions for both generic discovery and hint ingestion,
  supported task audit directories and ambiguous-authorization preservation.
- Actual HTTP → signed receipt → observed API → selected single delivery; literal
  installed native Code Mode, forged signature/source/command rejection and no
  credential/header/body output.
- 401/403/429/503 conservative facts, identical-response semantic repetition and
  changed-body evidence; signed 429 during inventory with an excluded inspected
  local route reaches WAIT_EXTERNAL.
- Observed readable cache with a real missing-date failure remains observed, while
  an explicit evidence-linked C exclusion can wait; an unsupported worker claim fails.

[Targeted output](../evidence/spec49/review-fixes/targeted-test.txt) retains the
focused final run. The complete post-fix release gate is recorded below after it
finishes; the earlier 198/198 run preceded the second-review HTTP/exclusion repairs
and is not presented as the final release gate.

## Actual isolated installation and execution

```powershell
npm test
node scripts/verify-plugin-install.mjs --candidate . --directory runs/spec49-review/final2-install
node scripts/verify-c2-acceptance.mjs --runtime runs/spec49-review/final2-install/codex-home/plugins/cache/needs-forever-local/needs-forever/0.3.4/runtime --directory runs/spec49-review/final-installed-acceptance
node scripts/verify-c2-observation-loop.mjs --runtime runs/spec49-review/final2-install/codex-home/plugins/cache/needs-forever-local/needs-forever/0.3.4/runtime --directory runs/spec49-review/final-installed-observation-loop
```

The native CLI 0.167.0 installed the final 34-module candidate into a fresh isolated
CODEX_HOME. Every package file hash matches and skill/hook discovery passed.
Discovery still requires host trust for native effectiveness; no production native
effectiveness is inferred from this installation.
[Install hashes](../evidence/spec49/review-fixes/install-summary.json).

The existing B0QI installed acceptance passes with five actual local subprocesses,
independent completion, explicit failure/exhaustion and third-route rejection.
[Receipt](../evidence/spec49/review-fixes/installed-acceptance.json).
The supplementary installed production CLI verifier injects no Catalog entries:
one run discovers/chooses a nested cache; another explicitly probes a real local
HTTP server twice and chooses the observed API. Each selected alternate is sent,
confirmed and correlated exactly once, followed by DONE. The planner/server and
provider blocker are deterministic fixtures; the local tools and HTTP requests
are actual. [Receipt](../evidence/spec49/review-fixes/installed-observation-loop.json).

## Actual C historical Stop replay

```powershell
node scripts/replay-c2-stop.mjs --source D:\WILL\STOCK\QuantResearch\.codex-supervisor\quantresearch-793-supervise\snapshots\8784db86-45b6-4130-bcff-fbe45b4a2c3f.json --runtime plugins/needs-forever/runtime --directory runs/spec49-review/final-historical-live-replay --live true
```

Actual C returned validated CONTINUE selecting `local-artifact-route-inventory`,
with the exact bounded output contract in its next_message. It correctly declined
to infer completion or exhausted alternatives from incomplete historical evidence.
The 23042-character replay preserved the immutable contract and original source
SHA-256 `e2477f70746dc3809b53224eb19db4d5159a818e178af6d4c7951c91b9abf30d`.
C was read-only/network-disabled/tool-free, four inherited MCP servers were disabled,
and owned C `01a1c3f1-c6fa-7cb0-9691-950bb283d1ec` was archived. Original A was never
resumed, messaged or interrupted; no selected action was executed on its project.
[Redacted manifest](../evidence/spec49/review-fixes/historical-live-replay.json) and
[decision](../evidence/spec49/review-fixes/historical-live-decision.json) retain
only source references/digests, not original tool bodies or credentials. This is
historical model judgment, not original B0QI completion or a fresh native live Stop.
