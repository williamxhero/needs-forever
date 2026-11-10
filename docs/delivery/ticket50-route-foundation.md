# Ticket #50: Route Catalog and Route Ledger

Parent: [SPEC #49](https://github.com/williamxhero/needs-forever/issues/49).

The public contract is exported from `src/index.ts`; data interfaces live in
`src/route-contract.ts`. Existing Decision, State, events and recovery contracts
are unchanged.

## Public interfaces

- `new RouteCatalog({ task_id, task_version }, { data? | path? })` exposes
  `upsert(entry)`, `get(route_id)`, `list()` and `toJSON()`.
- `new RouteLedger({ task_id, task_version }, { data? | path?, now? })` exposes
  `recordAttempt(input)`, `evaluateAttempt(route, context?)`, `list()` and
  `toJSON()`. Recording an attempt also enforces the current retry permission.
- `fingerprintRoute(route)` uses resource, operation, stable `hypothesis_id` and
  expected evidence. Explanatory `hypothesis` text and `route_id` do not change it.
- `routeFamilyFingerprint(route)` groups a stable resource and operation, so
  changing hypothesis IDs or expected-evidence prose cannot reset no-progress
  history.
- `routeEvidenceDigest(value)` hashes canonical JSON. Pass the substantive
  observation, excluding event UUIDs, snapshot labels, timestamps and wrappers.

Catalog entries retain authorization, network, authentication, rate limits,
last success, capabilities and evidence provenance. Observed capability requires
evidenced authorization and usable network/authentication/rate-limit facts.
Unverified candidates can retain unknown facts; naming a provider proves none.

Ledger attempts retain their identity, hypothesis, original evidence IDs and
observation provenance, outcome, counters, fingerprint, content-based evidence
delta and the next-attempt permission at recording time. Call `evaluateAttempt`
again before execution because time and new observations can change permission.
IDs without substantive observation hashes cannot establish later progress.
Changed event IDs with identical substantive hashes do not establish progress;
a reused E1 with changed substantive evidence can establish progress.

A transient retry requires an evidenced condition. A recorded reset time must
elapse; a condition-change retry requires new evidence for the condition. After
same-class failures the caller must change hypothesis or provide a discriminating
check with new substantive evidence. Two failures without progress reject the
third attempt in the same resource/operation family, even with renamed routes.
An exhausted family stays excluded. These rules do not alter DONE or
WAIT_EXTERNAL validation.

## Persistence and integration

`toJSON()` returns a versioned envelope containing `scope`, `revision` and either
`entries` or `attempts`. Callers can persist these envelopes in optional State
fields and restore with `{ data }`. Returned values and inputs are isolated from
later caller mutation.

Alternatively, `{ path }` selects an exact caller-owned sidecar file. Each
mutation refreshes the current file under an exclusive `${path}.lock` writer
lock and atomically replaces it through `${path}.${uuid}.tmp`. No directory is
implicitly selected or excluded from verification. A lock conflict fails rather
than dropping another writer's updates. The lifecycle owner must handle abandoned
lock files after a crash, consistent with its own recovery fencing.

Ordinary task-version increments retain historical entries and attempts, with
their original observation/attempt versions. A writer from an older task version
cannot overwrite a newer checkpoint. A different task ID is rejected. This
module does not migrate, rewrite or append existing State/events/recovery files.

## Verification evidence

Tests enter through public exports in `test/routes.test.ts`, without mocks of
internal modules. Red stages included missing Catalog/Ledger public exports,
missing digest/provenance support, an allowed retry before its reset time, and an
unsupported model retry assertion incorrectly permitting a retry. Each stage was
followed by the minimum implementation and a targeted green run.

- `npm run plugin:build`: passed; generated runtime includes all four new modules.
- `node --test dist/test/routes.test.js`: 7 passed.
- Recovery compatibility tests (`recovery`, `recovery-coordinator`,
  `recovery-cli`) plus route tests: 30 passed.

The final release-wide test gate remains owned by the SPEC integration branch.
