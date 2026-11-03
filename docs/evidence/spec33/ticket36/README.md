# Ticket #36: fresh readonly supervisor and original-session completion gate

Date: 2026-11-03. Parent SPEC: #33. Evidence classification: **simulated** native host and model boundary, exercised through real installed-copy Node processes, Windows named pipes and the existing app-server protocol replacement. These results do not establish actual Desktop hook trust or actual Desktop continuation; #38 retains that acceptance gate.

## Delivered behavior

Every effective Stop uses a fresh isolated app-server and `AppServerJudge` session C. The existing transport verifies the pinned CLI version, disables hooks/plugins/apps/MCP and network, and the judge verifies readOnly/never policies. A B-owned notification pump observes C output and refuses server permission/tool requests. C is archived and its owned process closed. Neither A nor a replacement worker receives any `thread/start`, `thread/resume` or `turn/start` request from B. Only native synchronous `decision:block` / `reason` asks Desktop to continue A.

Startup preflights the live judge transport without creating any worker or judge. Explicit host-only simulation fixtures retain #34 compatibility but cannot manufacture a model result. The #35 transport-only CONTINUE fixture remains simulated and cannot return a terminal decision.

The main-session snapshot preserves the full original task, every acceptance item, authorization, contract/generation, Stop attempt and optional same-turn identity. Structured PostToolUse evidence retains the native event type, actual tool input/response and stable tool-use identity. It does not invent app-server command events or exit codes. Evidence is redacted and bounded. A 24,000-character snapshot budget prioritizes the contract and current proof; old directions and the most recent independent verification remain context. Last assistant wording is an untrusted claim, capped independently so a long answer cannot crowd out proof.

Evidence windows follow actual Stop attempts rather than turn IDs. Oversized output requires new concise evidence; a later valid Stop after new tool work can complete instead of being permanently poisoned by old truncation. The existing decision validator rejects terminal decisions without independent current proof. Such an evidence-deficient terminal audit becomes a concrete instruction to gather acceptance evidence and investigate other authorized routes; transport or malformed protocol errors retain recovery semantics, never external-authorization claims.

Returning a direction records its delivery identity and leaves execution unconfirmed. Matching A PreToolUse/PostToolUse after that delivery, with unchanged contract, generation and input epoch, confirms actual tool activity. A tool started before delivery cannot confirm it. Consecutive Stops in one turn each create fresh C. Finished hook sockets remove their old invalidation listeners so a client closing after receiving a result cannot overwrite a later Stop checkpoint.

DONE is gated by the saved fixed verifier argv through explicit workspaceWrite roots, network=false and excluded temporary roots. The protected baseline captured during preparation is reused unchanged. Protected-file changes before execution refuse the command; verifier failures and protected/workspace changes return exact repair evidence and original protected content. Workspace hashes use cancellable asynchronous traversal and file streams, yielding between directory batches and stream blocks so native Interrupt can be processed. Successful completion releases the active binding, stops B and leaves terminal status durable; a repeated Stop cannot reopen it. WAIT_EXTERNAL persists its independently supported missing condition, attempted routes, lack of other work and recovery condition, without a continuation direction.

## TDD and verification

The approved seam is installed plugin controls and native lifecycle stdin/stdout through persisted public status and artifacts. Only external host/model responses are replaced.

| Slice | Observed red | Green behavior |
| --- | --- | --- |
| Fresh C / activity proof | First Stop returned no `block` (`undefined !== block`); after connection the activity assertion initially remained `false` | Consecutive same-turn Stops create different readonly C IDs; only subsequent matching A tool activity confirms execution |
| Bounded claim | A 32k assistant claim made the Stop remain ACTIVE instead of DONE by crowding out the snapshot | Full original contract and independent proof remain within 24k, with explicit assistant truncation |
| Whole-suite compatibility | Initial full run: 88/91 passed; three #34 host-only fixtures failed the new model preflight | Host-only simulated startup remains compatible, with no model availability or completion claim |
| Returned socket race | Whole run: 91/92 passed; a successful first hook client's later FIN invalidated the next Stop | Finished Stop removes its own disconnect callbacks; later Stops retain their own state |

Additional public process cases cover unsupported DONE/WAIT claims, fixed argv failure → original-A repair direction → successful DONE, protected-verifier restoration, evidence-backed WAIT_EXTERNAL, workspace changes during successful verification, and truncated output → concise replacement proof → successful terminal decision. The targeted installed-copy run passed 13/13 before the final regression; the final full-suite receipt is in `final-checks.txt`.

## Interfaces for ticket #37

- `evaluateStop(state, request, fixture, signal, store)` now returns a validated `Decision`, not a hook reply. The controller owns terminal transitions and native block formatting.
- `preflightSupervisor` checks live transport; `superviseStop` creates C, records snapshots/IDs, and executes the optional fixed completion gate using only owned Rpc processes.
- Main state adds `binding.status=RELEASED`, `tool_starts`, `input_epoch` and `direction_context`. `input_epoch` defaults to zero until #37 adds durable human-input sequencing.
- #37 still owns full pause/input epoch fencing, Stop callback retry deduplication, cancellation-aware recovery backoff, explicit same-A resume, cumulative limits and default/legacy control routing. Judge-created and verifier phase saves check cancellation; broader concurrent checkpoint ownership remains #37 work.
- #38 still owns required actual Windows Desktop acceptance and supported host/trust receipts. No user plugin installation, global settings, hook trust or actual Desktop chats were changed here.
