# QuantResearch #793 supervision deviations

- Monitoring target: `01a1ae7a-9442-79e0-b32b-aa560f976453`
- NFG: `http://127.0.0.1:8788/tasks/quantresearch-793-supervise`
- First recorded: 2026-11-08 (Asia/Singapore)

## Recording rule

Record only observable deviations between the intended A→B→C contract and persisted events/state. A local fix is recorded separately from the remaining follow-up. Never treat a missing event as a successful C call.

## Resolved deviations

1. **NFG rendered a supervisor placeholder before C existed.**
   - Observation: a worker/controller-only round displayed `等待 supervisor 处理`.
   - Fix: NFG/API now filters out rounds without a real supervisor event; the empty state is `暂无完整 A→B→C 监督轮次`.
   - Regression: `TaskCatalog hides rounds until a real supervisor event completes A→B→C`.

2. **Main-session A events were not grouped with the C stop attempt.**
   - Observation: real C events used `stop_attempt_id`, while A tool events used the main-session `turn_id`; the same supervision cycle showed `暂无 worker 事件`.
   - Fix: `main_session_stop_observed.turn_id → stop_attempt_id` correlation; `main_tool_result` is classified as the A/worker leg.
   - Regression: `TaskCatalog treats a main-session tool result as the A worker leg`.

## Live execution deviation / follow-up

3. **Native hook effectiveness lagged behind controller binding.**
   - Observation: QR #793 first reached `BOUND` with the controller running while `hook_effective=false` and `continuation_confirmed=false`. A later real Stop produced `judge_created`, `judge_output`, `judge_archived`, `decision`, and `stop_hook_direction_returned`, proving one C cycle.
   - Impact: controller reachability alone must never be reported as a completed supervision loop.
   - Follow-up: expose these three facts independently in NFG and require the complete persisted event chain before showing a round or claiming continuation.

4. **GitHub public readback route failed during the active worker turn.**
   - Observation: the target thread's `github.fetch_issue` call failed; the failure is recorded as a tool failure rather than converted into Issue state.
   - Impact: #793 cannot claim public Issue verification or closure while this route is unavailable.
   - Follow-up: retry only when the route is available; keep local evidence and implementation work separate from unverified remote Issue state.

5. **Repeated Stops in one main turn were initially treated as ambiguous.**
   - Observation: both real Stop/C cycles reused the same main-session `turn_id`, while each had a different `stop_attempt_id`; the first correlation implementation refused to map untagged A events when one turn had multiple attempts, so both rounds rendered `暂无 worker 事件`.
   - Fix: partition untagged A events by the next chronological `main_session_stop_observed` boundary; attach continuation confirmation to the previous boundary. This preserves separate A→B→C rounds.
   - Regression: `TaskCatalog assigns repeated main-session work to the next matching Stop/C round`.

6. **NFG exposed internal event names as if they were the causal flow.**
   - Observation: a completed round showed `main_tool_result`, `judge_created`, and `judge_archived` in one generic timeline, which made it look as if `main_tool_result` triggered C.
   - Fix: the visible round now renders only `WORKER 发出: Stop`, `SUPERVISOR 判断`, the decision JSON, and `WORKER 收到` prompt. Internal events remain persisted but are not presented as the user-facing flow.
   - Regression: the web page must contain the three explicit flow labels and must not contain the old `supervisor 怎么处理` label.

## Current observation

QR #793 remains `ACTIVE` and is continuing a local audit. The latest worker direction preserves the external Tushare rate-limit condition, does not fabricate a fresh authority bundle, and does not touch forward holdout. Continue monitoring for the next Stop/C cycle and append only new observable deviations.

7. **Historical Stop events did not preserve a semantic worker reason.**
   - Observation: `main_session_stop_observed` persisted session/turn/attempt identity but no reason; the UI fallback text therefore overstated what the evidence proved.
   - Fix: omit the reason when it is absent. Future Stop events persist only the worker's explicit structured `STOP_REASON: ...` field (including a JSON `reason`/`message` value); the NFG displays that value verbatim and never infers a category from ordinary prose.
