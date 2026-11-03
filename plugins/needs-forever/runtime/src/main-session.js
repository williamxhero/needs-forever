import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Store } from './store.js';
import { record, text } from './types.js';
export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
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
export function indexPath(workspace) { return resolve(workspace, '.codex-supervisor', 'main-session-index.json'); }
function validatedTask(path) {
    const task = record(readJson(path));
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
        store.protect(state);
        store.save(state);
        const path = indexPath(task.workspace);
        const entries = existsSync(path) ? readJson(path).states : [];
        atomicJson(path, { schema_version: 1, states: [...new Set([...entries, statePath])] });
        store.event(state, 'main_session_prepared', { control_mode: state.control_mode, binding_status: state.binding.status });
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
