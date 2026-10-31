# S2 stable protocol findings (Codex 0.166.0)

Date: 2026-11-01. Narrow read-only investigation for #21; no inference, project edits, archived implementation, or S3 work. Authoritative source: installed generated stable bindings at C:\Users\will\AppData\Local\Temp\needs-forever-protocol-01660 (no --experimental). S1 current src was inspected only to locate integration seams.

## Judge structured output and read-only sandbox

- v2/TurnStartParams.ts has stable `outputSchema?: JsonValue | null`. It constrains only the final assistant message, not every streamed delta. Pass schema on each judge turn, then validate the entire final agentMessage text as exactly one JSON object in supervisor code. Generated protocol does not validate application-level action/evidence combinations; no SDK success substitutes for that validation.
- v2/ThreadStartParams.ts takes `sandbox?: SandboxMode` (string `read-only`, not object), `approvalPolicy:'never'`, `cwd`, and `ephemeral:false` when retaining the ID for audit.
- v2/ThreadStartResponse.ts gives actual `sandbox:SandboxPolicy`, `approvalPolicy`, `cwd`, and thread id. Check sandbox.type==='readOnly' and networkAccess===false. Per-turn override is `sandboxPolicy:{type:'readOnly',networkAccess:false}` on turn/start. Keep the installed process isolation flags from S1; thread sandbox does not disable external MCP/apps/plugins.
- v2/TurnStartParams.ts input text requires `{type:'text',text:'...',text_elements:[]}`.
- v2/ThreadItem.ts `agentMessage` has text/phase; v2/ItemCompletedNotification.ts carries threadId,turnId,item; v2/TurnCompletedNotification.ts carries threadId,turn. Only process events for the exact current judge thread+turn; a turn/completed notification can have status failed/interrupted, so inspect `turn.status`.
- Current S1 `Rpc.next()` is a single consumer. Concurrent worker+judge consumers would steal events. Keep one pump with role-aware routing, or explicitly provide subscriptions/multiplexing; do not have LiveJudge call next() beside existing Supervisor.pump().

## Archive lifecycle

- Stable request `thread/archive` params exactly `{threadId:string}`; response is empty `{}` (ThreadArchiveResponse).
- Notification `thread/archived` params exactly `{threadId:string}`; it is not worker thread/closed nor task completion.
- Interrupt an in-flight judge with `turn/interrupt {threadId,turnId}` first; archive a terminated judge. Retain judge ID and raw/validated result for audit even when archive fails. Cleanup failure must not replace an otherwise validated decision.
- Cancellation race is application-level: recheck task_version and ACTIVE before committing judge, validation, verification, or cleanup outcomes. Archive success is not evidence the task completed.

## Fixed argv independent verification and cancellation

Stable command/exec uses `command:string[]`, not argv or shell string. Relevant shape:

```ts
{
 command: task.verify.argv,
 processId: connectionUniqueId,
 cwd: task.workspace,
 timeoutMs: task.verify.timeout_seconds * 1000,
 sandboxPolicy: {
   type:'workspaceWrite', writableRoots:[task.workspace], networkAccess:false,
   excludeTmpdirEnvVar:true, excludeSlashTmp:true
 },
 streamStdoutStderr:false
}
```

- Reuse the verified worker sandbox scope (S1 excludes both temp roots), not inherited global configuration. command/exec does not take approvalPolicy.
- Response is `{exitCode:number,stdout:string,stderr:string}` and is deferred until process exit; explicit nonzero means failure. Do not interpret successful JSON-RPC delivery as successful verification.
- processId is optional for buffered calls but REQUIRED for later cancellation. Supply it even with streamStdoutStderr:false. Request id, processId, turn id, and item id are different identifiers.
- Stable generated cancellation shape exists: `command/exec/terminate {processId}` -> `{}`. Runtime probe below proves Windows sandbox REJECTS this method with -32600; use owned app-server shutdown fallback on this platform. On supported runtimes, the terminate acknowledgment alone is not final command result. Never await original command before sending terminate.
- If terminate method is unavailable/rejected, or cannot establish process termination promptly, close ONLY the owned app-server via existing Rpc.close and invalidate late results; do not kill unrelated global Codex servers. The specification explicitly allows this fallback. Report verifier failure/cancellation, never infer DONE.
- timeoutMs and disableTimeout are mutually exclusive; outputBytesCap and disableOutputCap are mutually exclusive. Streamed output is not duplicated in final stdout/stderr, so keep buffered mode or explicitly collect deltas. Verification argv comes only from immutable task contract, never judge output.
- Existing S1 verify stub omits sandboxPolicy/processId and awaits execution without checking exitCode or hashes; S2 must replace these behaviors. Protected file baseline, pre/post hashes, restored files and tamper rejection are supervisor duties, absent from protocol.

