import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, openSync, closeSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { reachedLimits } from './rules.js';
import { Store } from './store.js';
import { record, text } from './types.js';
import type { State, Task } from './types.js';

export interface MainSessionState extends State {
  control_mode: 'main-session';
  main_session_id: string | null;
  run_generation: string;
  contract_sha256: string;
  binding: { status: 'PENDING_NATIVE_HOOK' | 'BOUND' | 'RELEASED'; tool_use_id: string | null; bound_at: string | null; challenge: string; task_path: string; operation?: 'prepare' | 'resume' };
  host: { desktop_version: string | null; cli_version: string | null; hook_effective: boolean; source: 'unverified' | 'native-desktop' | 'simulated'; reason: string; desktop_pid?: number; desktop_binary?: string };
  last_stop?: StopRequest;
  controller?: { id: string; pid: number; endpoint: string; token: string; lifecycle: 'running' | 'exited'; started_at: string; run_generation: string; plugin_root: string; bundle_sha256?: string };
  stop_transport?: { request: StopRequest; outcome: 'pending' | 'returned' | 'unknown' | 'failed'; error?: string; delivery_id?: string };
  continuation_confirmed?: boolean;
  tool_starts?: Record<string, { at: string; input_sha256: string }>;
  input_epoch?: number;
  direction_context?: { delivery_id: string; at: string; run_generation: string; input_epoch: number; contract_sha256: string };
  latest_human_input?: { prompt: string; at: string; input_epoch: number };
  observed_turn_ids?: string[];
  active_checkpoint_at?: string;
  processed_event_ids?: string[];
  accepted_stop_occurrences?: string[];
  processed_tool_ids?: string[];
  recovery_history?: unknown[];
  controller_startup_deadline?: string;
}
export interface StopRequest {
  schema_version: 1;
  task_id: string;
  task_version: number;
  contract_sha256: string;
  run_generation: string;
  session_id: string;
  turn_id: string | null;
  stop_attempt_id: string;
  stop_hook_active: boolean;
  created_at: string;
  deadline_at: string;
  mode: 'live' | 'simulated';
  last_assistant_message: string | null;
}
export function readJson(path: string): any {
  // Windows can briefly deny a read while the state checkpoint is being
  // atomically replaced by another owner. Keep the previous checkpoint
  // intact and retry transient sharing errors instead of turning a completed
  // judgment into an unknown recovery state.
  const deadline = Date.now() + 5_000;
  while (true) {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 40));
    }
  }
}
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}
export function canonicalPath(path: string): string {
  const result = realpathSync(path);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
export function contractHash(task: Task): string { return createHash('sha256').update(JSON.stringify(task)).digest('hex'); }
export function indexPath(workspace: string): string { return resolve(workspace, '.codex-supervisor', 'main-session-index.json'); }
export function mainLeasePath(session: string): string { return resolve(tmpdir(), 'codex-supervisor-locks', `main-session-${createHash('sha256').update(session).digest('hex')}.lock`); }
function registerState(workspace: string, statePath: string): void {
  // One immutable identity slot per checkpoint avoids a workspace-wide RMW
  // lock, including a lock left behind by a crash during registration.
  const key = createHash('sha256').update(resolve(statePath)).digest('hex');
  atomicJson(resolve(workspace, '.codex-supervisor', 'main-session-bindings', `${key}.json`), { schema_version: 1, state_path: statePath });
}
export function registeredStatePaths(workspace: string): string[] {
  const old = indexPath(workspace);
  const directory = resolve(workspace, '.codex-supervisor', 'main-session-bindings');
  const entries: string[] = existsSync(old) ? readJson(old).states : [];
  if (existsSync(directory)) for (const name of readdirSync(directory)) {
    if (/^[a-f0-9]{64}\.json$/.test(name)) entries.push(readJson(resolve(directory, name)).state_path);
  }
  return [...new Set(entries)];
}
export function validateTask(input: unknown): Task {
  const task = record(input);
  if (task.schema_version !== 1) throw new Error('schema_version must be 1.');
  const taskId = text(task.task_id, 'task_id');
  if (!/^[\w.-]+$/.test(taskId) || ['.', '..'].includes(taskId)) throw new Error('Invalid task_id.');
  const workspace = text(task.workspace, 'workspace');
  if (!isAbsolute(workspace) || !statSync(workspace).isDirectory()) throw new Error('workspace must be an existing absolute directory.');
  if (!Array.isArray(task.acceptance) || !task.acceptance.length) throw new Error('acceptance must be nonempty.');
  const acceptance = task.acceptance.map((entry) => { const item = record(entry); return { id: text(item.id, 'acceptance.id'), text: text(item.text, 'acceptance.text') }; });
  if (new Set(acceptance.map((entry) => entry.id)).size !== acceptance.length) throw new Error('acceptance ids must be unique.');
  const limits = record(task.limits ?? {});
  for (const name of ['max_worker_turns', 'max_minutes']) {
    if (limits[name] != null && (typeof limits[name] !== 'number' || !Number.isFinite(limits[name]) || limits[name] <= 0 || (name === 'max_worker_turns' && !Number.isInteger(limits[name])))) throw new Error(`Invalid ${name}.`);
  }
  const result: Task = { schema_version: 1, task_id: taskId, workspace: resolve(workspace), goal: text(task.goal, 'goal'), acceptance, authorization: text(task.authorization, 'authorization'), limits: { max_worker_turns: limits.max_worker_turns as number ?? null, max_minutes: limits.max_minutes as number ?? null } };
  if (task.verify !== undefined) {
    const verify = record(task.verify);
    if (!Array.isArray(verify.argv) || !verify.argv.length || !verify.argv.every((entry) => typeof entry === 'string' && entry.length)) throw new Error('Invalid verify.argv.');
    if (typeof verify.timeout_seconds !== 'number' || !Number.isFinite(verify.timeout_seconds) || verify.timeout_seconds <= 0) throw new Error('Invalid verify.timeout_seconds.');
    if (!Array.isArray(verify.protected_files) || !verify.protected_files.every((entry) => typeof entry === 'string' && entry.length)) throw new Error('Invalid verify.protected_files.');
    result.verify = { argv: verify.argv as string[], timeout_seconds: verify.timeout_seconds, protected_files: verify.protected_files as string[] };
  }
  return result;
}
function validatedTask(path: string): Task { return validateTask(readJson(path)); }
export function prepareMainSession(taskPath: string, statePath: string, simulated = false): MainSessionState {
  if (existsSync(statePath)) throw new Error('Task state already exists; use explicit resume.');
  const task = validatedTask(taskPath);
  if (canonicalPath(process.cwd()) !== canonicalPath(task.workspace)) throw new Error('Preparation cwd must match the task workspace.');
  const store = new Store(statePath);
  store.lock(task);
  try {
    const state: MainSessionState = {
      schema_version: 1, task_id: task.task_id, task_version: 1, task,
      control_mode: 'main-session', main_session_id: null, run_generation: randomUUID(), contract_sha256: contractHash(task),
      binding: { status: 'PENDING_NATIVE_HOOK', tool_use_id: null, bound_at: null, challenge: randomUUID(), task_path: resolve(taskPath) },
      host: { desktop_version: null, cli_version: null, hook_effective: false, source: simulated ? 'simulated' : 'unverified', reason: 'Awaiting a correlated native Desktop hook. Review the installed plugin hooks in Settings > Hooks if necessary.' },
      worker_thread_id: null, status: 'PAUSED', phase: 'RECOVERING', active_worker_turn_id: null, reviewing_turn_id: null,
      handled_turn_ids: [], pending_action: null, retry: { kind: null, attempt: 0, next_at: null }, last_decision: null,
      worker_turn_count: 0, elapsed_active_seconds: 0, updated_at: new Date().toISOString(), codex_version: null, mode: simulated ? 'simulated' : 'live',
      recovery_condition: { kind: 'native_hook_required', message: 'Awaiting a correlated native Desktop hook; supervision is not active.', resume_when: 'Review/trust the plugin hooks and run preparation from the intended main session.' },
    };
    store.protect(state);
    store.save(state);
    registerState(task.workspace, statePath);
    store.event(state, 'main_session_prepared', { control_mode: state.control_mode, binding_status: state.binding.status });
    return state;
  } finally { store.release(); }
}
export function resumeMainSession(statePath: string, taskPath?: string, simulated = false): MainSessionState {
  let state = readJson(statePath) as MainSessionState;
  if (state.control_mode !== 'main-session' || (!state.main_session_id && state.binding.status !== 'PENDING_NATIVE_HOOK') || state.status === 'DONE') throw new Error('Explicit resume requires an unfinished main-session checkpoint.');
  const store = new Store(statePath); store.lock(state.task, true);
  try {
    state = readJson(statePath) as MainSessionState;
    if (state.control_mode !== 'main-session' || state.status === 'DONE') throw new Error('Checkpoint changed before the resume lock was acquired.');
    if (state.controller) {
      try { process.kill(state.controller.pid, 0); throw new Error('Controller is still alive; pause it and wait for its owned exit before resume.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    const task = taskPath ? validatedTask(taskPath) : validateTask(state.task);
    if (task.task_id !== state.task_id || canonicalPath(task.workspace) !== canonicalPath(state.task.workspace) || canonicalPath(process.cwd()) !== canonicalPath(task.workspace)) throw new Error('Resume must preserve task and workspace identity.');
    if ((state.mode === 'simulated') !== simulated) throw new Error('Resume must preserve live/simulated mode.');
    if (state.status !== 'PAUSED' && (task.goal !== state.task.goal || task.authorization !== state.task.authorization)) throw new Error('Changing goal or authorization requires durable PAUSED first.');
    if (JSON.stringify(task.verify) !== JSON.stringify(state.task.verify)) throw new Error('The original independent verifier and protected baseline are fixed for this task.');
    const limits = reachedLimits(task.limits, state);
    if (limits.turns || limits.time) throw new Error('Cumulative user_limit reached; explicitly raise/remove limits before resume.');
    const leasePath = state.main_session_id ? mainLeasePath(state.main_session_id) : null;
    if (leasePath && existsSync(leasePath)) {
      const guard = `${leasePath}.reclaim`; const fd = openSync(guard, 'wx');
      try {
        const owner = readJson(leasePath);
        if (owner.state_path !== statePath || owner.main_session_id !== state.main_session_id || owner.controller_id !== state.controller?.id || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Main-session lease identity is ambiguous; cannot reclaim.');
        try { process.kill(owner.pid, 0); throw new Error('Main-session lease owner is still alive.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        unlinkSync(leasePath);
      } finally { closeSync(fd); unlinkSync(guard); }
    }
    state.recovery_history = [...(state.recovery_history ?? []), { at: new Date().toISOString(), run_generation: state.run_generation, controller: state.controller, stop_transport: state.stop_transport, pending_action: state.pending_action }];
    state.task = task; state.task_version++; state.contract_sha256 = contractHash(task); state.run_generation = randomUUID();
    delete state.controller; delete state.last_stop; delete state.stop_transport; delete state.direction_context; delete state.active_checkpoint_at;
    state.pending_action = null; state.tool_starts = {}; state.continuation_confirmed = false; state.input_epoch = (state.input_epoch ?? 0) + 1;
    state.status = 'PAUSED'; state.phase = 'RECOVERING'; delete state.pause_reason;
    state.binding = { ...state.binding, status: 'PENDING_NATIVE_HOOK', challenge: randomUUID(), tool_use_id: null, operation: 'resume' };
    state.host.hook_effective = false; state.host.reason = 'Explicit resume awaits a fresh native receipt from the original main session.';
    state.recovery_condition = { kind: 'resume_native_receipt', message: state.host.reason, resume_when: 'Complete resume in the original A, then wait for a new native Stop. Old directions are never replayed.' };
    store.save(state); store.event(state, 'main_session_resume_prepared', { main_session_id: state.main_session_id, run_generation: state.run_generation });
    registerState(task.workspace, statePath); return state;
  } finally { store.release(); }
}
export function mainSessionStatus(path: string): Record<string, unknown> {
  const state = readJson(path);
  return { ...state, control_mode: state.control_mode ?? 'independent-worker', live: false, recovery_required: state.status === 'ACTIVE' || state.binding?.status === 'PENDING_NATIVE_HOOK' };
}
