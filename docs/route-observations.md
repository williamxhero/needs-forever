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

Workspace membership never overrides read/access exclusions in the original goal,
authorization or acceptance. Known protected data names (`holdout`/`留出`) under an
explicit access prohibition, and literal excluded paths, are not probed. Metadata
reports/manifests outside guarded path names remain eligible for the bounded read.
An ambiguous read/access restriction leaves the artifact as a candidate without
authorization or probe/success facts. This conservative guard is not a general
natural-language policy interpreter; it does not declare arbitrary contract
restrictions satisfied merely because a file exists.

The hidden task-artifact directories `.scratch` and `.cache` are supported;
other hidden path components (including `.git`, `.codex`, `.env`, `.` and `..`)
are rejected. Generic root-file discovery applies the same contract access guard.

`provider`, `api` and `command` hints can identify candidates, with authorization,
network, authentication and quota facts unknown and no last success. A command
printing JSON or exiting zero does not prove a provider's availability. This
hint adapter does not interpret arbitrary provider protocols. C still cannot select
a substantive candidate until its observed Catalog entry satisfies the grounding gate.

## Explicit NF HTTP probe

For an API already covered by the unchanged original authorization, A may explicitly
execute the single literal Node argv in `c2.http_probe.argv_prefix`, followed by
`--url` and its credential-free HTTP(S) URL. No new Task field or authorization
grant is required. B prepares this runtime metadata and a random private signing
key; it does not change the immutable Task or contract hash. A URL hint never
causes B to access the network. C remains read-only/network-disabled/tool-free.

The NF-owned `route-probe --state FILE --url URL` performs one GET, with a two-second
deadline and a 16384-byte response bound. It sends no credentials/cookies/custom
headers, rejects userinfo and credential query parameters, and follows no redirects.
Only HTTP status, bounded body digest/length, truncation, network failure and
observed Retry-After metadata are emitted. Body/header content is never emitted.

The receipt is HMAC-signed with an NF-private random key under the OS temporary
directory (owner-only permissions where supported). State and prompts contain
only nonce/scope and literal command metadata, never key bytes. Scope binds the
full immutable Task, task version and native generation/input epoch/contract hash.
At Stop, admission verifies the key/signature, freshness, exact current scope and
real source command. It accepts direct literal commands or the shared opt-in
recognizer's top-level `await tools.exec_command({cmd:"literal"})`, `text(...)`,
and `const result ...; text(result)` wrappers. Dynamic/conditional code, echoes,
compound commands, assistant messages, forged or foreign receipts are rejected.

The API resource is the canonical actual URL, operation `http-get`. A completed
2xx unauthenticated GET proves this operation observed, network available,
authentication not required and this request not rate-limited. It does not prove
future quota or task completion. A 401 proves missing authentication; a 429 proves
limited status and its observed retry condition; 403/other failures retain unknown
authentication/quota unless directly proven. B records an actual probe attempt,
including when the selected route was diagnostic inventory. Proposal/send alone
does not count. If a confirmed selected API execution already owns this result,
its normal Stop outcome records the attempt once.

Snapshot and Catalog substantive digests exclude receipt signature, nonce, scope
and issuance time while retaining actual URL/status/body digest/retry facts.
Repeated receipts for the same response do not become progress; changed body/status
remains new evidence. The original protocol event remains intact for audit.

## Explicit route exclusion

A failed check does not automatically exhaust a readable artifact. For a route
whose Catalog status remains observed, C may explicitly exclude it for a necessary
external condition only with its route ID and current proof ID in
`external.attempted`, backed by the latest matching route attempt's independent
failure/blocked/exhausted evidence. All other terminal, completeness and
alternative-exhaustion gates still apply. A bare exit1 or worker's unsupported
claim cannot automatically change Catalog status or create WAIT_EXTERNAL.

Catalog entries retain source-event evidence, B probe evidence and contract-scope
evidence with task versions and content hashes. Saving State and rebuilding the
public C2 context after restart preserves these facts and the Route Ledger. B's
single send, lifecycle fencing, confirmation and recovery path are unchanged.
