# Source-linked route observation hints

Both ordinary worker Stops and native main-session Stops call the public
`ingestRouteObservations(state, snapshot)` boundary through `captureRouteOutcome`
before building the next C context. `routeInventoryDecision` and the real judge
instructions explain the output contract. This supplements B's generic root-file
inventory with task-specific nested artifacts; it does not execute provider calls.

Return exactly this JSON object as the complete stdout of an actual command result,
or as a paired native PostToolUse response (a JSON string, object, or its `stdout`):

```json
{"nf_route_inventory":{"schema_version":1,"task_id":"current-task","task_version":1,"routes":[{"route_id":"price-cache","resource":{"kind":"artifact","id":"cache/prices.csv"},"operation":"read-local-artifact"}]}}
```

Use the immutable current task ID/version. The result is limited to 8000 characters,
four route hints per Stop, 32 source entries inspected and 64 substantive catalog
entries. Route/resource/operation identities must be nonempty and bounded. No
extra fields (including availability, status, capabilities, credentials or permissions)
are accepted. Existing route IDs cannot be rebound to another resource/operation.
Hints never erase prior observed facts or exclusions for unsupported resources.

The source must be complete independent command/tool-result evidence from the
current worker/session and turn, observed within ten minutes. The snapshot task,
version, full immutable contract and worker/session identity must match State.
Ordinary snapshots bind event/item identities from protocol events; native
snapshots already fence paired PreToolUse/PostToolUse by session, generation,
input epoch and contract hash. Assistant messages and tool inputs are never
observation results. Historical, foreign, truncated and credential-shaped hints
are ignored without aborting Stop processing.

For `artifact` plus `read-local-artifact`, B resolves the relative slash-separated
path under the canonical task workspace, rejects absolute paths, dot segments,
credential-like paths, symlinks/junctions at every parent and nonregular files,
then opens and checks file identity. It independently reads at most 16384 bytes,
checks identity/size/mtime after reading, and stores only a digest and source
references. The active task's workspace supplies the bounded read-only inspection
scope; a task-contract digest supplies authorization provenance. The local probe
proves no network/authentication requirement, no remote rate limit and a successful
bounded read. It proves neither relevance nor completeness nor task completion.
Selected actions and independent acceptance checks must still establish those.

`provider`, `api` and `command` hints can identify candidates, with authorization,
network, authentication and quota facts unknown and no last success. A command
printing JSON or exiting zero does not prove a provider's availability. This
adapter intentionally does not interpret arbitrary provider protocols. A future
adapter must bind actual request/resource/operation and independently validate
each fact before upgrading any candidate. C still cannot select a substantive
candidate until its observed Catalog entry satisfies the existing grounding gate.

Catalog entries retain source-event evidence, B probe evidence and contract-scope
evidence with task versions and content hashes. Saving State and rebuilding the
public C2 context after restart preserves these facts and the Route Ledger. B's
single send, lifecycle fencing, confirmation and recovery path are unchanged.
