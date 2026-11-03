# Ticket #35: independent B and synchronous Stop transport

Date: 2026-11-03. Parent SPEC: #33. Evidence classification: **simulated** host/supervisor decisions through real installed-copy Node processes and Windows named pipes. No actual Desktop continuation is claimed.

The installed native binding callback automatically launches `scripts/controller.mjs` as a detached hidden Node process. B creates no worker or app-server and holds both the existing task/state leases and a main-session lease. Its saved receipt identifies the exact process, random pipe endpoint, random ownership token, run generation and installed package. Status pings this handle read-only and reports process reachability separately from actual execution.

Already bound callbacks take the authenticated IPC path directly. They do not repeat the cold Desktop ancestry scan or fall back to a second checkpoint writer. B alone normalizes and persists bound Stop events. Each request saves task/session/contract/generation identity, a locally unique stopping attempt, and its deadline. Genuine later Stops remain distinct even within the same turn. Pending requests, direction delivery IDs, failed startup and transport outcomes survive in the public status checkpoint.

A synchronous `CONTINUE` returns only the native `decision: "block"` and concrete `reason`. Returning it sets a pending direction with `continuation_confirmed: false`; it cannot establish that A worked. Deadline expiration or hook disconnection invalidates delivery before aborting the pending external call. The result stays unknown/recovering, with no replay or replacement A. The disconnect test discovered that Node may retain the writable half after peer FIN; B now invalidates on readable `end` as well as `close`.

`evaluateStop` is the #36 connection point for the fresh readonly supervisor and completion gates. This ticket accepts concrete CONTINUE only from explicitly simulated external fixtures. Missing live judging and fixture attempts at DONE produce a recovery error, never fabricated completion. #37 owns full Interrupt/new human input precedence, ordering/retry deduplication, explicit resume and execution confirmation. The minimal owned pause endpoint here provides durable process cleanup without signaling a saved PID. Real Desktop/trust acceptance remains #38.

## TDD and verification

Agreed seam: an installed plugin copy, public controls, native lifecycle stdin/stdout, process reachability and saved public status. Only the external hook host and supervisor response are substituted.

| Slice | Red observation before correction | Green receipt |
| --- | --- | --- |
| Automatic B and synchronous direction | `Binding must automatically launch the controller`: `false !== true` | Installed binding launches B, Stop returns exact block/reason, status keeps execution unconfirmed |
| Unique session ownership with diagnostic startup | Second task rejected, but status only said `Main-session bound; supervision is not active...` instead of the lease failure | Other B remains reachable; rejected task retains the actual lease error |
| Hook disconnect | Killed the exact hook subprocess created by the test; outcome stayed `pending` rather than `unknown` | Readable end invalidates/aborts immediately and preserves RECOVERING without a direction |

Additional boundary checks verify Stop deadline expiration and duplicate B startup for the same state. Existing #34 tests now clean up their owned B through pause and assert automatic process readiness separately from simulated hook effectiveness.

Final `npm test`: **84 tests, 84 pass, 0 fail**, including TypeScript build and self-contained plugin packaging (15 runtime modules). `git diff --check` passed. The installed-copy tests execute from paths containing spaces and Chinese characters. No global config, installed user plugin, hook trust, actual Desktop session, main branch or remote was modified by this ticket.
