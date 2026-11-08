import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, openSync, closeSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { reachedLimits } from './rules.js';
import { Store } from './store.js';
import { record, text } from './types.js';
import { createRecoveryPlan, waitForNativeReceipt } from './recovery-coordinator.js';
export function readJson(path) {
    // Windows can briefly deny a read while the state checkpoint is being
    // atomically replaced by another owner. Keep the previous checkpoint
    // intact and retry transient sharing errors instead of turning a completed
    // judgment into an unknown recovery state.
    const deadline = Date.now() + 5_000;
    while (true) {
        try {
            return JSON.parse(readFileSync(path, 'utf8'));
        }
        catch (error) {
            const code = error.code;
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() >= deadline)
                throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 40));
        }
    }
}
export function atomicJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
}
export function canonicalPath(path) {
    const result = realpathSync(path);
    return process.platform === 'win32' ? result.toLowerCase() : result;
}
export function contractHash(task) { return createHash('sha256').update(JSON.stringify(task)).digest('hex'); }
/**
 * Re-arm the native binding after a recoverable controller/host invalidation.
 * The original A identity and contract remain fixed; only the generation and
 * challenge rotate. Callers must persist this state before accepting any new
 * lifecycle receipt.
 */
export function armNativeRebind(state, reason) {
    if (state.status === 'DONE' || state.pause_reason)
        return;
    if (!state.main_session_id)
        throw new Error('Cannot rebind a main session before the original A is bound.');
    const now = new Date().toISOString();
    const generation = randomUUID();
    state.run_generation = generation;
    state.input_epoch = (state.input_epoch ?? 0) + 1;
    state.pending_action = null;
    delete state.direction_context;
    delete state.last_stop;
    state.tool_starts = {};
    state.continuation_confirmed = false;
    state.phase = 'RECOVERING';
    state.last_error = reason;
    state.host.hook_effective = false;
    state.binding = {
        ...state.binding,
        status: 'PENDING_NATIVE_HOOK',
        tool_use_id: null,
        bound_at: null,
        challenge: randomUUID(),
        operation: 'rebind',
        expected_main_session_id: state.main_session_id,
        expected_workspace: canonicalPath(state.task.workspace),
        expected_task_version: state.task_version,
        expected_run_generation: generation,
        armed_at: now,
    };
    state.recovery_condition = {
        kind: 'native_rebind',
        message: reason,
        resume_when: 'Wait for a trusted lifecycle callback from the original main session; B and C remain stopped until its receipt is accepted.',
    };
    waitForNativeReceipt(state, state.recovery_condition);
}
export function indexPath(workspace) { return resolve(workspace, '.codex-supervisor', 'main-session-index.json'); }
export function mainLeasePath(session) { return resolve(tmpdir(), 'codex-supervisor-locks', `main-session-${createHash('sha256').update(session).digest('hex')}.lock`); }
function registerState(workspace, statePath) {
    // One immutable identity slot per checkpoint avoids a workspace-wide RMW
    // lock, including a lock left behind by a crash during registration.
    const key = createHash('sha256').update(resolve(statePath)).digest('hex');
    atomicJson(resolve(workspace, '.codex-supervisor', 'main-session-bindings', `${key}.json`), { schema_version: 1, state_path: statePath });
}
export function registeredStatePaths(workspace) {
    const old = indexPath(workspace);
    const directory = resolve(workspace, '.codex-supervisor', 'main-session-bindings');
    const entries = existsSync(old) ? readJson(old).states : [];
    if (existsSync(directory))
        for (const name of readdirSync(directory)) {
            if (/^[a-f0-9]{64}\.json$/.test(name))
                entries.push(readJson(resolve(directory, name)).state_path);
        }
    return [...new Set(entries)];
}
export function validateTask(input) {
    const task = record(input);
    if (task.schema_version !== 1)
        throw new Error('schema_version must be 1.');
    const taskId = text(task.task_id, 'task_id');
    if (!/^[\w.-]+$/.test(taskId) || ['.', '..'].includes(taskId))
        throw new Error('Invalid task_id.');
    const workspace = text(task.workspace, 'workspace');
    if (!isAbsolute(workspace) || !statSync(workspace).isDirectory())
        throw new Error('workspace must be an existing absolute directory.');
    if (!Array.isArray(task.acceptance) || !task.acceptance.length)
        throw new Error('acceptance must be nonempty.');
    const acceptance = task.acceptance.map((entry) => { const item = record(entry); return { id: text(item.id, 'acceptance.id'), text: text(item.text, 'acceptance.text') }; });
    if (new Set(acceptance.map((entry) => entry.id)).size !== acceptance.length)
        throw new Error('acceptance ids must be unique.');
    const limits = record(task.limits ?? {});
    for (const name of ['max_worker_turns', 'max_minutes']) {
        if (limits[name] != null && (typeof limits[name] !== 'number' || !Number.isFinite(limits[name]) || limits[name] <= 0 || (name === 'max_worker_turns' && !Number.isInteger(limits[name]))))
            throw new Error(`Invalid ${name}.`);
    }
    const result = { schema_version: 1, task_id: taskId, workspace: resolve(workspace), goal: text(task.goal, 'goal'), acceptance, authorization: text(task.authorization, 'authorization'), limits: { max_worker_turns: limits.max_worker_turns ?? null, max_minutes: limits.max_minutes ?? null } };
    if (task.verify !== undefined) {
        const verify = record(task.verify);
        if (!Array.isArray(verify.argv) || !verify.argv.length || !verify.argv.every((entry) => typeof entry === 'string' && entry.length))
            throw new Error('Invalid verify.argv.');
        if (typeof verify.timeout_seconds !== 'number' || !Number.isFinite(verify.timeout_seconds) || verify.timeout_seconds <= 0)
            throw new Error('Invalid verify.timeout_seconds.');
        if (!Array.isArray(verify.protected_files) || !verify.protected_files.every((entry) => typeof entry === 'string' && entry.length))
            throw new Error('Invalid verify.protected_files.');
        result.verify = { argv: verify.argv, timeout_seconds: verify.timeout_seconds, protected_files: verify.protected_files };
    }
    return result;
}
function validatedTask(path) { return validateTask(readJson(path)); }
export function prepareMainSession(taskPath, statePath, simulated = false) {
    if (existsSync(statePath))
        throw new Error('Task state already exists; use explicit resume.');
    const task = validatedTask(taskPath);
    if (canonicalPath(process.cwd()) !== canonicalPath(task.workspace))
        throw new Error('Preparation cwd must match the task workspace.');
    const store = new Store(statePath);
    store.lock(task);
    try {
        const state = {
            schema_version: 1, task_id: task.task_id, task_version: 1, task,
            control_mode: 'main-session', main_session_id: null, run_generation: randomUUID(), contract_sha256: contractHash(task),
            binding: { status: 'PENDING_NATIVE_HOOK', tool_use_id: null, bound_at: null, challenge: randomUUID(), task_path: resolve(taskPath) },
            host: { desktop_version: null, cli_version: null, hook_effective: false, source: simulated ? 'simulated' : 'unverified', reason: 'Awaiting a correlated native Desktop hook. Review the installed plugin hooks in Settings > Hooks if necessary.' },
            worker_thread_id: null, status: 'PAUSED', phase: 'RECOVERING', active_worker_turn_id: null, reviewing_turn_id: null,
            handled_turn_ids: [], pending_action: null, retry: { kind: null, attempt: 0, next_at: null }, last_decision: null,
            worker_turn_count: 0, elapsed_active_seconds: 0, updated_at: new Date().toISOString(), codex_version: null, mode: simulated ? 'simulated' : 'live',
            recovery_condition: { kind: 'native_hook_required', message: 'Awaiting a correlated native Desktop hook; supervision is not active.', resume_when: 'Review/trust the plugin hooks and run preparation from the intended main session.' },
        };
        state.recovery_plan = createRecoveryPlan(state, state.recovery_condition, true);
        store.protect(state);
        store.save(state);
        registerState(task.workspace, statePath);
        store.event(state, 'main_session_prepared', { control_mode: state.control_mode, binding_status: state.binding.status });
        return state;
    }
    finally {
        store.release();
    }
}
export function resumeMainSession(statePath, taskPath, simulated = false) {
    let state = readJson(statePath);
    if (state.control_mode !== 'main-session' || (!state.main_session_id && state.binding.status !== 'PENDING_NATIVE_HOOK') || state.status === 'DONE')
        throw new Error('Explicit resume requires an unfinished main-session checkpoint.');
    const store = new Store(statePath);
    store.lock(state.task, true);
    try {
        state = readJson(statePath);
        if (state.control_mode !== 'main-session' || state.status === 'DONE')
            throw new Error('Checkpoint changed before the resume lock was acquired.');
        if (state.controller) {
            try {
                process.kill(state.controller.pid, 0);
                throw new Error('Controller is still alive; pause it and wait for its owned exit before resume.');
            }
            catch (error) {
                if (error.code !== 'ESRCH')
                    throw error;
            }
        }
        const task = taskPath ? validatedTask(taskPath) : validateTask(state.task);
        if (task.task_id !== state.task_id || canonicalPath(task.workspace) !== canonicalPath(state.task.workspace) || canonicalPath(process.cwd()) !== canonicalPath(task.workspace))
            throw new Error('Resume must preserve task and workspace identity.');
        if ((state.mode === 'simulated') !== simulated)
            throw new Error('Resume must preserve live/simulated mode.');
        if (state.status !== 'PAUSED' && (task.goal !== state.task.goal || task.authorization !== state.task.authorization))
            throw new Error('Changing goal or authorization requires durable PAUSED first.');
        if (JSON.stringify(task.verify) !== JSON.stringify(state.task.verify))
            throw new Error('The original independent verifier and protected baseline are fixed for this task.');
        const limits = reachedLimits(task.limits, state);
        if (limits.turns || limits.time)
            throw new Error('Cumulative user_limit reached; explicitly raise/remove limits before resume.');
        const leasePath = state.main_session_id ? mainLeasePath(state.main_session_id) : null;
        if (leasePath && existsSync(leasePath)) {
            const guard = `${leasePath}.reclaim`;
            const fd = openSync(guard, 'wx');
            try {
                const owner = readJson(leasePath);
                if (owner.state_path !== statePath || owner.main_session_id !== state.main_session_id || owner.controller_id !== state.controller?.id || !Number.isInteger(owner.pid) || owner.pid <= 0)
                    throw new Error('Main-session lease identity is ambiguous; cannot reclaim.');
                try {
                    process.kill(owner.pid, 0);
                    throw new Error('Main-session lease owner is still alive.');
                }
                catch (error) {
                    if (error.code !== 'ESRCH')
                        throw error;
                }
                unlinkSync(leasePath);
            }
            finally {
                closeSync(fd);
                unlinkSync(guard);
            }
        }
        state.recovery_history = [...(state.recovery_history ?? []), { at: new Date().toISOString(), run_generation: state.run_generation, controller: state.controller, stop_transport: state.stop_transport, pending_action: state.pending_action }];
        state.task = task;
        state.task_version++;
        state.contract_sha256 = contractHash(task);
        state.run_generation = randomUUID();
        delete state.controller;
        delete state.last_stop;
        delete state.stop_transport;
        delete state.direction_context;
        delete state.active_checkpoint_at;
        state.pending_action = null;
        state.tool_starts = {};
        state.continuation_confirmed = false;
        state.input_epoch = (state.input_epoch ?? 0) + 1;
        state.status = 'PAUSED';
        state.phase = 'RECOVERING';
        delete state.pause_reason;
        state.binding = { ...state.binding, status: 'PENDING_NATIVE_HOOK', challenge: randomUUID(), tool_use_id: null, operation: 'resume' };
        state.host.hook_effective = false;
        state.host.reason = 'Explicit resume awaits a fresh native receipt from the original main session.';
        state.recovery_condition = { kind: 'resume_native_receipt', message: state.host.reason, resume_when: 'Complete resume in the original A, then wait for a new native Stop. Old directions are never replayed.' };
        state.recovery_plan = createRecoveryPlan(state, state.recovery_condition, true);
        store.save(state);
        store.event(state, 'main_session_resume_prepared', { main_session_id: state.main_session_id, run_generation: state.run_generation });
        registerState(task.workspace, statePath);
        return state;
    }
    finally {
        store.release();
    }
}
export function mainSessionStatus(path) {
    const state = readJson(path);
    return { ...state, control_mode: state.control_mode ?? 'independent-worker', live: false, recovery_required: state.status === 'ACTIVE' || state.binding?.status === 'PENDING_NATIVE_HOOK' };
}
