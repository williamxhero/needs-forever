import { randomUUID } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { codexCommand, connect } from './transport.js';
import { readJson } from './main-session.js';
import { Store } from './store.js';
import { routeCorrelation } from './route-execution.js';
function promptDelayMs(fixturePath) {
    const value = Number(fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')).recovery_prompt_delay_ms : process.env.NF_RECOVERY_PROMPT_DELAY_MS ?? 3_000);
    return Number.isFinite(value) && value >= 0 ? value : 3_000;
}
/** Schedule an auditable prompt to the original A when native binding was
 * invalidated. The prompt only triggers A's native UserPromptSubmit receipt;
 * it never changes the task contract or fabricates a binding. */
export function scheduleNativeRebindPrompt(path, pluginRoot, fixturePath, state, reason) {
    if (state.control_mode !== 'main-session' || !state.main_session_id || state.status !== 'ACTIVE' || state.binding.status !== 'PENDING_NATIVE_HOOK' || state.binding.operation !== 'rebind')
        return false;
    const existing = state.recovery_prompt;
    if (existing?.kind === 'native_rebind' && existing.run_generation === state.run_generation)
        return false;
    const deliveryId = randomUUID();
    const delayMs = promptDelayMs(fixturePath);
    const message = `NF 自动恢复绑定：原始 A 的监督绑定已失效。请继续当前任务，保持原目标和授权，不要重复旧方向；这条消息用于重新建立本机监督绑定。\n\n原因为：${reason}`;
    state.recovery_prompt = { kind: 'native_rebind', delivery_id: deliveryId, source_turn_id: state.recovery_parent?.turn_id ?? null, task_version: state.task_version, run_generation: state.run_generation, message, due_at: new Date(Date.now() + delayMs).toISOString() };
    const store = new Store(path);
    store.save(state);
    store.event(state, 'main_session_recovery_prompt_scheduled', { kind: 'native_rebind', delivery_id: deliveryId, main_session_id: state.main_session_id, due_at: state.recovery_prompt.due_at, reason: 'NF 自动推动原始 A 产生新的 native lifecycle receipt。', ...(state.recovery_parent?.stop_attempt_id ? { stop_attempt_id: state.recovery_parent.stop_attempt_id } : {}), ...(state.recovery_parent?.turn_id ? { turn_id: state.recovery_parent.turn_id } : {}) });
    const script = resolve(pluginRoot, 'scripts/recovery-prompt.mjs');
    const child = spawn(process.execPath, [script, path, ...(fixturePath ? ['--test-fixture', fixturePath] : [])], { cwd: state.task.workspace, detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    return true;
}
function fixtureCommand(fixturePath) {
    if (!fixturePath)
        return codexCommand();
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    if (!Array.isArray(fixture.app_server_argv) || !fixture.app_server_argv.length || !fixture.app_server_argv.every((value) => typeof value === 'string' && value.length)) {
        throw new Error('Recovery prompt fixture is missing app_server_argv.');
    }
    return fixture.app_server_argv;
}
function eventPath(statePath) { return resolve(resolve(statePath, '..'), 'events.jsonl'); }
function hasDeliveryEvent(statePath, deliveryId, types) {
    if (!existsSync(eventPath(statePath)))
        return false;
    return readFileSync(eventPath(statePath), 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
        try {
            const event = JSON.parse(line);
            return types.has(String(event.type ?? '')) && event.delivery_id === deliveryId;
        }
        catch {
            return false;
        }
    });
}
function acquireLease(statePath) {
    const path = `${statePath}.recovery-prompt.lock`;
    let fd;
    try {
        fd = openSync(path, 'wx', 0o600);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        try {
            const owner = JSON.parse(readFileSync(path, 'utf8'));
            if (Number.isInteger(owner.pid)) {
                try {
                    process.kill(owner.pid, 0);
                    return null;
                }
                catch (probe) {
                    if (probe.code !== 'ESRCH')
                        return null;
                }
            }
            unlinkSync(path);
            fd = openSync(path, 'wx', 0o600);
        }
        catch {
            return null;
        }
    }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, state_path: statePath, at: new Date().toISOString() }));
    closeSync(fd);
    let released = false;
    return { release: () => { if (released)
            return; released = true; try {
            unlinkSync(path);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        } } };
}
function currentPrompt(statePath) {
    try {
        const state = readJson(statePath);
        const prompt = state.recovery_prompt;
        if (!prompt || state.status !== 'ACTIVE' || state.control_mode !== 'main-session' || !state.main_session_id)
            return null;
        if (state.task_version !== prompt.task_version || state.run_generation !== prompt.run_generation)
            return null;
        if (prompt.kind !== 'native_rebind' && (!state.pending_action || state.pending_action.delivery_id !== prompt.delivery_id || state.pending_action.message !== prompt.message || state.pending_action.plan_id !== prompt.plan_id || state.pending_action.route_id !== prompt.route_id || state.pending_action.source_stop_attempt_id !== prompt.source_stop_attempt_id || state.pending_action.stage === 'confirmed' || state.continuation_confirmed))
            return null;
        if (prompt.kind === 'native_rebind' && (state.binding.status !== 'PENDING_NATIVE_HOOK' || state.binding.operation !== 'rebind'))
            return null;
        return { state, prompt };
    }
    catch {
        return null;
    }
}
function log(statePath, state, type, details = {}) {
    const parent = state.last_stop ?? state.recovery_parent;
    const prompt = state.recovery_prompt;
    const stopId = prompt?.source_stop_attempt_id ?? parent?.stop_attempt_id;
    const turnId = prompt?.source_turn_id ?? parent?.turn_id;
    new Store(statePath).event(state, type, { role: 'worker', source: 'nf', transport: 'codex-app-server', ...routeCorrelation(prompt), ...(stopId ? { stop_attempt_id: stopId } : {}), ...(turnId ? { turn_id: turnId } : {}), ...details });
}
function matchingClientId(turns, deliveryId) {
    for (const value of turns) {
        if (!value || typeof value !== 'object')
            continue;
        const turn = value;
        for (const item of turn.items ?? []) {
            if (!item || typeof item !== 'object')
                continue;
            const candidate = item;
            if (candidate.type === 'userMessage' && candidate.clientId === deliveryId)
                return typeof turn.id === 'string' ? turn.id : null;
        }
    }
    return null;
}
/**
 * Push a supervisor direction to the original A when the native Stop response
 * did not produce any matching A activity. This is a normal NF recovery
 * action, persisted as its own audit events and fenced by the same generation
 * and delivery id as the original Stop decision.
 */
