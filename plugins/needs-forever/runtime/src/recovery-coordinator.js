import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { nextBackoff } from './recovery.js';
import { Store } from './store.js';
const DELAYS = [5, 15, 60, 300];
export const RECOVERY_TIMEOUT_MS = 120_000;
/** Active-writer evidence is a bounded extension, not an unbounded keepalive. */
export const ACTIVE_WRITER_RECOVERY_MAX_MS = 10 * 60_000;
export const ACTIVE_WRITER_RECOVERY_EXTENSION_MS = 60_000;
/** One window per recovery episode, independent of retry/generation changes. */
function ensureRecoveryWindow(state, now) {
    if (state.recovery_window)
        return;
    const binding = state.binding;
    const armed = state.phase === 'RECOVERING' && binding?.status === 'PENDING_NATIVE_HOOK' ? Date.parse(binding.armed_at ?? '') : NaN;
    const started = Number.isFinite(armed) ? Math.min(armed, now) : now;
    state.recovery_window = { started_at: new Date(started).toISOString(), deadline_at: new Date(started + RECOVERY_TIMEOUT_MS).toISOString() };
}
export function resetRecoveryWindow(state, now = Date.now()) {
    delete state.recovery_interruption;
    state.recovery_window = { started_at: new Date(now).toISOString(), deadline_at: new Date(now + RECOVERY_TIMEOUT_MS).toISOString() };
}
/**
 * Extend a recovery episode only after a real active-writer observation.
 * The first observation starts a separate ten-minute budget; each call may
 * move the deadline by one bounded step, never beyond that budget.  Callers
 * must persist the state and append the returned change as an audit event.
 */