## Incoming server requests and IDs

- RequestId.ts is `string | number`. Server request envelope is `{id,method,params}`. Response must reuse that SAME id as original type and value: `{id,result}` or `{id,error:{code,message}}`. Never use itemId/approvalId instead. Client originated numeric IDs can overlap a server request id; distinguish method-present requests from method-absent responses.
- Current S1 Rpc queues method+params but drops incoming id. Preserve id in the inbound union and add an explicit response writer; otherwise every permission/input callback hangs.
- `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`: refusal result `{decision:'decline'}` (or cancel). Command callback approvalId may be non-null; it is not the RPC response id. Do not accept session or execpolicy amendments.
- `item/permissions/requestApproval`: refusal result `{permissions:{},scope:'turn'}` grants no permission (Generated GrantedPermissionProfile allows optional network/fileSystem). Do not fabricate decision:'decline' for this method.
- Legacy `execCommandApproval` / `applyPatchApproval`: use `{decision:'abort'}` to cancel or `{decision:{denied:{rejection:'reason'}}}`. Legacy enum differs from v2: literal 'decline' is invalid.
- `mcpServer/elicitation/request`: cancel result `{action:'cancel',content:null,_meta:null}`. Such requests should not arise under isolated MCP config; still settle deterministically.
- `item/tool/call`: result `{contentItems:[],success:false}` (or protocol error). Do not run an unregistered tool.
- Unknown methods: reply same id with JSON-RPC method-not-found error code -32601; if turn does not terminate, interrupt it and diagnose after terminal confirmation. Never silently ignore or invent a permissive result.
- `account/chatgptAuthTokens/refresh` is for client-managed auth; existing native auth reuse should not need supplying tokens. Never log raw params or echo secrets.

## Ordinary inputs are explicitly experimental

Generated v2/ToolRequestUserInputParams.ts is labelled EXPERIMENTAL despite being present in stable exported union. Keep initialize.capabilities.experimentalApi=false and test this event through fixtures (the spec explicitly allows simulation).

- Params `{threadId,turnId,itemId,questions,isBlocking,autoResolutionMs}`; use isBlocking, autoResolutionMs deprecated.
- Question `{id,header,question,isOther,isSecret,options:Array<{label,description}>|null}`. No default/recommended field exists.
- Response `{answers:{[questionId]:{answers:string[]}}}`; select valid existing option label. Existing answer/default precedence and recommendation text policy are application rules, not protocol metadata. Credential/isSecret questions must not receive fabricated ordinary answers.
- Judge inputs/permissions must be refused/cancelled and recorded as judge failure; never create a second judge to answer a judge.

## Verification boundary

These claims are from installed stable TS definitions and current S1 source. No live judge, model call, archive operation, verifier process, or runtime cancellation probe was run in this research turn. Parent is responsible for S2 tests and genuine live T01-T05 evidence. No S3 recovery behavior is claimed.
## Runtime capability addendum (2026-11-01, no model)

The schema claims above are not proof of platform runtime support. A real app-server process was launched through the current S1 isolated connect() under a new workspace beneath OS TEMP, approval never / networkAccess false, all external feature flags and four inherited MCP servers disabled. Only command/exec was executed, never a model or thread/turn.

