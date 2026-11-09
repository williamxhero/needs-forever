import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import type { MainSessionState } from './main-session.js';
import type { RecoveryPlan, State } from './types.js';
import { nextBackoff } from './recovery.js';

const DELAYS = [5, 15, 60, 300] as const;

export type RecoveryReason = { kind: string; message: string; resume_when: string };
export type RecoveryCancellation = 'pause' | 'delete' | 'done';

function leasePath(statePath: string): string {
  const identity = createHash('sha256').update(resolve(statePath)).digest('hex');
  return resolve(tmpdir(), 'codex-supervisor-locks', `recovery-${identity}.lock`);
}

/** Return a fresh plan for a newly prepared task. */
export function createRecoveryPlan(state: Pick<State, 'task_version'> & { run_generation?: string }, reason: RecoveryReason, waitingNative = false): RecoveryPlan {
  const generation = state.run_generation ?? randomUUID();
  return {
    owner: null,
    generation,
    task_version: state.task_version,
    attempt: 0,
    next_retry_at: null,
    reason,
    status: waitingNative ? 'waiting_native' : 'armed',
    cancellation_boundary: null,
  };
}

/**
 * Arm the persisted plan before a retry delay.  Saving the state is left to
 * the caller so the same transition can be checkpointed with its event.
 */
export function armRecovery(state: State & { run_generation?: string }, reason: RecoveryReason, now = Date.now()): RecoveryPlan {
  const previous = state.recovery_plan;
  const generation = state.run_generation ?? previous?.generation ?? randomUUID();
  if (previous?.cancellation_boundary && previous.generation === generation) return previous;
  const attempt = previous?.generation === generation ? previous.attempt + 1 : 1;
  const backoff = nextBackoff(attempt, now, DELAYS);
  const plan: RecoveryPlan = {
    owner: previous?.generation === generation ? previous.owner : null,
    generation,
    task_version: state.task_version,
    attempt,
    next_retry_at: backoff.next_at,
    reason,
    status: 'armed',
    cancellation_boundary: null,
  };
  state.recovery_plan = plan;
  return plan;
}

/** Enter the honest waiting-for-native-receipt state without scheduling a
 * busy retry loop.  A subsequent native receipt can move the plan to running.
 */
export function waitForNativeReceipt(state: State & { run_generation?: string }, reason: RecoveryReason): RecoveryPlan {
  const generation = state.run_generation ?? state.recovery_plan?.generation ?? randomUUID();
  const previous = state.recovery_plan;
  if (previous?.cancellation_boundary && previous.generation === generation) return previous;
  const plan: RecoveryPlan = {
    owner: null,
    generation,
    task_version: state.task_version,
    attempt: previous?.generation === generation ? previous.attempt : 0,
    next_retry_at: null,
    reason,
    status: 'waiting_native',
    cancellation_boundary: previous?.generation === generation ? previous.cancellation_boundary : null,
  };
  state.recovery_plan = plan;
  return plan;
}

export function markRecoveryRunning(state: State & { run_generation?: string }, owner: RecoveryPlan['owner']): RecoveryPlan {
  const current = state.recovery_plan;
  if (!current || current.cancellation_boundary || current.task_version !== state.task_version || (state.run_generation && current.generation !== state.run_generation)) throw new Error('Stale recovery generation cannot become running.');
  current.owner = owner;
  current.status = 'running';
  current.next_retry_at = null;
  return current;
}

/** Persist an explicit cancellation boundary.  It remains in state so an old
 * timer or controller can prove that its result is stale after a restart.
 */
export function cancelRecovery(state: State & { run_generation?: string }, kind: RecoveryCancellation, now = Date.now()): RecoveryPlan {
  const current = state.recovery_plan ?? createRecoveryPlan(state, { kind: 'none', message: '', resume_when: '' });
  current.owner = null;
  current.status = 'cancelled';
  current.next_retry_at = null;
  current.cancellation_boundary = { kind, at: new Date(now).toISOString(), generation: current.generation };
  state.recovery_plan = current;
  return current;
}

export function recoveryCurrent(state: State & { run_generation?: string }, plan: Pick<RecoveryPlan, 'generation' | 'task_version'>): boolean {
  const current = state.recovery_plan;
  return !!current && !current.cancellation_boundary && current.generation === plan.generation && current.task_version === plan.task_version && (!state.run_generation || state.run_generation === plan.generation) && state.status !== 'DONE' && state.status !== 'PAUSED';
}