export function extendRecoveryWindowForActiveWriter(state, now = Date.now(), extensionMs = ACTIVE_WRITER_RECOVERY_EXTENSION_MS) {
    if (state.status === 'DONE' || state.status === 'PAUSED' || state.status === 'INTERRUPTED')
        return null;
    // Older checkpoints may have scheduled a prompt before the recovery window
    // was introduced.  A real active-writer receipt is enough to establish a
    // fresh bounded window; ordinary transport errors never call this helper.
    if (!state.recovery_window)
        ensureRecoveryWindow(state, now);
    const window = state.recovery_window;
    if (!window)
        return null;
    const currentDeadline = Date.parse(window.deadline_at);
    if (!Number.isFinite(currentDeadline))
        return null;
    const existingStarted = Date.parse(window.active_writer_started_at ?? '');
    const startedAt = Number.isFinite(existingStarted) ? existingStarted : now;
    const maxDeadline = Number.isFinite(Date.parse(window.active_writer_max_deadline_at ?? ''))
        ? Date.parse(window.active_writer_max_deadline_at)
        : startedAt + ACTIVE_WRITER_RECOVERY_MAX_MS;
    const previous = window.deadline_at;
    const boundedStep = Math.max(ACTIVE_WRITER_RECOVERY_EXTENSION_MS, Math.min(extensionMs, ACTIVE_WRITER_RECOVERY_EXTENSION_MS));
    const nextDeadline = Math.min(Math.max(currentDeadline, now) + boundedStep, maxDeadline);
    window.active_writer_started_at = new Date(startedAt).toISOString();
    window.active_writer_max_deadline_at = new Date(maxDeadline).toISOString();
    if (nextDeadline > currentDeadline) {
        window.deadline_at = new Date(nextDeadline).toISOString();
        return {
            extended: true,
            capped: nextDeadline >= maxDeadline,
            previous_deadline_at: previous,
            deadline_at: window.deadline_at,
            active_writer_started_at: window.active_writer_started_at,
            active_writer_max_deadline_at: window.active_writer_max_deadline_at,
        };
    }
    const capped = maxDeadline <= currentDeadline;
    if (capped && !window.active_writer_capped_at)
        window.active_writer_capped_at = new Date(now).toISOString();
    return {
        extended: false,
        capped,
        previous_deadline_at: previous,
        deadline_at: window.deadline_at,
        active_writer_started_at: window.active_writer_started_at,
        active_writer_max_deadline_at: window.active_writer_max_deadline_at,
    };
}
export function interruptRecovery(state, now, explicitReason) {
    const cause = state.recovery_condition?.message ?? state.recovery_plan?.reason.message ?? state.last_error ?? '';
    const reason = explicitReason ?? `自动恢复超过 2 分钟仍未成功，监督已中断。${cause ? `最后原因：${cause}` : ''}可点击“恢复”重新尝试。`;
    state.status = 'INTERRUPTED';
    state.phase = 'IDLE';
    state.recovery_interruption = { at: new Date(now).toISOString(), reason };
    state.recovery_condition = { kind: explicitReason ? 'recovery_unavailable' : 'recovery_timeout', message: reason, resume_when: 'Explicit manual resume starts a new recovery window.' };
    state.last_error = reason;
    state.input_epoch = (state.input_epoch ?? 0) + 1;
    state.pending_action = null;
    state.retry = { kind: null, attempt: 0, next_at: null };
    delete state.recovery_prompt;
    delete state.direction_context;
    delete state.route_execution;
    state.continuation_confirmed = false;
    if (state.binding)
        state.binding.status = 'RELEASED';
    if (state.host)
        state.host.hook_effective = false;
    cancelRecovery(state, 'interrupted', now);
}
function leasePath(statePath) {
    const identity = createHash('sha256').update(resolve(statePath)).digest('hex');
    return resolve(tmpdir(), 'codex-supervisor-locks', `recovery-${identity}.lock`);
}
/** Return a fresh plan for a newly prepared task. */
export function createRecoveryPlan(state, reason, waitingNative = false) {
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
export function armRecovery(state, reason, now = Date.now()) {
    const previous = state.recovery_plan;
    if (state.status === 'INTERRUPTED')
        throw new Error('Supervision interrupted; explicit resume is required.');
    const generation = state.run_generation ?? previous?.generation ?? randomUUID();
    if (previous?.cancellation_boundary && previous.generation === generation)
        return previous;
    ensureRecoveryWindow(state, now);
    const attempt = previous?.generation === generation ? previous.attempt + 1 : 1;
    const backoff = nextBackoff(attempt, now, DELAYS);
    const plan = {
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
export function waitForNativeReceipt(state, reason) {
    if (state.status === 'INTERRUPTED')
        throw new Error('Supervision interrupted; explicit resume is required.');
    const generation = state.run_generation ?? state.recovery_plan?.generation ?? randomUUID();
    const previous = state.recovery_plan;
    if (previous?.cancellation_boundary && previous.generation === generation)
        return previous;
    ensureRecoveryWindow(state, Date.now());
    const plan = {
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
export function markRecoveryRunning(state, owner) {
    const current = state.recovery_plan;
    if (!current || current.cancellation_boundary || current.task_version !== state.task_version || (state.run_generation && current.generation !== state.run_generation))
        throw new Error('Stale recovery generation cannot become running.');
    current.owner = owner;
    current.status = 'running';
    current.next_retry_at = null;
    return current;
}
/** Persist an explicit cancellation boundary.  It remains in state so an old
 * timer or controller can prove that its result is stale after a restart.
 */
export function cancelRecovery(state, kind, now = Date.now()) {
    const current = state.recovery_plan ?? createRecoveryPlan(state, { kind: 'none', message: '', resume_when: '' });
    current.owner = null;
    current.status = 'cancelled';
    current.next_retry_at = null;
    current.cancellation_boundary = { kind, at: new Date(now).toISOString(), generation: current.generation };
    state.recovery_plan = current;
    return current;
}
export function recoveryCurrent(state, plan) {
    const current = state.recovery_plan;
    return !!current && !current.cancellation_boundary && current.generation === plan.generation && current.task_version === plan.task_version && (!state.run_generation || state.run_generation === plan.generation) && state.status !== 'DONE' && state.status !== 'PAUSED' && state.status !== 'INTERRUPTED';
}
/** Claim the cross-process watchdog lease.  The lease payload carries the
 * generation and task version, so an old process cannot reclaim a newer plan.
 */
export function acquireRecoveryOwner(statePath, state) {
    const plan = state.recovery_plan;
    if (!plan || plan.status === 'cancelled' || plan.cancellation_boundary || plan.task_version !== state.task_version || plan.generation !== state.run_generation)
        throw new Error('Recovery plan is cancelled or stale.');
    const path = leasePath(statePath);
    const id = randomUUID();
    let fd;
    try {
        fd = openSync(path, 'wx', 0o600);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        let existing;
        try {
            existing = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            throw new Error('Recovery owner lease is unreadable; refusing to replace it.');
        }
        if (existing.state_path !== resolve(statePath) || !Number.isInteger(existing.pid) || existing.pid <= 0)
            throw new Error('Recovery owner lease identity is ambiguous; refusing to replace it.');
        try {
            process.kill(existing.pid, 0);
            throw new Error('Recovery owner is still alive.');
        }
        catch (probe) {
            if (probe.code !== 'ESRCH')
                throw probe;
        }
        unlinkSync(path);
        fd = openSync(path, 'wx', 0o600);
    }
    const heartbeat = new Date().toISOString();
    const owner = { id, pid: process.pid, lease_path: path, task_version: state.task_version, generation: state.run_generation, heartbeat_at: heartbeat };
    writeFileSync(fd, JSON.stringify({ ...owner, state_path: resolve(statePath) }));
    closeSync(fd);
    let released = false;
    return { owner, release: () => { if (released)
            return; released = true; try {
            const saved = JSON.parse(readFileSync(path, 'utf8'));
            if (saved.id === id)
                unlinkSync(path);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        } } };
}
export function recoveryLeasePath(statePath) { return leasePath(statePath); }
/** Reconcile a controller/watchdog that disappeared without running its
 * shutdown handler.  Binding recovery remains fenced by the original-A
 * lifecycle receipt; ordinary NF recovery prompts are recorded separately by
 * the provider adapter and never substitute for that binding evidence.
 */
export function reconcileStaleOwner(state, now = Date.now()) {
    const plan = state.recovery_plan;
    if (!plan || plan.status === 'cancelled' || plan.cancellation_boundary || state.status === 'PAUSED' || state.status === 'DONE' || state.status === 'INTERRUPTED')
        return false;
    const owner = plan.owner;
    if (!owner)
        return false;
    let alive = false;
    try {
        process.kill(owner.pid, 0);
        alive = true;
    }
    catch (error) {
        if (error.code !== 'ESRCH')
            return false;
    }
    if (alive)
        return false;
    if (owner.generation !== plan.generation || owner.task_version !== plan.task_version || owner.generation !== state.run_generation || owner.task_version !== state.task_version)
        return false;
    if (state.controller)
        state.controller = { ...state.controller, lifecycle: 'exited' };
    // A dead controller invalidates the old generation.  Arm the same fenced
    // native rebind used by the lifecycle path so the next real A receipt can
    // restart B; leaving operation="resume" here would make lifecycle ignore
    // SessionStart/UserPromptSubmit and strand the task in RECOVERING.
    state.recovery_parent = state.last_stop ? {
        stop_attempt_id: state.last_stop.stop_attempt_id,
        turn_id: state.last_stop.turn_id,
    } : { stop_attempt_id: null, turn_id: null };
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
function reconcileRecoveryTickUnlocked(statePath, now) {
    if (!existsSync(statePath))
        return { changed: false, waitingNative: false, nextRetryAt: null };
    let state = readFileSync(statePath, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(state);
    }
    catch {
        return { changed: false, waitingNative: false, nextRetryAt: null };
    }
    const manuallyPaused = parsed.status === 'PAUSED' && (parsed.phase !== 'RECOVERING' || !!parsed.pause_reason || !parsed.main_session_id);
    if (!parsed.recovery_plan || parsed.status === 'DONE' || manuallyPaused || parsed.status === 'INTERRUPTED' || parsed.recovery_plan.status === 'cancelled')
        return { changed: false, waitingNative: false, nextRetryAt: parsed.recovery_plan?.next_retry_at ?? null };
    if (parsed.phase === 'RECOVERING' || parsed.recovery_plan.status === 'waiting_native' || parsed.recovery_window) {
        const hadWindow = !!parsed.recovery_window;
        ensureRecoveryWindow(parsed, now);
        if (now >= Date.parse(parsed.recovery_window.deadline_at)) {
            interruptRecovery(parsed, now);
            const store = new Store(statePath);
            store.save(parsed);
            store.event(parsed, 'recovery_interrupted', { reason: parsed.recovery_interruption.reason, started_at: parsed.recovery_window.started_at, deadline_at: parsed.recovery_window.deadline_at, interrupted_at: parsed.recovery_interruption.at });
            return { changed: true, waitingNative: false, nextRetryAt: null };
        }
        if (!hadWindow)
            new Store(statePath).save(parsed);
    }
    const plan = parsed.recovery_plan;
    const owner = plan.owner;
    if (owner) {
        try {
            process.kill(owner.pid, 0);
            return { changed: false, waitingNative: false, nextRetryAt: plan.next_retry_at };
        }
        catch (error) {
            if (error.code !== 'ESRCH')
                return { changed: false, waitingNative: false, nextRetryAt: plan.next_retry_at };
        }
    }
    const changed = reconcileStaleOwner(parsed, now);
    const current = parsed.recovery_plan;
    if (!current || current.status === 'cancelled' || parsed.status === 'DONE' || parsed.status === 'PAUSED')
        return { changed, waitingNative: false, nextRetryAt: null };
    if (current.next_retry_at && Date.parse(current.next_retry_at) <= now && parsed.binding.status === 'BOUND' && parsed.main_session_id) {
        parsed.recovery_parent = parsed.last_stop ? {
            stop_attempt_id: parsed.last_stop.stop_attempt_id,
            turn_id: parsed.last_stop.turn_id,
        } : { stop_attempt_id: null, turn_id: null };
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
        if (parsed.controller)
            parsed.controller = { ...parsed.controller, lifecycle: 'exited' };
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
export function reconcileRecoveryTick(statePath, now = Date.now()) {
    const lock = `${statePath}.recovery-tick.lock`;
    let fd;
    try {
        fd = openSync(lock, 'wx', 0o600);
    }
    catch (error) {
        if (error.code === 'EEXIST')
            return { changed: false, waitingNative: false, nextRetryAt: null };
        throw error;
    }
    try {
        return reconcileRecoveryTickUnlocked(statePath, now);
    }
    finally {
        closeSync(fd);
        try {
            unlinkSync(lock);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
}
