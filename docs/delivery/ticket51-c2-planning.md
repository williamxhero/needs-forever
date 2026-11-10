# Ticket #51: C2 diagnosis, planning and shared context

Parent: [SPEC #49](https://github.com/williamxhero/needs-forever/issues/49).

The public exports in `src/index.ts` expose a single active decision validation
boundary and the shared bounded planning context. C remains read-only,
network-disabled and tool-free through the existing AppServerJudge policy gates.
No provider facts are generated from names, worker claims or model prose.

## Contracts and public interfaces

`Task.c2?: { mode: 'enforce' | 'shadow' | 'legacy' }` is optional. Absence means
effective enforcement, including an older saved live task. The effective default
is never inserted into the saved task or contract hash. `validateTask` preserves
an explicitly supplied configuration. Legacy mode requires a simulated State;
shadow is an explicit rollout mode that permits a legacy CONTINUE for auditing.

`Decision` retains action, reason, evidence_ids, next_message and external.
CONTINUE adds a diagnosis (`class`, `statement`, `evidence_ids`) and a route_plan:

- `plan_id`, `selected_route_id`, `selection_reason`, `single_route_reason`;
- one to eight candidates with stable RouteIdentity resource/operation,
  hypothesis_id/hypothesis/expected_evidence, status and evidence_ids;
- each candidate's actions, expected_signal, risk, fallback
  (`route_id: string | null`, `when`) and optional discriminating_check;
- success_condition and stop_condition.

The selected actions joined with newlines must equal next_message and remain at
most 3000 characters. Fallback route IDs must name another candidate; null means
the stated fallback condition needs fresh planning. At least two materially
different resource/operation families are required unless a single route is
justified. Multiple observed catalog alternatives require two substantive
candidates, rather than substituting an inventory candidate for an alternative.

- `validateDecision(raw, snapshot)` is the active boundary. It preserves terminal
  independent-proof/incompleteness gates, validates C2 structure, references,
  selection, catalog identity and status, and checks RouteLedger retry permission.
- `validateC2Decision(decision, snapshot)` is the planning-only validation seam;
  active callers should use validateDecision to retain terminal evidence gates.
- `readHistoricalDecision(raw)` reads a historical five-field result without
  granting permission to execute it as a new active CONTINUE.
- `routeInventoryDecision(snapshot, reason?, message?)` produces a deterministic
  auditable diagnostic CONTINUE. A caller-supplied message is the selected action;
  callers must keep it concise and within the original authorization.
- `effectiveC2Mode(state)` resolves the mode without mutating Task.

## Shared context and proof

`buildSnapshot(state, turnId, events)` and
`buildMainSessionSnapshot(state, stopRequest, events)` both call
`buildC2Context(snapshot, state)`. The ordinary FixtureJudge minimal snapshot
bypass was removed; both paths now retain current Stop proof with real event
source references and observed timestamps. Native planning tool results can
populate the current worker plan; an absent plan is explicitly marked missing.

Optional State fields `route_catalog` and `route_ledger` carry the #50 versioned
toJSON envelopes. No new sidecar or workspace digest exclusion is introduced.
Snapshot.c2 carries mode, context_complete, catalog, ledger, observations,
current_plan and the repeated-route instruction. Catalog and ledger are validated
at reconstruction. Original goal/acceptance/authorization and current proof take
priority inside the 24000-character budget. Catalog/ledger summaries retain
bounded recent content and explicit omission counts. Incomplete route history
forces inventory/diagnostic selection before a substantive execution route or
external wait. It does not pretend that omitted attempts never happened.

`snapshotRouteEvidence(snapshot)` creates RouteEvidence only from complete,
independent command/file/tool/verifier observations with actual event references
and timestamps. Digests exclude top-level protocol IDs/timestamps while preserving
substantive tool content. Missing provenance or truncated proof cannot establish
new route progress. Catalog observation references remain distinct from current
proof labels such as E1.

Observed candidates require the matching observed catalog entry and observation
references. Missing context selects an inventory or discriminating diagnostic;
unknown providers cannot be selected as available. The selected route's retry
permission is evaluated using the persisted ledger and current substantive proof,
so renamed events cannot reset the no-progress limit. DONE remains subject to the
original proof gates. WAIT_EXTERNAL also requires complete context and evidence
for every excluded/attempted catalog route, with its ID and reason.

## Remaining ticket #52 hooks

Ticket #52 owns bounded read-only discovery, active FixtureJudge enforcement at
the B boundary, route attempt collection/persistence, single-send correlation,
recovery and deterministic fallback after bounded C failures. It should:

- preserve `route_plan.plan_id` and `route_plan.selected_route_id` on pending
  actions, send events, confirmations and recovered deliveries;
- populate State.route_catalog/route_ledger from #50 modules without altering
  task authorization or contract hashes;
- record attempts with real resource/operation identity and source-linked
  content digests from Snapshot.c2.observations, not event UUID/E1 counts;
- pass fixed fixture decisions through validateDecision; old simulated transport
  fixtures must explicitly opt into legacy mode or use the C2 constructor;
- use routeInventoryDecision for verification repair directions and repeated
  invalid/empty/timeout C results; keep the <=3000-character selected message
  contract and the existing delivery/lifecycle fences.

The external app-server fixture now emits a valid C2 inventory plan for default
CONTINUE outputs. Historical WAIT_EXTERNAL tests explicitly select simulated
legacy mode. This does not relax terminal evidence gates or live enforcement.

## Verification

Red stages covered missing public planning exports, missing context, and a budget
implementation that dropped all ledger history. Green tests cover the public
validation/context seams, Tushare rate-limit substitution, ungrounded claims,
selection/fallback/reference errors, third same-route rejection, unchanged DONE
proof gates, historical reading, config preservation, both snapshot paths and
digest stability. Installed-runtime and integration results are recorded in the
ticket handoff; the release-wide gate remains owned by the SPEC integration.

- `npm run plugin:build`: passed, 31 runtime modules generated.
- Planning plus Route Catalog/Ledger tests: 18 passed, including installed-runtime
  execution of the public planning and historical-reading APIs.
- Judge CLI, native main-session supervision, planning and route integration
  run: 51 passed before the final additional planning cases. No terminal,
  isolation, cancellation or existing fixed-verifier gates were weakened.
