# Ticket #52: B route execution, evidence and recovery

Parent: [SPEC #49](https://github.com/williamxhero/needs-forever/issues/49).
Branch: `codex/spec49-ticket52`, based on integration `541e69e`.

The runtime exports a narrow execution boundary from `src/index.ts`:
`discoverLocalRoutes`, `prepareRouteExecution`, `confirmRouteExecution`,
`captureRouteOutcome`, `plannerFailureFallback` and `routeCorrelation`.

## Persistence and delivery

State retains the #50 `route_catalog` and `route_ledger` envelopes plus one
`route_execution` admission. Pending actions, prepared/attempted/confirmed sends,
native direction returns, recovery prompts and subsequent Stop/outcome events
carry `plan_id`, `route_id` and `source_stop_attempt_id`. The candidate set stays
in the decision audit; A receives only the selected `next_message` (with the
ordinary transport's existing supervisor delivery marker).

Proposals, unknown sends and absent-history resends do not append attempts. An
ordinary confirmed delivery is attributed once at its next observed terminal
result; a native admission is attributed once at its next admitted Stop, even
when both Stops belong to the same turn. Restart preserves the in-flight
admission. Generation, input epoch, contract and task version fence it; human
input, pause, rebind and explicit resume clear it. Ledger history survives.
Recovery prompt correlation is saved with the prompt rather than taken from a
later mutable Stop. Historical worker results retain their actual event source
when reconciled into the evidence stream.

Admission validates through the shared active `validateDecision` boundary and
checks the complete persisted ledger, even if snapshot history was bounded.
The admission retains original observations and discriminating references so
recording an already executed outcome does not rejudge its next-attempt policy.
Unregistered diagnostics use an NF-owned resource/operation family: changing
model labels cannot reset no-progress history. Original C route labels remain
in correlation and audit metadata.

## Facts and progress

Discovery reads at most 32 root names and four regular files, with at most
16384 bytes per file. It skips hidden/credential-like names, directories and
symlinks, verifies the opened file identity, hashes observed bytes and stores
source-linked facts without file contents. It performs no network or credential
probe and never marks a named provider available. These generic observations
are `inventory_only`: file readability is observed, task relevance is unknown.
Completed generic inventory does not manufacture viable unfinished task work or
permanently prevent WAIT_EXTERNAL. An external decision must still name its
catalog IDs and reasons and pass the existing independent terminal proof gates;
substantive authorized routes retain their attempt/exclusion requirements.

Execution observations use complete current independent proof and substantive
digests. New event UUIDs, timestamps and reused E1 labels are not progress. A
successful shell exit alone never establishes route success: changed observations
are recorded conservatively as `diagnostic`, observed failures or identical
proof as failure. Structured reset timestamps in actual failing tool results
support one evidenced transient retry; repeated same-class failures still
require a new hypothesis or discriminating check. Ledger deltas and permission
remain separate from the observed outcome.

## Bounded planner failure

When enabled recovery encounters three C output failures (invalid/empty output
or timeout), B constructs one validated deterministic inventory direction. It
does not choose another provider. An already rejected inventory cannot be
re-sent indefinitely: it leaves a recovery checkpoint without another prompt.
The ordinary path restores its model-free worker connection before sending a
fallback after C timeout; stale failures from retired RPCs cannot affect that
new connection. Native hook deadlines and all existing cancellation fences remain.

Internal fixed-verifier repair directions also use valid C2 decisions. Fixed
and transport fixtures cross the same active validator. B-only legacy fixtures
explicitly select simulated legacy mode and still supply actual source proof
for terminal decisions; no minimal snapshot or independent-proof bypass exists.

## Verification

Skills were loaded from actual `implement-spec` and TDD files. The user-approved
#49 seams supplied the test boundary. Red stages covered missing ordinary
correlation, native same-turn recurrence, C timeout reconnect, generic inventory
blocking an otherwise evidenced wait, renamed diagnostic operations, human epoch
attribution and observed retry-reset collection. Green evidence:

- `npm run plugin:build`: 32 generated standalone runtime modules.
- Route/planning/runtime focused batch: 26 passed before the additional
  structured-reset case; that case independently passed afterward.
- Installed native C2/fallback, human JUDGE/VERIFY cancellation, repeated native
  occurrence fencing and bounded ordinary snapshot batch: 9 passed.
- Ordinary recovery plus runtime batch: 22 passed before the final epoch/reset
  additions; the additional epoch and reset cases independently passed.
- Initial compatibility batch: 96/110 passed. Its 14 failures were addressed
  with the above fixes and explicit B-only legacy fixtures; affected recovery,
  native occurrence, snapshot and inventory cases were rerun green.
- `git diff --check`: passed.

The parent integration owns the final whole-repository release gate, independent
review and installed B0QI live acceptance. This ticket does not deploy the
candidate or change live task contracts. Provider credentials/network availability
remain unknown unless a separate actual observation supplies proof; generic
local inventory does not claim task-specific resource relevance or success.
