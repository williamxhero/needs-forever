import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalPath, indexPath, readJson } from './main-session.js';
import type { MainSessionState, StopRequest } from './main-session.js';
import { handleLifecycle } from './lifecycle.js';
import { Store } from './store.js';
import { redact } from './redact.js';
import { preflightSupervisor, superviseStop } from './main-supervision.js';
import type { Decision } from './types.js';

type Controller = NonNullable<MainSessionState['controller']>;
type HookReply = { decision?: 'block'; reason?: string };
export function controllerRequest(controller: Controller, command: string, payload: unknown = null, timeout = 2_000): Promise<any> {
  return new Promise((done, reject) => {
    const socket = createConnection(controller.endpoint);
    let output = ''; let settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; socket.destroy(); reject(error); };
    socket.setTimeout(timeout, () => fail(new Error('Controller request deadline elapsed; explicit recovery may be required.')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(JSON.stringify({ token: controller.token, controller_id: controller.id, run_generation: controller.run_generation, command, payload }) + '\n'));
    socket.on('data', (chunk) => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) return fail(new Error('Oversized controller response.'));
      if (!output.includes('\n')) return;
      try { const result = JSON.parse(output.split('\n')[0]!); if (result.error) return fail(new Error(result.error)); settled = true; socket.destroy(); done(result); }
      catch (error) { fail(error as Error); }
    });
    socket.on('close', () => { if (!settled) fail(new Error('Controller disconnected; result is unknown and must not be replayed.')); });
  });
}
export async function controllerStatus(path: string): Promise<Record<string, unknown>> {
  const state = readJson(path) as MainSessionState;
  let live = false;
  if (state.controller?.lifecycle === 'running') {
    try { live = (await controllerRequest(state.controller, 'ping')).live === true; } catch { /* Read-only, never restart. */ }
  }
  return { ...state, control_mode: state.control_mode ?? 'independent-worker', live, continuation_confirmed: state.continuation_confirmed ?? false, recovery_required: (state.status === 'ACTIVE' && !live) || state.phase === 'RECOVERING' };
}
export async function launchController(path: string, pluginRoot: string, fixture?: string): Promise<void> {
  const state = readJson(path) as MainSessionState;
  if (state.controller) throw new Error('A controller receipt already exists; use explicit resume, never silently replace it.');
  const script = resolve(pluginRoot, 'scripts/controller.mjs');
  const child = spawn(process.execPath, [script, path, ...(fixture ? ['--test-fixture', fixture] : [])], { cwd: state.task.workspace, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try { await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { child.unref(); reject(new Error('B startup outcome unknown; inspect state and use explicit recovery.')); }, 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`B exited before readiness (${code}).`)); });
    child.once('message', (message: any) => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : done(); });
  }); } catch (error) {
    const saved = readJson(path) as MainSessionState;
    if (!saved.controller) {
      saved.phase = 'RECOVERING'; saved.last_error = String(redact((error as Error).message));
      saved.recovery_condition = { kind: 'controller_startup', message: saved.last_error, resume_when: 'Resolve the existing ownership or startup failure, then explicitly resume the bound main session.' };
      new Store(path).save(saved);
    }
    throw error;
  }
  child.unref();
}
export function boundStateForEvent(input: any, pluginRoot: string, simulated: boolean): string | null {
  if (!input || input.agent_id != null || input.agent_type != null || input.agent_transcript_path != null || typeof input.session_id !== 'string' || typeof input.cwd !== 'string') return null;
  if (canonicalPath(input.cwd) !== canonicalPath(process.cwd())) return null;
  const index = indexPath(input.cwd);
  if (!existsSync(index)) return null;
  for (const path of readJson(index).states as string[]) {
    if (!existsSync(path)) continue;
    const state = readJson(path) as MainSessionState;
    if (state.control_mode === 'main-session' && state.binding.status === 'BOUND' && state.main_session_id === input.session_id && (state.mode === 'simulated') === simulated && state.controller && canonicalPath(state.controller.plugin_root) === canonicalPath(pluginRoot)) return path;
  }
  return null;
}
export async function dispatchBoundLifecycle(path: string, input: unknown): Promise<HookReply> {
  const state = readJson(path) as MainSessionState;
  if (!state.controller || state.controller.lifecycle !== 'running') return {};
  return controllerRequest(state.controller, 'lifecycle', input, 590_000);
}

