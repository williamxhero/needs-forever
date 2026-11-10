# Ticket #54: C2 release acceptance

Parent: [SPEC #49](https://github.com/williamxhero/needs-forever/issues/49).
Implementation branch: `codex/spec49-ticket54`, started from integration
`87edf5d` after merging the #53 frontier. Date: 2026-11-10.

This ticket prepares a reviewable release candidate. Independent Standards/Spec
review, production installation/restart, main merge, cleanup, push/equality and
issue closure remain the coordinating agent's delivery gates. No C2 candidate
was deployed by this work; the existing global NF/NFG services and original A
were not changed.

## Changes and red/green evidence

The previously observed release red was 164/184, with 19 CLI transport fixture
failures and one installed-copy lifecycle failure. These fixtures now explicitly
select simulated legacy mode and supply a real local read-only subprocess
result with an event source. Terminal judgments still cross the active validator;
the live default, independent proof and completeness gates have no fixture bypass.
The installed-copy resumed history supplies actual locally executed proof rather
than an empty completed turn. A duplicate-event fixture now sends the obsolete
first-turn terminal only on subsequent turns, allowing the first actual completed
turn to supply its proof. README S1 demos use the same explicit fixture convention.

One additional public test first failed because the C2 acceptance runner did not
exist. The runner now exercises the self-contained package's exported interfaces,
and it was also executed against the package installed by the actual native CLI.
The simulated planner proposes a concrete local-artifact alternative to a
synthetic Tushare quota failure; a real Node subprocess reads the generated CSV
and writes the result, and a separate Node verifier checks the exact two dates.
The validated sequence is CONTINUE → DONE. B's conservative route outcome remains
`diagnostic`; successful completion comes from the independent verifier, not a
shell exit or an invented automatic success classification.

The runner then injects a missing-input fault by removing only its generated CSV.
A real read of that same route returns ENOENT. WAIT_EXTERNAL is rejected before
exclusion and accepted only after both fixture routes have source-linked failed
attempts/exclusion facts. It also rejects the quota-blocked selection and a third
equivalent no-progress attempt despite renamed IDs. Generated fixture data and
synthetic quota responses prove this acceptance exercise, not real market
coverage or a live provider's present state.

The actual historical replay exposed a near-budget defect: adding C2 to an old
Stop could throw before C could request concise proof. A public-context test
reproduced that red. The narrow fix retains the immutable goal, acceptance,
authorization and Stop identity; optional current proof may be omitted with an
explicit count and `evidence_complete=false`/incomplete route context. The test
verifies the 24000-character limit, unchanged task, permitted inventory and
rejection of terminal judgment. The historical replay then ran successfully.
Evidence: [budget red](../evidence/spec49/ticket54/budget-red.txt).

NFG folded content now clamps to one complete line. Existing meaningful rendered
client/refresh tests remain in the full gate. The coordinating agent owns the
real-browser visual check after integration; its earlier browser run used real
browser interaction with simulated task data, not a live model/native Stop.

## Actual installation without a model

Commands in this worktree:

```powershell
npm run plugin:build
node scripts/verify-plugin-install.mjs --candidate C:\Users\will\.codex\worktrees\spec49-ticket54\needs-forever --directory runs\ticket54\final-install
node scripts/verify-c2-acceptance.mjs --runtime runs\ticket54\final-install\codex-home\plugins\cache\needs-forever-local\needs-forever\0.3.4\runtime --directory runs\ticket54\installed-acceptance
```

Native CLI 0.167.0 installed the candidate into a fresh isolated CODEX_HOME. All
candidate/installed file hashes match, and skill plus declared hook discovery
passed. Hooks are untrusted and require the host's human trust step for native
effectiveness; no native effectiveness is claimed by discovery. No auth file,
raw configuration, source tool body or credential is copied into committed
receipts. [Install summary and hash maps](../evidence/spec49/ticket54/install-summary.json).

The installed runtime acceptance used five actual bounded local subprocesses.
[Report](../evidence/spec49/ticket54/installed-acceptance/report.json), selected,
DONE and WAIT input/decision pairs, command event receipts and persistent ledgers
are retained beside it. This is actual local installation/execution with a
simulated planner. It is distinct from both live C inference and native Stop
effectiveness.

## Actual C model, isolated historical Stop replay

```powershell
node scripts/replay-c2-stop.mjs --source D:\WILL\STOCK\QuantResearch\.codex-supervisor\quantresearch-793-supervise\snapshots\8784db86-45b6-4130-bcff-fbe45b4a2c3f.json --runtime plugins\needs-forever\runtime --directory runs\ticket54\historical-live-replay-2 --live true
```

The replay reads the immutable historical B0QI snapshot, adds bounded C2 context,
and invokes only a newly created C through the production AppServerJudge and
native CLI 0.167.0. C is read-only, network-disabled and refuses tool requests;
the connection disables the four inherited MCP servers. Its owned C thread
`01a1c3c8-5b27-7392-bdd6-19dc2938b5df` was archived. Original A
`01a1ae7a-9442-79e0-b32b-aa560f976453` was neither resumed, messaged nor interrupted.
The historical source snapshot was unchanged; contract hashes before/after
match. Source Stop: `5fd1abd7-e5ed-4756-bf2a-1d3e322e11b1`.

The source snapshot's SHA-256 is
`e2477f70746dc3809b53224eb19db4d5159a818e178af6d4c7951c91b9abf30d`.
Its historical judgment was WAIT_EXTERNAL. The actual C2 model returned a valid
CONTINUE selecting `qr793-diagnostic-route-inventory`, explaining that the
observed quota window does not establish exhaustion of every authorized route.
Its concrete bounded actions inspect catalog/ledger and original failure
records, provider capability/config, local manifests/cache and implementation
entry points; record stable identities, observations, failed attempts, retry
permissions and missing facts; then select a concrete executable alternate or
state the remaining discriminating evidence. It explicitly forbids blind capture
retry, credential disclosure, forward holdout access, production mutation and
repeating the whole test suite.

The replay contains 23042 serialized characters. Missing historical Catalog and
Ledger plus omitted oversized proof are explicit; it does not mark any unknown
provider observed. This is one actual live-model judgment of a historical Stop,
not a native live Stop or evidence that the original B0QI task completed. No
selected action was executed against the original project. The runtime used by
the replay is byte-identical to the finally installed candidate package.
[Redacted replay manifest](../evidence/spec49/ticket54/historical-live-replay.json)
and [actual C decision](../evidence/spec49/ticket54/historical-live-decision.json)
retain source/event references and digests without copying raw historical tool
outputs.

## Documentation and verification

README and both v0.1 specification copies now describe effective enforce,
explicit shadow and simulated-only legacy modes, the full route contract,
historical reading, independent terminal gates, substantive repetition and the
bounded planner-failure fallback. Section 5.2 has a complete C2 JSON example;
it passed actual `validateDecision` at the public boundary.
[Example validation receipt](../evidence/spec49/ticket54/documentation-example.json).

The release command is `npm test`: TypeScript build, 32-module standalone plugin
build and the complete unit/integration/Web/installed lifecycle/recovery suite.
Both complete runs passed 191/191 with zero failures, cancellations or skips;
the final run took 184.298 seconds. [Final output](../evidence/spec49/ticket54/full-test.txt)
and [release receipt](../evidence/spec49/ticket54/release-checks.json) record the gate. Separate
README start/continuation demonstrations also passed as simulated transport with
actual local proof; their outputs remain under `runs/ticket54/s1-*`.

No issue is closed by these results. The coordinating agent's deployment/state
observation, independent review, main integration and final delivery equality
remain explicit gates. A fresh production native Stop was not forced for this
ticket; historical replay is the real-model acceptance and native live behavior
is an observation limit while the original A remains active.