/** Claim the cross-process watchdog lease.  The lease payload carries the
 * generation and task version, so an old process cannot reclaim a newer plan.
 */
export function acquireRecoveryOwner(statePath: string, state: MainSessionState): { owner: NonNullable<RecoveryPlan['owner']>; release: () => void } {
  const plan = state.recovery_plan;
  if (!plan || plan.status === 'cancelled' || plan.cancellation_boundary || plan.task_version !== state.task_version || plan.generation !== state.run_generation) throw new Error('Recovery plan is cancelled or stale.');
  const path = leasePath(statePath);
  const id = randomUUID();
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let existing: any;
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Recovery owner lease is unreadable; refusing to replace it.'); }
    if (existing.state_path !== resolve(statePath) || !Number.isInteger(existing.pid) || existing.pid <= 0) throw new Error('Recovery owner lease identity is ambiguous; refusing to replace it.');
    try { process.kill(existing.pid, 0); throw new Error('Recovery owner is still alive.'); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
    unlinkSync(path);
    fd = openSync(path, 'wx', 0o600);
  }
  const heartbeat = new Date().toISOString();
  const owner = { id, pid: process.pid, lease_path: path, task_version: state.task_version, generation: state.run_generation, heartbeat_at: heartbeat };
  writeFileSync(fd, JSON.stringify({ ...owner, state_path: resolve(statePath) }));
  closeSync(fd);
  let released = false;
  return { owner, release: () => { if (released) return; released = true; try { const saved = JSON.parse(readFileSync(path, 'utf8')); if (saved.id === id) unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } };
}

export function recoveryLeasePath(statePath: string): string { return leasePath(statePath); }

/** Reconcile a controller/watchdog that disappeared without running its
 * shutdown handler.  Binding recovery remains fenced by the original-A
 * lifecycle receipt; ordinary NF recovery prompts are recorded separately by
 * the provider adapter and never substitute for that binding evidence.
 */
export function reconcileStaleOwner(state: MainSessionState, now = Date.now()): boolean {
  const plan = state.recovery_plan;
  if (!plan || plan.status === 'cancelled' || plan.cancellation_boundary || state.status === 'PAUSED' || state.status === 'DONE') return false;
  const owner = plan.owner;
  if (!owner) return false;
  let alive = false;
  try { process.kill(owner.pid, 0); alive = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  if (alive) return false;
  if (owner.generation !== plan.generation || owner.task_version !== plan.task_version || owner.generation !== state.run_generation || owner.task_version !== state.task_version) return false;
  if (state.controller) state.controller = { ...state.controller, lifecycle: 'exited' };
  // A dead controller invalidates the old generation.  Arm the same fenced
  // native rebind used by the lifecycle path so the next real A receipt can
  // restart B; leaving operation="resume" here would make lifecycle ignore
  // SessionStart/UserPromptSubmit and strand the task in RECOVERING.
  const generation = randomUUID();
  const armedAt = new Date(now).toISOString();
  state.run_generation = generation;
  state.input_epoch = (state.input_epoch ?? 0) + 1;
  state.pending_action = null;
  delete state.direction_context;
  delete state.last_stop;
  state.tool_starts = {};
  state.continuation_confirmed = false;
  state.phase = 'RECOVERING';
  state.host.hook_effective = false;
  state.last_error = 'Recovery owner exited unexpectedly; waiting for a fresh native receipt from the original A.';
  state.binding = {
    ...state.binding,
    status: 'PENDING_NATIVE_HOOK',
    tool_use_id: null,
    bound_at: null,
    challenge: randomUUID(),
    operation: 'rebind',
    expected_main_session_id: state.main_session_id,
    expected_workspace: resolve(state.task.workspace),
    expected_task_version: state.task_version,
    expected_run_generation: generation,
    armed_at: armedAt,
  };
  state.recovery_condition = { kind: 'native_rebind', message: state.last_error, resume_when: 'A real native receipt from the original A must be correlated before B/C can restart.' };
  state.recovery_plan = {
    ...plan,
    owner: null,
    generation,
    next_retry_at: null,
    status: 'waiting_native',
    reason: state.recovery_condition,
    cancellation_boundary: null,
  };
  return true;
}

/**
 * Consume one persisted recovery deadline from a process that is independent
 * of hooks and B. This is deliberately a state-only coordinator: when the
 * deadline is reached it rotates the native receipt fence and leaves the task
 * waiting for a real callback from the original A. It does not start B/C
 * until that binding evidence exists.
 */
function reconcileRecoveryTickUnlocked(statePath: string, now: number): { changed: boolean; waitingNative: boolean; nextRetryAt: string | null } {
  if (!existsSync(statePath)) return { changed: false, waitingNative: false, nextRetryAt: null };
  let state = readFileSync(statePath, 'utf8');
  let parsed: MainSessionState;
  try { parsed = JSON.parse(state) as MainSessionState; } catch { return { changed: false, waitingNative: false, nextRetryAt: null }; }
  if (!parsed.recovery_plan || parsed.status === 'DONE' || parsed.status === 'PAUSED' || parsed.recovery_plan.status === 'cancelled') return { changed: false, waitingNative: false, nextRetryAt: parsed.recovery_plan?.next_retry_at ?? null };
  const plan = parsed.recovery_plan;
  const owner = plan.owner;
  if (owner) {
    try { process.kill(owner.pid, 0); return { changed: false, waitingNative: false, nextRetryAt: plan.next_retry_at }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return { changed: false, waitingNative: false, nextRetryAt: plan.next_retry_at }; }
  }
  const changed = reconcileStaleOwner(parsed, now);
  const current = parsed.recovery_plan;
  if (!current || current.status === 'cancelled' || (parsed as MainSessionState).status === 'DONE' || (parsed as MainSessionState).status === 'PAUSED') return { changed, waitingNative: false, nextRetryAt: null };
  if (current.next_retry_at && Date.parse(current.next_retry_at) <= now && parsed.binding.status === 'BOUND' && parsed.main_session_id) {
    const generation = randomUUID();
    const armedAt = new Date(now).toISOString();
    parsed.run_generation = generation;
    parsed.input_epoch = (parsed.input_epoch ?? 0) + 1;
    parsed.pending_action = null;
    delete parsed.direction_context;
    delete parsed.last_stop;
    parsed.tool_starts = {};
    parsed.continuation_confirmed = false;
    parsed.phase = 'RECOVERING';
    parsed.host.hook_effective = false;
    parsed.binding = {
      ...parsed.binding,
      status: 'PENDING_NATIVE_HOOK', tool_use_id: null, bound_at: null,
      challenge: randomUUID(), operation: 'rebind',
      expected_main_session_id: parsed.main_session_id,
      expected_workspace: resolve(parsed.task.workspace), expected_task_version: parsed.task_version,
      expected_run_generation: generation, armed_at: armedAt,
    };
    if (parsed.controller) parsed.controller = { ...parsed.controller, lifecycle: 'exited' };
    parsed.recovery_condition = { kind: 'native_rebind', message: current.reason.message, resume_when: 'A real native receipt from the original A must be correlated before B/C can restart.' };
    current.owner = null;
    current.generation = generation;
    current.next_retry_at = null;
    current.status = 'waiting_native';
    current.reason = parsed.recovery_condition;
    current.cancellation_boundary = null;
    current.attempt = Math.max(current.attempt, 1);
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    // Atomic replacement is enough here: the detached loop never holds the
    // controller lock, and a fresh tick will retry if another writer wins.
    renameSync(temporary, statePath);
    return { changed: true, waitingNative: true, nextRetryAt: null };
  }
  if (changed) {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    renameSync(temporary, statePath);
  }
  return { changed, waitingNative: current.status === 'waiting_native', nextRetryAt: current.next_retry_at };
}

/** Cross-process CAS boundary for detached coordinators. */
export function reconcileRecoveryTick(statePath: string, now = Date.now()): { changed: boolean; waitingNative: boolean; nextRetryAt: string | null } {
  const lock = `${statePath}.recovery-tick.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { changed: false, waitingNative: false, nextRetryAt: null }; throw error; }
  try { return reconcileRecoveryTickUnlocked(statePath, now); }
  finally { closeSync(fd); try { unlinkSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