Probe 1 raw record: C:\Users\will\AppData\Local\Temp\needs-forever-s2-exec-BuR971\results.json . Script: C:\Users\will\AppData\Local\Temp\needs-forever-s2-command-probe.mjs . Fixed argv used the installed Node executable, -e, and a constant short script. Buffered mode returned real exitCode=7, stdout="S2_BUFFERED_OK\n", stderr="S2_STDERR_OK\n". This proves the runtime preserves distinct exitCode/stdout/stderr for buffered sandboxed argv execution. It does not prove verifier logic in the product.

Both probes attempted command/exec/terminate with the same supplied processId. Runtime refused with exact JSON-RPC error:

```json
{"code":-32600,"message":"command/exec/write, command/exec/terminate, and command/exec/resize are not supported for windows sandbox processes"}
```

Probe 2 precisely established cancellation fallback behavior with a 60-second process that saved its own PID within its writable temporary workspace. Raw record: C:\Users\will\AppData\Local\Temp\needs-forever-s2-cancel-a84sYh\results.json . Script: C:\Users\will\AppData\Local\Temp\needs-forever-s2-command-cancel-probe.mjs . Child PID 35336 was live before terminate and still live after the -32600 refusal. Closing only owned app-server PID 31064 produced SIGTERM and OS liveness=false, and within 500 ms command PID 35336 also had liveness=false. Original pending command RPC rejected on app-server exit. The whole precise probe finished in 1.54 seconds, ruling out natural completion of the 60-second child. No unrelated process was killed.

Conclusion: S2 must support buffered verification, inspect nonzero exit codes, and use owned app-server close fallback for cancellation on this installed Windows sandbox. Do not advertise command/exec/terminate runtime support merely because the generated protocol includes it. These are environment capability results only, not T01-T05 acceptance, product pause verification, or S3 recovery evidence.
## Runtime normal-timeout addendum (2026-11-01, no model)

Question: Does a normal verification command timeout require closing the owned app-server, or can the same isolated app-server continue?

Probe script: C:\Users\will\AppData\Local\Temp\needs-forever-s2-command-timeout-probe.mjs . Raw response and PID evidence: C:\Users\will\AppData\Local\Temp\needs-forever-s2-timeout-cSjaLl\results.json . Reused current isolated connect() (all external MCP/features disabled, approval never, network false) in a new OS TEMP workspace. Both command/exec calls used buffered fixed argv [Node executable,-e,constant script,pidFilePath], explicit workspaceWrite, unique processId, and a script that writes its PID inside its workspace and waits 60 seconds.

| timeoutMs | Observed elapsed | Actual command PID | PID alive after response | Same server follow-up |
| --- | --- | --- | --- | --- |
| 100 | 157 ms | 38920 | false | exitCode 0, stdout S2_AFTER_TIMEOUT_OK, 89 ms |
| 300 | 350 ms | 10608 | false | exitCode 0, stdout S2_AFTER_TIMEOUT_OK, 86 ms |

Both timeout requests returned an error envelope, not a CommandExecResponse and not an exitCode field:

```json
{"error":{"code":-32603,"message":"exec failed: sandbox error: command timed out"},"id":3}
```

Both follow-up requests used the original app-server PID 8584 and returned `{exitCode:0,stdout:"S2_AFTER_TIMEOUT_OK\n",stderr:""}`. App-server remained live following each timeout. Only after finishing both follow-up checks did the probe close its owned server; PID 8584 then had liveness=false / SIGTERM. Entire probe took 1.69 seconds, so neither 60-second command could have naturally finished. All observed command PIDs exited. No model/threads, project files, global configuration, unrelated processes, or S3 recovery were involved.

Conclusion: distinguish normal command/exec timeout from user-driven cancellation. On installed Windows 0.166.0, timeoutMs itself terminates the child and preserves the app-server for subsequent repair work. Do not close a healthy app-server for this timeout outcome. In contrast, active cancellation via command/exec/terminate remains unsupported (-32600) and requires the owned app-server close fallback when cancelling a still-running verifier. These are environmental capabilities, not product acceptance.