// Stop judgments share the existing schema/readonly judge. Transport-only
// fixtures substitute the external model; live tasks cannot use fixture output.
export async function evaluateStop(state: MainSessionState, request: StopRequest, fixture: any, signal: AbortSignal, store: Store): Promise<Decision> {
  if (state.mode !== 'simulated' || !fixture?.transport?.decision) return superviseStop(state, request, fixture, signal, store);
  await delay(Number(fixture.transport.delay_ms ?? 0), undefined, { signal });
  const decision = fixture.transport.decision;
  if (decision.action !== 'CONTINUE' || typeof decision.next_message !== 'string' || !decision.next_message.trim()) throw new Error('Transport fixtures may only request concrete CONTINUE; DONE requires the completion gate.');
  return { action: 'CONTINUE', reason: 'Simulated external transport direction.', evidence_ids: [], next_message: String(redact(decision.next_message)), external: null };
}
export async function runController(path: string, pluginRoot: string, fixturePath?: string): Promise<void> {
  const store = new Store(path);
  let state = readJson(path) as MainSessionState;
  const fixture = fixturePath ? readJson(fixturePath) : null;
  if (state.binding.status !== 'BOUND' || !state.main_session_id || (state.mode === 'simulated') !== Boolean(fixturePath)) throw new Error('B requires a correlated main-session binding and matching evidence mode.');
  if (state.controller) throw new Error('Controller receipt already exists; explicit recovery is required.');
  store.lock(state.task);
  const leasePath = resolve(tmpdir(), 'codex-supervisor-locks', `main-session-${createHash('sha256').update(state.main_session_id).digest('hex')}.lock`);
  let lease: number | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let closing = false;
  const sockets = new Set<Socket>();
  const id = randomUUID();
  const controller: Controller = { id, pid: process.pid, token: randomUUID(), endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\needs-forever-main-${id}` : resolve(tmpdir(), `nf-main-${id}.sock`), lifecycle: 'running', started_at: new Date().toISOString(), run_generation: state.run_generation, plugin_root: canonicalPath(pluginRoot) };
  let active: { abort: AbortController; request: StopRequest; socket: Socket; valid: boolean } | null = null;
  const recover = (message: string) => {
    state.phase = 'RECOVERING'; state.last_error = String(redact(message)); state.host.hook_effective = false;
    state.recovery_condition = { kind: 'stop_transport', message: state.last_error, resume_when: 'Inspect the preserved Stop outcome and explicitly resume the same main session.' };
  };
  const shutdown = () => {
    if (closing) return; closing = true;
    if (active) { active.valid = false; active.abort.abort(); }
    state.controller = { ...controller, lifecycle: 'exited' }; store.save(state);
    server?.close(); for (const socket of sockets) socket.end();
  };
  try {
    mkdirSync(dirname(leasePath), { recursive: true });
    try { lease = openSync(leasePath, 'wx', 0o600); }
    catch { throw new Error('This main session already has a controller lease; explicit recovery is required.'); }
    writeFileSync(lease, JSON.stringify({ pid: process.pid, controller_id: id, state_path: path, main_session_id: state.main_session_id }));
    await preflightSupervisor(state, fixture);
    server = createServer((socket) => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      let input = '';
      socket.setTimeout(595_000, () => socket.destroy());
      socket.on('data', (chunk) => {
        input += chunk;
        if (input.length > 1024 * 1024) return socket.destroy();
        if (!input.includes('\n')) return;
        socket.removeAllListeners('data');
        void (async () => {
          const message = JSON.parse(input.split('\n')[0]!);
          if (message.token !== controller.token || message.controller_id !== id || message.run_generation !== state.run_generation) throw new Error('Owned controller handle identity mismatch.');
          if (message.command === 'ping') return { live: true, controller_id: id };
          if (message.command === 'pause') {
            state.status = 'PAUSED'; state.pause_reason = 'user'; state.phase = 'IDLE'; store.save(state);
            if (active) { active.valid = false; active.abort.abort(); }
            setImmediate(shutdown); return { paused: true, state_path: path };
          }
          if (message.command !== 'lifecycle') throw new Error('Unknown B command.');
          const event = message.payload;
          if (event?.session_id !== state.main_session_id || canonicalPath(event.cwd) !== canonicalPath(state.task.workspace) || event.agent_id != null || event.agent_type != null || event.agent_transcript_path != null) return {};
          if (active && event.hook_event_name === 'Stop') throw new Error('A Stop is already pending; inspect the preserved attempt rather than creating another.');
          const result = handleLifecycle(event, state.host, pluginRoot);
          state = readJson(path) as MainSessionState;
          if (!result.stop_request || state.status !== 'ACTIVE' || state.phase === 'RECOVERING') return {};
          const request = result.stop_request;
          if (fixture?.transport?.timeout_ms != null) request.deadline_at = new Date(Date.now() + Number(fixture.transport.timeout_ms)).toISOString();
          const current = { abort: new AbortController(), request, socket, valid: true }; active = current;
          state.stop_transport = { request, outcome: 'pending' }; state.phase = 'JUDGE'; store.save(state);
          const invalidate = (reason: string) => {
            if (!current.valid) return; current.valid = false; current.abort.abort();
            state.stop_transport = { request, outcome: 'unknown', error: reason }; recover(reason); store.save(state);
          };
          const disconnected = () => { if (!socket.writableFinished) invalidate('Hook disconnected before its result was returned; delivery is unknown.'); };
          // A peer FIN can leave a pending writable half open until a response;
          // invalidate at readable end, not only the later full socket close.
          socket.once('end', disconnected);
          socket.once('close', disconnected);
          const timer = setTimeout(() => { invalidate('Stop hook deadline elapsed; late supervisor output is invalid.'); socket.end('{}\n'); }, Math.max(1, Date.parse(request.deadline_at) - Date.now()));
          try {
            const decision = await evaluateStop(state, request, fixture, current.abort.signal, store);
            if (!current.valid || closing || socket.destroyed || Date.now() >= Date.parse(request.deadline_at)) return {};
            state.last_decision = redact(decision) as Decision;
            state.host.hook_effective = state.mode === 'live' && state.host.source === 'native-desktop';
            state.host.reason = 'Correlated synchronous Stop judged and returned; actual main-session continuation requires subsequent matching activity.';
            if (decision.action !== 'CONTINUE') {
              state.status = decision.action; state.phase = 'IDLE'; state.pending_action = null;
              state.stop_transport = { request, outcome: 'returned' };
              if (decision.action === 'DONE') state.binding.status = 'RELEASED';
              store.save(state);
              store.event(state, 'main_session_terminal', { action: decision.action, stop_attempt_id: request.stop_attempt_id, reason: decision.reason, external: decision.external });
              // Allow the active synchronous hook response to flush before closing B.
              socket.once('finish', () => setImmediate(shutdown));
              return {};
            }
            const delivery = randomUUID();
            state.pending_action = { delivery_id: delivery, source_turn_id: request.turn_id, task_version: request.task_version, message: String(redact(decision.next_message)), stage: 'sent', target_turn_id: null };
            state.direction_context = { delivery_id: delivery, at: new Date().toISOString(), run_generation: state.run_generation, input_epoch: state.input_epoch ?? 0, contract_sha256: state.contract_sha256 };
            state.continuation_confirmed = false; state.phase = 'WORKER';
            state.stop_transport = { request, outcome: 'returned', delivery_id: delivery }; store.save(state);
            store.event(state, 'stop_hook_direction_returned', { stop_attempt_id: request.stop_attempt_id, delivery_id: delivery, session_id: request.session_id, execution_confirmed: false });
            return { decision: 'block', reason: state.pending_action.message };
          } catch (error) {
            if (current.valid) { state.stop_transport = { request, outcome: 'failed', error: String(redact((error as Error).message)) }; recover((error as Error).message); store.save(state); }
            return {};
          } finally {
            clearTimeout(timer);
            // A successful host client closes after reading its response. That
            // old socket must never invalidate the next Stop's checkpoint.
            socket.removeListener('end', disconnected);
            socket.removeListener('close', disconnected);
            if (active === current) active = null;
          }
        })().then((result) => { if (!socket.destroyed && !socket.writableEnded) socket.end(JSON.stringify(result) + '\n'); }).catch((error) => { if (!socket.destroyed && !socket.writableEnded) socket.end(JSON.stringify({ error: String(redact(error.message)) }) + '\n'); });
      });
    });
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(controller.endpoint, done); });
    state.controller = controller; state.status = 'ACTIVE'; state.phase = 'WORKER'; state.continuation_confirmed = false;
    delete state.recovery_condition;
    state.host.reason = 'Bound controller reachable; Stop continuation and actual main-session activity still require evidence.';
    store.save(state); store.event(state, 'main_session_controller_started', { controller_id: id, main_session_id: state.main_session_id, pid: process.pid });
    process.send?.({ ready: true, controller_id: id }); if (process.connected) process.disconnect();
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    await new Promise<void>((done) => server!.once('close', done));
  } finally {
    if (lease !== undefined) { closeSync(lease); if (JSON.parse(readFileSync(leasePath, 'utf8')).controller_id === id) unlinkSync(leasePath); }
    store.release();
    if (process.platform !== 'win32' && existsSync(controller.endpoint)) unlinkSync(controller.endpoint);
  }
}
