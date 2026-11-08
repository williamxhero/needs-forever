import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { nextBackoff } from './recovery.js';
const DELAYS = [5, 15, 60, 300];
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
    const generation = state.run_generation ?? previous?.generation ?? randomUUID();
    if (previous?.cancellation_boundary && previous.generation === generation)
        return previous;
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
    const generation = state.run_generation ?? state.recovery_plan?.generation ?? randomUUID();
    const previous = state.recovery_plan;
    if (previous?.cancellation_boundary && previous.generation === generation)
        return previous;
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
    return !!current && !current.cancellation_boundary && current.generation === plan.generation && current.task_version === plan.task_version && (!state.run_generation || state.run_generation === plan.generation) && state.status !== 'DONE' && state.status !== 'PAUSED';
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
 * shutdown handler.  This is intentionally a state-only operation: it never
 * fabricates a native receipt or starts B/C.  The next real original-A
 * receipt remains the only path that can bind a fresh controller.
 */
export function reconcileStaleOwner(state, now = Date.now()) {
    const plan = state.recovery_plan;
    if (!plan || plan.status === 'cancelled' || plan.cancellation_boundary || state.status === 'PAUSED' || state.status === 'DONE')
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
    state.binding = { ...state.binding, status: 'PENDING_NATIVE_HOOK', tool_use_id: null, operation: 'resume' };
    state.phase = 'RECOVERING';
    state.host.hook_effective = false;
    state.last_error = 'Recovery owner exited unexpectedly; waiting for a fresh native receipt from the original A.';
    state.recovery_condition = { kind: 'controller_exit', message: state.last_error, resume_when: 'A real native receipt from the original A must be correlated before B/C can restart.' };
    armRecovery(state, state.recovery_condition, now);
    return true;
}
