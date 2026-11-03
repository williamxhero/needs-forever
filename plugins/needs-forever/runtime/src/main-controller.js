import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalPath, indexPath, readJson } from './main-session.js';
import { handleLifecycle } from './lifecycle.js';
import { Store } from './store.js';
import { redact } from './redact.js';
export function controllerRequest(controller, command, payload = null, timeout = 2_000) {
    return new Promise((done, reject) => {
        const socket = createConnection(controller.endpoint);
        let output = '';
        let settled = false;
        const fail = (error) => { if (settled)
            return; settled = true; socket.destroy(); reject(error); };
        socket.setTimeout(timeout, () => fail(new Error('Controller request deadline elapsed; explicit recovery may be required.')));
        socket.on('error', fail);
        socket.on('connect', () => socket.write(JSON.stringify({ token: controller.token, controller_id: controller.id, run_generation: controller.run_generation, command, payload }) + '\n'));
        socket.on('data', (chunk) => {
            output += chunk;
            if (output.length > 2 * 1024 * 1024)
                return fail(new Error('Oversized controller response.'));
            if (!output.includes('\n'))
                return;
            try {
                const result = JSON.parse(output.split('\n')[0]);
                if (result.error)
                    return fail(new Error(result.error));
                settled = true;
                socket.destroy();
                done(result);
            }
            catch (error) {
                fail(error);
            }
        });
        socket.on('close', () => { if (!settled)
            fail(new Error('Controller disconnected; result is unknown and must not be replayed.')); });
    });
}
export async function controllerStatus(path) {
    const state = readJson(path);
    let live = false;
    if (state.controller?.lifecycle === 'running') {
        try {
            live = (await controllerRequest(state.controller, 'ping')).live === true;
        }
        catch { /* Read-only, never restart. */ }
    }
    return { ...state, control_mode: state.control_mode ?? 'independent-worker', live, continuation_confirmed: state.continuation_confirmed ?? false, recovery_required: (state.status === 'ACTIVE' && !live) || state.phase === 'RECOVERING' };
}
export async function launchController(path, pluginRoot, fixture) {
    const state = readJson(path);
    if (state.controller)
        throw new Error('A controller receipt already exists; use explicit resume, never silently replace it.');
    const script = resolve(pluginRoot, 'scripts/controller.mjs');
    const child = spawn(process.execPath, [script, path, ...(fixture ? ['--test-fixture', fixture] : [])], { cwd: state.task.workspace, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
        await new Promise((done, reject) => {
            const timer = setTimeout(() => { child.unref(); reject(new Error('B startup outcome unknown; inspect state and use explicit recovery.')); }, 10_000);
            child.once('error', (error) => { clearTimeout(timer); reject(error); });
            child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`B exited before readiness (${code}).`)); });
            child.once('message', (message) => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : done(); });
        });
    }
    catch (error) {
        const saved = readJson(path);
        if (!saved.controller) {
            saved.phase = 'RECOVERING';
            saved.last_error = String(redact(error.message));
            saved.recovery_condition = { kind: 'controller_startup', message: saved.last_error, resume_when: 'Resolve the existing ownership or startup failure, then explicitly resume the bound main session.' };
            new Store(path).save(saved);
        }
        throw error;
    }
    child.unref();
}
export function boundStateForEvent(input, pluginRoot, simulated) {
    if (!input || input.agent_id != null || input.agent_type != null || input.agent_transcript_path != null || typeof input.session_id !== 'string' || typeof input.cwd !== 'string')
        return null;
    if (canonicalPath(input.cwd) !== canonicalPath(process.cwd()))
        return null;
    const index = indexPath(input.cwd);
    if (!existsSync(index))
        return null;
    for (const path of readJson(index).states) {
        if (!existsSync(path))
            continue;
        const state = readJson(path);
        if (state.control_mode === 'main-session' && state.binding.status === 'BOUND' && state.main_session_id === input.session_id && (state.mode === 'simulated') === simulated && state.controller && canonicalPath(state.controller.plugin_root) === canonicalPath(pluginRoot))
            return path;
    }
    return null;
}
export async function dispatchBoundLifecycle(path, input) {
    const state = readJson(path);
    if (!state.controller || state.controller.lifecycle !== 'running')
        return {};
    return controllerRequest(state.controller, 'lifecycle', input, 590_000);
}
// #36 connects the fresh readonly judge here. The transport fixture substitutes
// only the external supervisor/host; live tasks cannot obtain a fixture result.
export async function evaluateStop(state, request, fixture, signal) {
    if (state.mode !== 'simulated' || !fixture?.transport?.decision)
        throw new Error('Fresh supervisor adapter is required before this live Stop can be judged.');
    await delay(Number(fixture.transport.delay_ms ?? 0), undefined, { signal });
    const decision = fixture.transport.decision;
    if (decision.action !== 'CONTINUE' || typeof decision.next_message !== 'string' || !decision.next_message.trim())
        throw new Error('Transport fixtures may only request concrete CONTINUE; DONE requires the completion gate.');
    return { decision: 'block', reason: String(redact(decision.next_message)) };
}
export async function runController(path, pluginRoot, fixturePath) {
    const store = new Store(path);
    let state = readJson(path);
    const fixture = fixturePath ? readJson(fixturePath) : null;
    if (state.binding.status !== 'BOUND' || !state.main_session_id || (state.mode === 'simulated') !== Boolean(fixturePath))
        throw new Error('B requires a correlated main-session binding and matching evidence mode.');
    if (state.controller)
        throw new Error('Controller receipt already exists; explicit recovery is required.');
    store.lock(state.task);
    const leasePath = resolve(tmpdir(), 'codex-supervisor-locks', `main-session-${createHash('sha256').update(state.main_session_id).digest('hex')}.lock`);
    let lease;
    let server;
    let closing = false;
    const sockets = new Set();
    const id = randomUUID();
    const controller = { id, pid: process.pid, token: randomUUID(), endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\needs-forever-main-${id}` : resolve(tmpdir(), `nf-main-${id}.sock`), lifecycle: 'running', started_at: new Date().toISOString(), run_generation: state.run_generation, plugin_root: canonicalPath(pluginRoot) };
    let active = null;
    const recover = (message) => {
        state.phase = 'RECOVERING';
        state.last_error = String(redact(message));
        state.host.hook_effective = false;
        state.recovery_condition = { kind: 'stop_transport', message: state.last_error, resume_when: 'Inspect the preserved Stop outcome and explicitly resume the same main session.' };
    };
    const shutdown = () => {
        if (closing)
            return;
        closing = true;
        if (active) {
            active.valid = false;
            active.abort.abort();
        }
        state.controller = { ...controller, lifecycle: 'exited' };
        store.save(state);
        server?.close();
        for (const socket of sockets)
            socket.end();
    };
    try {
        mkdirSync(dirname(leasePath), { recursive: true });
        try {
            lease = openSync(leasePath, 'wx', 0o600);
        }
        catch {
            throw new Error('This main session already has a controller lease; explicit recovery is required.');
        }
        writeFileSync(lease, JSON.stringify({ pid: process.pid, controller_id: id, state_path: path, main_session_id: state.main_session_id }));
        server = createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => { });
            socket.on('close', () => sockets.delete(socket));
            let input = '';
            socket.setTimeout(595_000, () => socket.destroy());
            socket.on('data', (chunk) => {
                input += chunk;
                if (input.length > 1024 * 1024)
                    return socket.destroy();
                if (!input.includes('\n'))
                    return;
                socket.removeAllListeners('data');
                void (async () => {
                    const message = JSON.parse(input.split('\n')[0]);
                    if (message.token !== controller.token || message.controller_id !== id || message.run_generation !== state.run_generation)
                        throw new Error('Owned controller handle identity mismatch.');
                    if (message.command === 'ping')
                        return { live: true, controller_id: id };
                    if (message.command === 'pause') {
                        state.status = 'PAUSED';
                        state.pause_reason = 'user';
                        state.phase = 'IDLE';
                        store.save(state);
                        if (active) {
                            active.valid = false;
                            active.abort.abort();
                        }
                        setImmediate(shutdown);
                        return { paused: true, state_path: path };
                    }
                    if (message.command !== 'lifecycle')
                        throw new Error('Unknown B command.');
                    const event = message.payload;
                    if (event?.session_id !== state.main_session_id || canonicalPath(event.cwd) !== canonicalPath(state.task.workspace) || event.agent_id != null || event.agent_type != null || event.agent_transcript_path != null)
                        return {};
                    if (active && event.hook_event_name === 'Stop')
                        throw new Error('A Stop is already pending; inspect the preserved attempt rather than creating another.');
                    const result = handleLifecycle(event, state.host, pluginRoot);
                    state = readJson(path);
                    if (!result.stop_request || state.status !== 'ACTIVE' || state.phase === 'RECOVERING')
                        return {};
                    const request = result.stop_request;
                    if (fixture?.transport?.timeout_ms != null)
                        request.deadline_at = new Date(Date.now() + Number(fixture.transport.timeout_ms)).toISOString();
                    const current = { abort: new AbortController(), request, socket, valid: true };
                    active = current;
                    state.stop_transport = { request, outcome: 'pending' };
                    state.phase = 'JUDGE';
                    store.save(state);
                    const invalidate = (reason) => {
                        if (!current.valid)
                            return;
                        current.valid = false;
                        current.abort.abort();
                        state.stop_transport = { request, outcome: 'unknown', error: reason };
                        recover(reason);
                        store.save(state);
                    };
                    const disconnected = () => { if (!socket.writableFinished)
                        invalidate('Hook disconnected before its result was returned; delivery is unknown.'); };
                    // A peer FIN can leave a pending writable half open until a response;
                    // invalidate at readable end, not only the later full socket close.
                    socket.once('end', disconnected);
                    socket.once('close', disconnected);
                    const timer = setTimeout(() => { invalidate('Stop hook deadline elapsed; late supervisor output is invalid.'); socket.end('{}\n'); }, Math.max(1, Date.parse(request.deadline_at) - Date.now()));
                    try {
                        const reply = await evaluateStop(state, request, fixture, current.abort.signal);
                        if (!current.valid || closing || socket.destroyed || Date.now() >= Date.parse(request.deadline_at))
                            return {};
                        const delivery = randomUUID();
                        state.pending_action = { delivery_id: delivery, source_turn_id: request.turn_id, task_version: request.task_version, message: reply.reason, stage: 'sent', target_turn_id: null };
                        state.continuation_confirmed = false;
                        state.phase = 'WORKER';
                        state.stop_transport = { request, outcome: 'returned', delivery_id: delivery };
                        store.save(state);
                        store.event(state, 'stop_hook_direction_returned', { stop_attempt_id: request.stop_attempt_id, delivery_id: delivery, session_id: request.session_id, execution_confirmed: false });
                        return reply;
                    }
                    catch (error) {
                        if (current.valid) {
                            state.stop_transport = { request, outcome: 'failed', error: String(redact(error.message)) };
                            recover(error.message);
                            store.save(state);
                        }
                        return {};
                    }
                    finally {
                        clearTimeout(timer);
                        if (active === current)
                            active = null;
                    }
                })().then((result) => { if (!socket.destroyed && !socket.writableEnded)
                    socket.end(JSON.stringify(result) + '\n'); }).catch((error) => { if (!socket.destroyed && !socket.writableEnded)
                    socket.end(JSON.stringify({ error: String(redact(error.message)) }) + '\n'); });
            });
        });
        await new Promise((done, reject) => { server.once('error', reject); server.listen(controller.endpoint, done); });
        state.controller = controller;
        state.status = 'ACTIVE';
        state.phase = 'WORKER';
        state.continuation_confirmed = false;
        delete state.recovery_condition;
        state.host.reason = 'Bound controller reachable; Stop continuation and actual main-session activity still require evidence.';
        store.save(state);
        store.event(state, 'main_session_controller_started', { controller_id: id, main_session_id: state.main_session_id, pid: process.pid });
        process.send?.({ ready: true, controller_id: id });
        if (process.connected)
            process.disconnect();
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
        await new Promise((done) => server.once('close', done));
    }
    finally {
        if (lease !== undefined) {
            closeSync(lease);
            if (JSON.parse(readFileSync(leasePath, 'utf8')).controller_id === id)
                unlinkSync(leasePath);
        }
        store.release();
        if (process.platform !== 'win32' && existsSync(controller.endpoint))
            unlinkSync(controller.endpoint);
    }
}
