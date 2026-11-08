import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { armNativeRebind, atomicJson, canonicalPath, contractHash, registeredStatePaths, readJson } from './main-session.js';
import type { MainSessionState, StopRequest } from './main-session.js';
import type { HookHost } from './hook-host.js';
import { Store } from './store.js';
import { record, text } from './types.js';
import { redact } from './redact.js';
import { controlIntent } from './control-intent.js';
import { createRecoveryPlan } from './recovery-coordinator.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
function isAgent(event: Record<string, unknown>): boolean {
  return event.agent_id != null || event.agent_type != null || event.agent_transcript_path != null || event.hook_event_name === 'SubagentStop' || event.hook_event_name === 'SubagentStart';
}
function reasonValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of ['reason', 'message', 'text', 'value']) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === 'string' && field.trim()) return field.trim();
  }
  return null;
}
function stopReason(message: unknown): string | null {
  if (typeof message !== 'string') return reasonValue(message);
  const value = String(redact(message));
  // The worker may emit one explicit structured field in the hook payload or
  // final message: `STOP_REASON: ...`. Keep the value verbatim and never infer
  // a reason from ordinary prose; an unmarked Stop must remain blank in the UI.
  const match = value.match(/(?:^|\r?\n)\s*STOP_REASON\s*[:=]\s*([^\r\n]+)\s*(?:\r?\n|$)/i);
  if (!match) return null;
  const candidate = match[1]?.trim() ?? '';
  if (!candidate) return null;
  try {
    const structured = JSON.parse(candidate) as unknown;
    const parsed = reasonValue(structured);
    return parsed;
  } catch {
    // Plain text is the normal structured field value.
  }
  return candidate;
}
export interface LifecycleResult {
  bound?: boolean;
  stop_request?: StopRequest;
  state_path?: string;
}
export function handleLifecycle(input: unknown, host: HookHost, pluginRoot: string, adapterOccurrenceId?: string): LifecycleResult {
  const event = record(input);
  const name = text(event.hook_event_name, 'hook_event_name');
  if (isAgent(event)) return {};
  const workspace = text(event.cwd, 'cwd');
  if (canonicalPath(workspace) !== canonicalPath(process.cwd())) return {};
  const session = text(event.session_id, 'session_id');
  if (host.source === 'unverified') return {};
  const toolId = typeof event.tool_use_id === 'string' ? event.tool_use_id : null;
  const observation = toolId ? resolve(workspace, '.codex-supervisor', 'hook-observations', `${hash([session, toolId])}.json`) : null;
  if (name === 'PreToolUse' && observation) {
    if (controlIntent(event.tool_input, pluginRoot)) {
    // Only fingerprints are retained; command bodies can contain credentials.
    atomicJson(observation, { session_id: session, tool_use_id: toolId, cwd: canonicalPath(workspace), input_sha256: hash(event.tool_input), source: host.source, at: Date.now(), plugin_root: canonicalPath(pluginRoot) });
    return {};
    }
  }
  const entries = registeredStatePaths(workspace);
  for (const path of entries) {
    if (!existsSync(path)) continue;
    const state = readJson(path) as MainSessionState;
    if (!state.recovery_plan && state.status !== 'DONE' && state.binding.status === 'PENDING_NATIVE_HOOK') {
      const condition = state.recovery_condition ?? { kind: 'native_hook_required', message: 'Awaiting a correlated native receipt from the original A.', resume_when: 'Complete the supported native binding command in the original A.' };
      state.recovery_plan = createRecoveryPlan(state, condition, true);
      const store = new Store(path); store.save(state); store.event(state, 'recovery_plan_rehydrated', { generation: state.recovery_plan.generation, task_version: state.task_version });
    }
    // Checkpoints created before automatic rebind used operation=resume. Once
    // the original A is known and no user pause exists, migrate that pending
    // checkpoint to the fenced automatic-rebind protocol on its next trusted
    // lifecycle callback. The callback itself remains the real receipt.
    if (!state.pause_reason && state.status !== 'DONE' && state.binding.status === 'PENDING_NATIVE_HOOK' && state.binding.operation === 'resume' && state.main_session_id === session && ['SessionStart', 'UserPromptSubmit'].includes(name)) {
      armNativeRebind(state, 'Migrated pending resume to automatic native rebind.');
      const store = new Store(path); store.save(state); store.event(state, 'native_rebind_migrated', { main_session_id: session, task_version: state.task_version, run_generation: state.run_generation });
    }
    if (state.control_mode !== 'main-session' || state.status === 'DONE' || canonicalPath(state.task.workspace) !== canonicalPath(workspace)) continue;
    if (state.contract_sha256 !== contractHash(state.task)) continue;
    if ((state.mode === 'simulated') !== (host.source === 'simulated')) continue;
    if (state.binding.status === 'BOUND' && state.main_session_id === session && state.status === 'ACTIVE') {
      const turn = typeof event.turn_id === 'string' ? event.turn_id : null;
      state.observed_turn_ids ??= [];
      if (turn && !state.observed_turn_ids.includes(turn)) { state.observed_turn_ids.push(turn); state.worker_turn_count++; }
      // Hosts without turn ids prove at least one turn; Stop callbacks alone
      // never prove that an internal continuation created another turn.
      if (!turn && state.worker_turn_count === 0) state.worker_turn_count = 1;
    }
    if (state.binding.status === 'BOUND' && state.main_session_id === session && state.status === 'ACTIVE' && toolId && ['PreToolUse', 'PostToolUse'].includes(name)) {
      const store = new Store(path);
      state.tool_starts ??= {};
      if (state.processed_tool_ids?.includes(toolId)) return {};
      if (name === 'PreToolUse') {
        state.tool_starts[toolId] = { at: new Date().toISOString(), input_sha256: hash(event.tool_input) };
        const keys = Object.keys(state.tool_starts);
        for (const key of keys.slice(0, Math.max(0, keys.length - 128))) delete state.tool_starts[key];
      } else {
        const start = state.tool_starts[toolId];
        if (!start || start.input_sha256 !== hash(event.tool_input)) return {};
        const serialized = JSON.stringify(redact({ hook_event_name: name, tool_name: event.tool_name ?? null, tool_input: event.tool_input ?? null, tool_response: event.tool_response ?? null }));
        const truncated = serialized.length > 8_000;
        store.event(state, 'main_tool_result', { session_id: session, turn_id: event.turn_id ?? null, tool_use_id: toolId, run_generation: state.run_generation, input_epoch: state.input_epoch ?? 0, contract_sha256: state.contract_sha256, original_event: name, value: truncated ? { truncated: true, prefix: serialized.slice(0, 8_000) } : JSON.parse(serialized), complete: !truncated });
        const context = state.direction_context;
        if (start && start.input_sha256 === hash(event.tool_input) && state.pending_action?.stage === 'sent' && context && context.delivery_id === state.pending_action.delivery_id && context.run_generation === state.run_generation && context.input_epoch === (state.input_epoch ?? 0) && context.contract_sha256 === state.contract_sha256 && Date.parse(start.at) >= Date.parse(context.at)) {
          state.pending_action.stage = 'confirmed';
          state.pending_action.target_turn_id = typeof event.turn_id === 'string' ? event.turn_id : null;
          state.continuation_confirmed = true;
          store.event(state, 'main_session_continuation_confirmed', { session_id: session, turn_id: event.turn_id ?? null, delivery_id: context.delivery_id, tool_use_id: toolId, original_event: name });
        }
        delete state.tool_starts[toolId];
        state.processed_tool_ids = [...(state.processed_tool_ids ?? []), toolId];
      }
      store.save(state);
      return {};
    }
    if (name === 'Stop' && state.binding.status === 'BOUND' && state.main_session_id === session && !state.pause_reason) {
      const request: StopRequest = {
        schema_version: 1, task_id: state.task_id, task_version: state.task_version, contract_sha256: state.contract_sha256,
        run_generation: state.run_generation, session_id: session, turn_id: typeof event.turn_id === 'string' ? event.turn_id : null,
        stop_attempt_id: adapterOccurrenceId ?? randomUUID(), stop_hook_active: event.stop_hook_active === true,
        created_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 590_000).toISOString(), mode: state.mode,
        last_assistant_message: typeof event.last_assistant_message === 'string' ? String(redact(event.last_assistant_message)).slice(0, 32_000) : null,
      };
      state.last_stop = request;
      const store = new Store(path);
      store.save(state);
      const stopReasonValue = stopReason(event.stop_reason ?? event.STOP_REASON) ?? stopReason(request.last_assistant_message);
      store.event(state, 'main_session_stop_observed', { session_id: session, turn_id: request.turn_id, stop_attempt_id: request.stop_attempt_id, run_generation: state.run_generation, host_source: host.source, ...(stopReasonValue ? { stop_reason: stopReasonValue } : {}) });
      // This only creates the request. The B adapter must validate an active
      // lease and return a supported host decision before claiming readiness.
      return state.status === 'ACTIVE' ? { state_path: path, stop_request: request } : {};
    }
    if (state.pause_reason || state.binding.status !== 'PENDING_NATIVE_HOOK') continue;

    // Automatic recovery never trusts an old prepare/resume receipt. Once B
    // or its host identity is invalidated, the checkpoint carries a fresh
    // generation and the original A identity. Only a real lifecycle callback
    // from that same A can rebind it; no controller or C is started before
    // this branch returns `bound` to the native adapter.
    if (state.binding.operation === 'rebind') {
      if (!['SessionStart', 'UserPromptSubmit'].includes(name)) continue;
      if (state.main_session_id !== session) continue;
      const expectedWorkspace = state.binding.expected_workspace;
      const expectedTaskVersion = state.binding.expected_task_version;
      const expectedSession = state.binding.expected_main_session_id;
      const expectedGeneration = state.binding.expected_run_generation;
      if (expectedSession !== session || (expectedWorkspace && canonicalPath(expectedWorkspace) !== canonicalPath(workspace)) || expectedTaskVersion !== state.task_version || expectedGeneration !== state.run_generation) continue;
      if (typeof event.run_generation === 'string' && event.run_generation !== expectedGeneration) continue;
      const store = new Store(path);
      state.binding = { ...state.binding, status: 'BOUND', tool_use_id: null, bound_at: new Date().toISOString() };
      state.host = { ...host, hook_effective: false, reason: 'Original main-session lifecycle receipt correlated; awaiting exactly one replacement controller.' };
      state.recovery_condition = { kind: 'rebind_controller_required', message: 'Original main session re-bound; supervision is not active until the replacement controller is ready.', resume_when: 'Allow the replacement B to start, then wait for a native Stop callback.' };
      store.save(state);
      store.event(state, 'main_session_rebind_receipt', {
        main_session_id: session,
        task_version: state.task_version,
        run_generation: state.run_generation,
        hook_event_name: name,
        host_source: host.source,
      });
      return { bound: true, state_path: path };
    }
    if (name !== 'PostToolUse' || !observation || !existsSync(observation)) continue;
    const prior = readJson(observation);
    if (prior.session_id !== session || prior.tool_use_id !== toolId || prior.input_sha256 !== hash(event.tool_input) || prior.source !== host.source || prior.cwd !== canonicalPath(workspace) || prior.plugin_root !== canonicalPath(pluginRoot) || Date.now() - prior.at > 10 * 60_000) continue;
    const intent = controlIntent(event.tool_input, pluginRoot);
    // Actual receipt output (unknown before preparation) correlates a registered
    // host's pre/post pair to this one task. A session-id flag cannot do this.
    const operation = state.binding.operation ?? 'prepare';
    if (!intent || intent.operation !== operation) continue;
    if (operation === 'prepare' && (!intent.flags['--task'] || canonicalPath(intent.flags['--task']) !== canonicalPath(state.binding.task_path))) continue;
    if (intent.flags['--state'] ? canonicalPath(intent.flags['--state']) !== canonicalPath(path) : intent.entry !== 'control' || operation !== 'prepare') continue;
    if (!strings(event.tool_response).some((value) => value.includes(state.binding.challenge))) continue;
    if (operation === 'resume' && state.main_session_id !== null && state.main_session_id !== session) continue;
    state.main_session_id = session;
    state.binding = { ...state.binding, status: 'BOUND', tool_use_id: toolId, bound_at: new Date().toISOString() };
    state.host = { ...host, hook_effective: false, reason: 'Main-session identity correlated; awaiting a real Stop callback and background control readiness.' };
    state.recovery_condition = { kind: 'stop_hook_required', message: 'Main-session bound; supervision is not active until background control and Stop callback are confirmed.', resume_when: 'Start the bound background controller and observe its native Stop callback.' };
    const store = new Store(path);
    store.save(state);
    store.event(state, 'main_session_bound', { main_session_id: session, tool_use_id: toolId, host_source: host.source, desktop_version: host.desktop_version, cli_version: host.cli_version });
    return { bound: true, state_path: path };
  }
  return {};
}