export async function deliverMainSessionRecoveryPrompt(statePath, fixturePath) {
    const initial = currentPrompt(statePath);
    if (!initial)
        return;
    const dueAt = Date.parse(initial.prompt.due_at);
    if (Number.isFinite(dueAt) && dueAt > Date.now())
        await delay(dueAt - Date.now());
    const current = currentPrompt(statePath);
    if (!current)
        return;
    const lease = acquireLease(statePath);
    if (!lease)
        return;
    const { state, prompt } = current;
    try {
        if (hasDeliveryEvent(statePath, prompt.delivery_id, new Set(['main_session_recovery_prompt_sent', 'main_session_recovery_prompt_acknowledged'])))
            return;
        log(statePath, state, 'main_session_recovery_prompt_attempted', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, message: prompt.message, task_version: prompt.task_version, run_generation: prompt.run_generation });
        const connection = await connect(fixtureCommand(fixturePath), state.task.workspace);
        try {
            const resumed = await connection.rpc.request('thread/resume', { threadId: state.main_session_id, cwd: state.task.workspace, approvalPolicy: 'never', sandbox: 'workspace-write', excludeTurns: false });
            if (!resumed?.thread || resumed.thread.id !== state.main_session_id)
                throw new Error('Recovery adapter resumed a different thread; no prompt was sent.');
            const turns = Array.isArray(resumed.thread.turns) ? resumed.thread.turns : [];
            const existing = matchingClientId(turns, prompt.delivery_id);
            if (existing) {
                log(statePath, state, 'main_session_recovery_prompt_acknowledged', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, target_turn_id: existing, reconciled: true });
                return;
            }
            if (turns.some((turn) => turn?.status === 'inProgress')) {
                log(statePath, state, 'main_session_recovery_prompt_deferred', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, reason: 'Original A already has an in-progress turn.' });
                return;
            }
            const latest = currentPrompt(statePath);
            if (!latest || latest.prompt.delivery_id !== prompt.delivery_id || latest.prompt.message !== prompt.message)
                return;
            log(statePath, state, 'main_session_recovery_prompt_sent', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, message: prompt.message });
            const response = await connection.rpc.request('turn/start', { threadId: state.main_session_id, clientUserMessageId: prompt.delivery_id, input: [{ type: 'text', text: prompt.message, text_elements: [] }] });
            const targetTurnId = typeof response?.turn?.id === 'string' ? response.turn.id : null;
            log(statePath, state, 'main_session_recovery_prompt_acknowledged', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, target_turn_id: targetTurnId, reconciled: false });
        }
        finally {
            await connection.rpc.close();
        }
    }
    catch (error) {
        log(statePath, state, 'main_session_recovery_prompt_failed', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, error: error instanceof Error ? error.message : String(error) });
    }
    finally {
        lease.release();
    }
}
