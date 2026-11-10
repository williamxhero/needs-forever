import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { armNativeRebind, canonicalPath, registeredStatePaths, readJson, mainLeasePath, contractHash } from './main-session.js';
import type { MainSessionState, StopRequest } from './main-session.js';
import { handleLifecycle } from './lifecycle.js';
import type { NativeLifecycleReceipt } from './lifecycle.js';
import { Store } from './store.js';
import { redact } from './redact.js';
import { buildMainSessionSnapshot, preflightSupervisor, superviseStop } from './main-supervision.js';
import { validateDecision } from './judge.js';
import { captureRouteOutcome, discoverLocalRoutes, plannerFailureFallback, prepareRouteExecution, routeCorrelation } from './route-execution.js';
import type { Decision } from './types.js';
import { classifyRecoveryError, nextBackoff, recordRecoveryFailure, type RecoveryFailure } from './recovery.js';
import { reachedLimits } from './rules.js';
import { armRecovery, cancelRecovery, createRecoveryPlan, markRecoveryRunning, acquireRecoveryOwner, waitForNativeReceipt, reconcileStaleOwner, type RecoveryReason } from './recovery-coordinator.js';
import { scheduleNativeRebindPrompt } from './main-session-recovery.js';
import { initializeHttpRouteProbe } from './http-route-probe.js';

type Controller = NonNullable<MainSessionState['controller']>;
type HookReply = { decision?: 'block'; reason?: string };

function scheduleMainSessionRecoveryPrompt(path: string, pluginRoot: string, fixturePath: string | undefined, state: MainSessionState, message: string, sourceTurnId: string | null): void {
  if (state.control_mode !== 'main-session' || !state.main_session_id || state.status !== 'ACTIVE') return;
  const delayValue = Number(fixturePath ? (readJson(fixturePath) as { recovery_prompt_delay_ms?: unknown }).recovery_prompt_delay_ms : process.env.NF_RECOVERY_PROMPT_DELAY_MS ?? 3_000);
  const delayMs = Number.isFinite(delayValue) && delayValue >= 0 ? delayValue : 3_000;
  const deliveryId = state.pending_action?.delivery_id;
  if (!deliveryId) return;
  state.recovery_prompt = {
    ...routeCorrelation(state.pending_action),
    kind: 'continuation',
    delivery_id: deliveryId,
    source_turn_id: sourceTurnId,
    ...routeCorrelation(state.pending_action),
    task_version: state.task_version,
    run_generation: state.run_generation,
    message,
    due_at: new Date(Date.now() + delayMs).toISOString(),
  };
  const store = new Store(path);
  store.save(state);
  store.event(state, 'main_session_recovery_prompt_scheduled', {
    delivery_id: deliveryId,
    main_session_id: state.main_session_id,
    source_turn_id: sourceTurnId,
    due_at: state.recovery_prompt.due_at,
    reason: 'A 未在 Stop 方向返回后产生匹配活动；NF 将自动发送恢复 prompt。',
  });
  const script = resolve(pluginRoot, 'scripts/recovery-prompt.mjs');
  const child = spawn(process.execPath, [script, path, ...(fixturePath ? ['--test-fixture', fixturePath] : [])], { cwd: state.task.workspace, detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
}
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
  let hostAlive: boolean | null = null;
  const pid = (state.host as typeof state.host & { desktop_pid?: number }).desktop_pid;
  if (pid) { try { process.kill(pid, 0); hostAlive = true; } catch (error) { hostAlive = (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; } }
  const elapsed = state.elapsed_active_seconds + (state.status === 'ACTIVE' && live && state.active_checkpoint_at ? Math.max(0, Date.now() - Date.parse(state.active_checkpoint_at)) / 1000 : 0);
  return { ...state, host: { ...state.host, hook_effective: state.host.hook_effective && hostAlive !== false }, elapsed_active_seconds: elapsed, control_mode: state.control_mode ?? 'independent-worker', live, controller_reachable: live, host_process_alive: hostAlive, hook_effective: state.host.hook_effective && hostAlive !== false, continuation_confirmed: state.continuation_confirmed ?? false, recovery_required: (state.status === 'ACTIVE' && (!live || hostAlive === false)) || state.phase === 'RECOVERING' };
}
function processAbsent(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid saved controller identity.');
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
}
function acquireMainLease(leasePath: string, statePath: string, mainSessionId: string, controllerId: string): number {
  mkdirSync(dirname(leasePath), { recursive: true });
  try { return openSync(leasePath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner: any;
    try { owner = JSON.parse(readFileSync(leasePath, 'utf8')); } catch { throw new Error('Existing main-session lease is unreadable; refusing automatic recovery.'); }
    if (owner.state_path !== statePath || owner.main_session_id !== mainSessionId || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Existing main-session lease identity is ambiguous; refusing automatic recovery.');
    if (!processAbsent(owner.pid)) throw new Error('This main session already has a live controller lease.');
    unlinkSync(leasePath);
    const lease = openSync(leasePath, 'wx', 0o600);
    writeFileSync(lease, JSON.stringify({ pid: process.pid, controller_id: controllerId, state_path: statePath, main_session_id: mainSessionId }));
    return lease;
  }
}
export async function pauseMainController(path: string): Promise<unknown> {
  const state = readJson(path) as MainSessionState;
  if (state.status === 'PAUSED' && state.controller && !processAbsent(state.controller.pid)) return controllerRequest(state.controller, 'pause');
  if (state.status === 'PAUSED' && state.pause_reason) {
    const store = new Store(path); store.lock(state.task, true);
    try {
      const latest = readJson(path) as MainSessionState;
      cancelRecovery(latest, 'pause'); latest.host.hook_effective = false; store.save(latest);
    } finally { store.release(); }
    return { paused: true, status: 'PAUSED', state_path: path };
  }
  if (state.status !== 'ACTIVE' && state.status !== 'PAUSED') throw new Error(`Task is ${state.status}; no active task to pause.`);
  if (state.controller && !processAbsent(state.controller.pid)) return controllerRequest(state.controller, 'pause');
  const store = new Store(path); store.lock(state.task, true);
  try {
    const latest = readJson(path) as MainSessionState;
    if (latest.controller && !processAbsent(latest.controller.pid)) throw new Error('A controller became active; retry using its owned channel.');
    latest.status = 'PAUSED'; latest.pause_reason = 'user'; latest.phase = 'IDLE'; latest.input_epoch = (latest.input_epoch ?? 0) + 1; latest.pending_action = null; delete latest.route_execution;
    cancelRecovery(latest, 'pause');
    delete latest.direction_context; latest.host.hook_effective = false; store.save(latest);
    store.event(latest, 'main_session_offline_pause', { controller_proven_absent: true });
    return { paused: true, status: 'PAUSED', state_path: path };
  } finally { store.release(); }
}
export async function prepareControllerResume(path: string): Promise<void> {
  const state = readJson(path) as MainSessionState;
  if (!state.controller || processAbsent(state.controller.pid)) return;
  if (state.status !== 'INTERRUPTED') await controllerRequest(state.controller, 'release-for-resume');
  const deadline = Date.now() + 3_000;
  while (!processAbsent(state.controller.pid)) {
    if (Date.now() >= deadline) throw new Error('Owned B has not exited; no lease was reclaimed. Inspect status before retrying.');
    await delay(25);
  }
}
export async function launchController(path: string, pluginRoot: string, fixture?: string): Promise<void> {
  const launchLock = `${path}.controller-launch.lock`;
  let launchFd: number | undefined;
  const releaseLaunchLock = () => {
    if (launchFd === undefined) return;
    closeSync(launchFd); launchFd = undefined;
    try { unlinkSync(launchLock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  try {
    launchFd = openSync(launchLock, 'wx', 0o600);
    writeFileSync(launchFd, JSON.stringify({ pid: process.pid, state_path: path, started_at: new Date().toISOString() }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Another lifecycle callback owns the launch transition. Let its winner
    // finish; never mark that winner exited from this losing callback. Reclaim
    // only a lock whose owner is provably gone.
    try {
      const owner = JSON.parse(readFileSync(launchLock, 'utf8')) as { pid?: number };
      if (Number.isInteger(owner.pid)) { try { process.kill(owner.pid!, 0); return; } catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') return; } }
      const guard = `${launchLock}.reclaim`;
      let guardFd: number | undefined;
      try { guardFd = openSync(guard, 'wx', 0o600); unlinkSync(launchLock); launchFd = openSync(launchLock, 'wx', 0o600); writeFileSync(launchFd, JSON.stringify({ pid: process.pid, state_path: path, started_at: new Date().toISOString() })); }
      finally { if (guardFd !== undefined) closeSync(guardFd); try { unlinkSync(guard); } catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup; } }
    } catch { return; }
  }
  const state = readJson(path) as MainSessionState;
  if (state.status === 'INTERRUPTED') { releaseLaunchLock(); throw new Error('Supervision interrupted; explicit resume is required.'); }
  if (state.controller?.lifecycle === 'running') {
    if (!processAbsent(state.controller.pid)) { releaseLaunchLock(); throw new Error('A controller receipt already exists; use explicit resume, never silently replace it.'); }
    state.controller = { ...state.controller, lifecycle: 'exited' };
  }
  if (state.controller?.lifecycle === 'exited') delete state.controller;
  state.controller_startup_deadline = new Date(Date.now() + 25_000).toISOString(); new Store(path).save(state);
  const script = resolve(pluginRoot, 'scripts/controller.mjs');
  const child = spawn(process.execPath, [script, path, ...(fixture ? ['--test-fixture', fixture] : [])], { cwd: state.task.workspace, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try { await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { child.unref(); reject(new Error('B startup outcome unknown; inspect state and use explicit recovery.')); }, 25_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`B exited before readiness (${code}).`)); });
    child.once('message', (message: any) => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : done(); });
  }); } catch (error) {
    const saved = readJson(path) as MainSessionState;
    if (saved.status === 'INTERRUPTED') { releaseLaunchLock(); throw error; }
    if (!saved.controller) {
      const message = String(redact((error as Error).message));
      if (saved.control_mode === 'main-session' && saved.binding.status === 'BOUND' && saved.main_session_id && saved.status !== 'DONE') {
        armNativeRebind(saved, message);
        waitForNativeReceipt(saved, {
          kind: 'native_rebind',
          message,
          resume_when: 'A real native receipt from the original A must be correlated before B/C can restart.',
        });
      } else {
        saved.phase = 'RECOVERING'; saved.last_error = message;
        saved.recovery_condition = { kind: 'controller_startup', message: saved.last_error, resume_when: 'Resolve the existing ownership or startup failure, then explicitly resume the bound main session.' };
        armRecovery(saved, saved.recovery_condition);
      }
      new Store(path).save(saved);
      if (saved.binding.status === 'PENDING_NATIVE_HOOK' && saved.binding.operation === 'rebind') scheduleNativeRebindPrompt(path, pluginRoot, fixture, saved, message);
    } else if (saved.control_mode === 'main-session' && saved.binding.status === 'BOUND' && saved.main_session_id && saved.status !== 'DONE') {
      const message = String(redact((error as Error).message));
      armNativeRebind(saved, message);
      waitForNativeReceipt(saved, {
        kind: 'native_rebind',
        message,
        resume_when: 'A real native receipt from the original A must be correlated before B/C can restart.',
      });
      saved.controller = { ...saved.controller, lifecycle: 'exited' };
      new Store(path).save(saved);
      scheduleNativeRebindPrompt(path, pluginRoot, fixture, saved, message);
    }
    releaseLaunchLock();
    throw error;
  }
  child.unref();
  try {
    const coordinator = resolve(pluginRoot, 'scripts/recovery-coordinator.mjs');
    const watchdog = spawn(process.execPath, [coordinator, path], { cwd: state.task.workspace, detached: true, windowsHide: true, stdio: 'ignore' });
    watchdog.unref();
  } catch {
    // B is already live; a later lifecycle/status path can restart the
    // coordinator. Do not turn a successful binding into a false failure.
  } finally {
    releaseLaunchLock();
  }
}
export function boundStateForEvent(input: any, pluginRoot: string, simulated: boolean): string | null {
  if (!input || input.agent_id != null || input.agent_type != null || input.agent_transcript_path != null || typeof input.session_id !== 'string' || typeof input.cwd !== 'string') return null;
  if (canonicalPath(input.cwd) !== canonicalPath(process.cwd())) return null;
  const callbackPluginRoot = canonicalPath(pluginRoot);
  for (const path of registeredStatePaths(input.cwd)) {
    if (!existsSync(path)) continue;
    const state = readJson(path) as MainSessionState;
    if (state.controller?.lifecycle === 'running' && reconcileStaleOwner(state)) {
      const store = new Store(path);
      store.save(state);
      store.event(state, 'recovery_owner_reconciled', { generation: state.recovery_plan?.generation, task_version: state.task_version, binding_status: state.binding.status });
    }
    // A workspace may contain checkpoints created by multiple installed plugin
    // versions. Only the package that owns B may dispatch callbacks to it;
    // otherwise a second installation can make B report a false plugin change
    // and strand the task in RECOVERING.
    const controllerRunning = state.controller?.lifecycle === 'running';
    const ownerPluginMatches = canonicalPath(state.controller?.plugin_root ?? pluginRoot) === callbackPluginRoot;
    const exitedControllerRebind = !controllerRunning && ['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name) && state.status === 'ACTIVE';
    if (state.control_mode === 'main-session' && state.status !== 'DONE' && state.status !== 'INTERRUPTED' && state.binding.status === 'BOUND' && state.main_session_id === input.session_id && (state.mode === 'simulated') === simulated && ((controllerRunning && ownerPluginMatches) || exitedControllerRebind)) return path;
  }
  return null;
}
export async function dispatchBoundLifecycle(path: string, input: unknown, pluginRoot?: string, bundleHash?: string, desktopPid?: number, nativeReceipt?: NativeLifecycleReceipt, fixturePath?: string): Promise<HookReply> {
  const state = readJson(path) as MainSessionState;
  if (!state.controller || state.controller.lifecycle !== 'running') {
    if (!pluginRoot || !bundleHash || !nativeReceipt || !['SessionStart', 'UserPromptSubmit'].includes((input as any)?.hook_event_name) || state.status !== 'ACTIVE' || state.binding.status !== 'BOUND' || state.main_session_id !== (input as any)?.session_id || canonicalPath((input as any)?.cwd) !== canonicalPath(state.task.workspace)) return {};
    const issuedAt = Date.parse(nativeReceipt.issued_at);
    const previousAt = state.binding.accepted_receipt ? Date.parse(state.binding.accepted_receipt.issued_at) : NaN;
    if (!nativeReceipt.occurrence_id || !Number.isFinite(issuedAt) || (Number.isFinite(previousAt) && issuedAt <= previousAt)) return {};
    const store = new Store(path);
    const generation = randomUUID();
    state.input_epoch = (state.input_epoch ?? 0) + 1;
    state.run_generation = generation;
    state.pending_action = null;
    delete state.route_execution;
    delete state.direction_context;
    delete state.last_stop;
    state.tool_starts = {};
    state.continuation_confirmed = false;
    state.phase = 'WORKER';
    delete state.last_error;
    delete state.recovery_condition;
    const reboundHost = { ...state.host, hook_effective: state.mode === 'live' && state.host.source === 'native-desktop', reason: 'Automatic native lifecycle receipt re-bound the original A.' };
    const reboundDesktopPid = typeof desktopPid === 'number' && Number.isInteger(desktopPid) ? desktopPid : null;
    if (reboundDesktopPid !== null) reboundHost.desktop_pid = reboundDesktopPid;
    state.host = reboundHost;
    state.binding = { ...state.binding, status: 'BOUND', bound_at: new Date().toISOString(), accepted_receipt: { ...nativeReceipt, generation } };
    if (state.recovery_plan) {
      state.recovery_plan = { ...state.recovery_plan, generation, owner: null, status: 'running', next_retry_at: null, cancellation_boundary: null };
    }
    delete state.controller;
    store.save(state);
    store.event(state, 'main_session_rebind_receipt', { main_session_id: state.main_session_id, task_version: state.task_version, run_generation: generation, receipt_occurrence_id: nativeReceipt.occurrence_id, receipt_issued_at: nativeReceipt.issued_at, hook_event_name: (input as any).hook_event_name, host_source: state.host.source, automatic: true, callback_plugin_root: canonicalPath(pluginRoot), callback_bundle_sha256: bundleHash });
    await launchController(path, pluginRoot, fixturePath);
    return {};
  }
  // The adapter owns occurrence identity. It is not a field supplied by native
  // stdin. One native command invocation sends exactly once on the pinned host.
  const adapterOccurrenceId = randomUUID();
  return controllerRequest(state.controller, 'lifecycle', { adapter_occurrence_id: adapterOccurrenceId, native_receipt: nativeReceipt ?? null, event: { ...(input as object), ...(pluginRoot ? { callback_plugin_root: canonicalPath(pluginRoot) } : {}), ...(bundleHash ? { callback_bundle_sha256: bundleHash } : {}), ...(desktopPid ? { callback_desktop_pid: desktopPid } : {}) } }, 590_000);
}

// Stop judgments share the existing schema/readonly judge. Transport-only
// fixtures substitute the external model; live tasks cannot use fixture output.
export async function evaluateStop(state: MainSessionState, request: StopRequest, fixture: any, signal: AbortSignal, store: Store): Promise<Decision> {
  if (state.mode !== 'simulated' || !fixture?.transport?.decision) return superviseStop(state, request, fixture, signal, store);
  await delay(Number(fixture.transport.delay_ms ?? 0), undefined, { signal });
  const decision = fixture.transport.decision;
  if (decision.action !== 'CONTINUE' || typeof decision.next_message !== 'string' || !decision.next_message.trim()) throw new Error('Transport fixtures may only request concrete CONTINUE; DONE requires the completion gate.');
  const snapshot = buildMainSessionSnapshot(state, request, store.events());
  const raw = { reason: 'Simulated external transport direction.', evidence_ids: [], external: null, ...decision };
  const validated = validateDecision(JSON.stringify(raw), snapshot);
  store.event(state, 'decision', { role: 'judge', source: 'simulated-transport', stop_attempt_id: request.stop_attempt_id, decision: validated });
  return validated;
}
export async function runController(path: string, pluginRoot: string, fixturePath?: string): Promise<void> {
  const store = new Store(path);
  let state = readJson(path) as MainSessionState;
  const fixture = fixturePath ? readJson(fixturePath) : null;
  if (state.binding.status !== 'BOUND' || !state.main_session_id || (state.mode === 'simulated') !== Boolean(fixturePath)) throw new Error('B requires a correlated main-session binding and matching evidence mode.');
  if (state.controller) throw new Error('Controller receipt already exists; explicit recovery is required.');
  store.lock(state.task, true);
  const leasePath = mainLeasePath(state.main_session_id);
  let lease: number | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let closing = false;
  let checkpointTimer: ReturnType<typeof setInterval> | undefined;
  const startupAbort = new AbortController();
  const sockets = new Set<Socket>();
  const id = randomUUID();
  let controller: Controller = { id, pid: process.pid, token: randomUUID(), endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\needs-forever-main-${id}` : resolve(tmpdir(), `nf-main-${id}.sock`), lifecycle: 'running', started_at: new Date().toISOString(), run_generation: state.run_generation, plugin_root: canonicalPath(pluginRoot), bundle_sha256: createHash('sha256').update(readFileSync(resolve(pluginRoot, 'runtime/integrity.json'))).digest('hex') };
  let active: { abort: AbortController; request: StopRequest; socket: Socket; valid: boolean; epoch: number } | null = null;
  let recoveryOwner: ReturnType<typeof acquireRecoveryOwner> | undefined;
  const accrue = () => {
    const now = Date.now();
    if (state.status === 'ACTIVE' && state.active_checkpoint_at) state.elapsed_active_seconds += Math.max(0, now - Date.parse(state.active_checkpoint_at)) / 1000;
    state.active_checkpoint_at = new Date(now).toISOString();
  };
  const cancelActive = (reason: string) => {
    const prior = active;
    if (!prior) return;
    prior.valid = false; active = null;
    state.stop_transport = { request: prior.request, outcome: 'failed', error: reason };
    store.save(state); // Durable invalidation precedes canceling any owned call.
    prior.abort.abort();
    if (!prior.socket.destroyed && !prior.socket.writableEnded) prior.socket.end('{}\n');
  };
  const pause = (reason: 'user' | 'user_limit') => {
    accrue(); state.status = 'PAUSED'; state.pause_reason = reason; state.phase = 'IDLE';
    state.input_epoch = (state.input_epoch ?? 0) + 1; state.pending_action = null; delete state.route_execution; delete state.direction_context; state.continuation_confirmed = false;
    cancelRecovery(state, 'pause'); store.save(state); cancelActive('Paused before cancellation.');
  };
  const recover = (message: string) => {
    if (state.status === 'PAUSED' || state.status === 'DONE' || state.status === 'INTERRUPTED') return;
    state.input_epoch = (state.input_epoch ?? 0) + 1; delete state.route_execution; delete state.direction_context; state.tool_starts = {}; state.continuation_confirmed = false;
    state.phase = 'RECOVERING'; state.last_error = String(redact(message)); state.host.hook_effective = false;
    state.recovery_condition = { kind: 'stop_transport', message: state.last_error, resume_when: 'Inspect the preserved Stop outcome and explicitly resume the same main session.' };
    armRecovery(state, state.recovery_condition);
  };
  const rearmBinding = (message: string, desktopPid?: number) => {
    if (state.status === 'PAUSED' || state.status === 'DONE' || state.status === 'INTERRUPTED' || state.binding.status !== 'BOUND' || !state.main_session_id) return;
    if (desktopPid) state.host.desktop_pid = desktopPid;
    const reason = String(redact(message));
    armNativeRebind(state, reason);
    waitForNativeReceipt(state, {
      kind: 'native_rebind',
      message: reason,
      resume_when: 'A real native receipt from the original A must be correlated before B/C can restart.',
    });
    state.controller = { ...controller, lifecycle: 'exited' };
    store.save(state);
    scheduleNativeRebindPrompt(path, pluginRoot, fixturePath, state, reason);
  };
  const shutdown = () => {
    if (closing) return; closing = true;
    clearInterval(checkpointTimer);
    startupAbort.abort();
    const latest = readJson(path) as MainSessionState;
    if (latest.status === 'INTERRUPTED') state = latest;
    accrue();
    if (active) { active.valid = false; active.abort.abort(); }
    state.controller = { ...controller, lifecycle: 'exited' };
    if (state.status !== 'PAUSED' && state.status !== 'DONE' && state.status !== 'INTERRUPTED' && state.recovery_plan?.status !== 'cancelled' && state.recovery_plan?.status !== 'waiting_native') {
      const reason = { kind: 'controller_exit', message: 'Controller exited before the supervision task reached a terminal state.', resume_when: 'Wait for the persisted recovery plan to re-arm the original main session.' } satisfies RecoveryReason;
      armRecovery(state, reason);
    }
    store.save(state);
    server?.close(); for (const socket of sockets) socket.end();
  };
  try {
    lease = acquireMainLease(leasePath, path, state.main_session_id, id);
    if (readFileSync(leasePath, 'utf8').length === 0) writeFileSync(lease, JSON.stringify({ pid: process.pid, controller_id: id, state_path: path, main_session_id: state.main_session_id }));
    if (!state.recovery_plan) {
      const reason = state.recovery_condition ?? { kind: 'controller_startup', message: 'Controller recovery plan initialized.', resume_when: 'Revalidate the original native binding before resuming.' };
      state.recovery_plan = createRecoveryPlan(state, reason, false);
    }
    recoveryOwner = acquireRecoveryOwner(path, state);
    markRecoveryRunning(state, recoveryOwner.owner);
    store.save(state);
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
          const latest = readJson(path) as MainSessionState;
          // Re-read the checkpoint at the IPC boundary. A controller can stay
          // alive while an explicit pause/resume replaces its generation; an
          // old socket must fail closed before it can append a lifecycle event.
          const lifecycleCommand = message.command === 'lifecycle';
          if (message.token !== controller.token || message.controller_id !== id || message.run_generation !== state.run_generation || latest.run_generation !== message.run_generation || latest.controller?.id !== id || latest.status === 'DONE' || latest.status === 'INTERRUPTED' || (lifecycleCommand && (latest.status === 'PAUSED' || latest.recovery_plan?.cancellation_boundary))) throw new Error('Owned controller handle identity mismatch.');
          state = latest;
          if (message.command === 'ping') return { live: true, controller_id: id };
          if (message.command === 'release-for-resume') {
            const hostPid = (state.host as typeof state.host & { desktop_pid?: number }).desktop_pid;
            if (state.status === 'ACTIVE' && state.phase !== 'RECOVERING' && !(hostPid && processAbsent(hostPid))) throw new Error('Active healthy supervision must be paused before resume.');
            cancelActive('Explicit resume retires the old controller without replay.');
            state.host.hook_effective = false; store.save(state); setImmediate(shutdown); return { released: true };
          }
          if (message.command === 'pause') {
            pause('user');
            setImmediate(shutdown); return { paused: true, state_path: path };
          }
          if (message.command !== 'lifecycle') throw new Error('Unknown B command.');
          const event = message.payload?.event;
          if (event?.session_id !== state.main_session_id || canonicalPath(event.cwd) !== canonicalPath(state.task.workspace) || event.agent_id != null || event.agent_type != null || event.agent_transcript_path != null) return {};
          const nativeReceipt = message.payload?.native_receipt as NativeLifecycleReceipt | null | undefined;
          const acceptedReceipt = state.binding.accepted_receipt;
          if (acceptedReceipt && nativeReceipt && Date.parse(nativeReceipt.issued_at) <= Date.parse(acceptedReceipt.issued_at)) return {};
          const desktopRestarted = event.hook_event_name === 'SessionStart' && Number.isInteger(event.callback_desktop_pid) && Number.isInteger(state.host.desktop_pid) && event.callback_desktop_pid !== state.host.desktop_pid;
          const callbackPluginRoot = typeof event.callback_plugin_root === 'string' ? canonicalPath(event.callback_plugin_root) : controller.plugin_root;
          const callbackBundleSha = typeof event.callback_bundle_sha256 === 'string' ? event.callback_bundle_sha256 : null;
          const pluginChanged = callbackPluginRoot !== controller.plugin_root;
          const bundleChanged = callbackBundleSha !== null && callbackBundleSha !== controller.bundle_sha256;
          if (desktopRestarted || pluginChanged || bundleChanged) {
            const sameTrustedA = state.status === 'ACTIVE' && state.binding.status === 'BOUND' && state.main_session_id === event.session_id && callbackPluginRoot === canonicalPath(pluginRoot) && callbackBundleSha !== null;
            if (sameTrustedA) {
              // The lifecycle callback already came through the newly loaded
              // trusted hook for the original A. Keep it as the receipt and
              // update B's fingerprints in place; shutting B down here would
              // strand the task waiting for a second callback that Codex may
              // never emit after a host/plugin restart.
              cancelActive('Native host or plugin changed; the new lifecycle receipt re-bound the original A.');
              const generation = randomUUID();
              state.input_epoch = (state.input_epoch ?? 0) + 1;
              state.run_generation = generation;
              state.pending_action = null; delete state.route_execution; delete state.direction_context; state.tool_starts = {}; state.continuation_confirmed = false;
              state.phase = 'WORKER'; delete state.last_error; delete state.recovery_condition; delete state.recovery_window;
              state.host = { ...state.host, desktop_pid: Number.isInteger(event.callback_desktop_pid) ? event.callback_desktop_pid : state.host.desktop_pid, hook_effective: state.mode === 'live' && state.host.source === 'native-desktop', reason: 'Automatic native lifecycle receipt re-bound the original A.' };
              controller = { ...controller, plugin_root: callbackPluginRoot, bundle_sha256: callbackBundleSha, run_generation: generation };
              state.controller = controller;
              const reboundBinding = { ...state.binding };
              delete reboundBinding.operation;
              state.binding = { ...reboundBinding, status: 'BOUND', bound_at: new Date().toISOString(), accepted_receipt: { occurrence_id: String(message.payload?.adapter_occurrence_id ?? randomUUID()), issued_at: new Date().toISOString(), generation } };
              if (state.recovery_plan) { state.recovery_plan.generation = generation; state.recovery_plan.status = 'running'; state.recovery_plan.next_retry_at = null; if (state.recovery_plan.owner) state.recovery_plan.owner = { ...state.recovery_plan.owner, generation }; }
              store.event(state, 'main_session_rebind_receipt', { main_session_id: event.session_id, task_version: state.task_version, run_generation: generation, hook_event_name: event.hook_event_name, host_source: state.host.source, automatic: true, callback_plugin_root: callbackPluginRoot, callback_bundle_sha256: callbackBundleSha });
              store.save(state);
            } else {
              cancelActive('Native host restarted or installed plugin changed.');
              rearmBinding('Native host restarted or installed plugin changed; awaiting a trusted lifecycle receipt from the original A.', event.callback_desktop_pid);
              setImmediate(shutdown); return {};
            }
          }
          if (event.run_generation != null && event.run_generation !== state.run_generation) return {};
          if (event.hook_event_name === 'Stop') {
            const occurrence = message.payload?.adapter_occurrence_id;
            if (typeof occurrence !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(occurrence)) throw new Error('Stop adapter occurrence identity is invalid.');
            if (state.accepted_stop_occurrences?.includes(occurrence)) throw new Error('Stop adapter occurrence was already accepted; replay is invalid and must not replace its original hook.');
            if (active) throw new Error('Another Stop occurrence is pending; this request is invalid and cannot allow its hook to stop.');
          }
          if (event.hook_event_name !== 'Stop' && typeof event.event_id === 'string') {
            if (state.processed_event_ids?.includes(event.event_id)) return {};
            state.processed_event_ids = [...(state.processed_event_ids ?? []), event.event_id];
          }
          if (event.hook_event_name === 'Interrupt') { pause('user'); setImmediate(shutdown); return {}; }
          if (event.hook_event_name === 'UserPromptSubmit') {
            accrue(); state.input_epoch = (state.input_epoch ?? 0) + 1;
            state.latest_human_input = { prompt: String(redact(typeof event.prompt === 'string' ? event.prompt : '')).slice(0, 8_000), at: new Date().toISOString(), input_epoch: state.input_epoch };
            state.pending_action = null; delete state.route_execution; delete state.direction_context; delete state.recovery_prompt; state.continuation_confirmed = false; state.tool_starts = {};
            if (state.status === 'ACTIVE' && state.phase !== 'RECOVERING') state.phase = 'WORKER';
            store.save(state); cancelActive('A newer human input invalidated the pending judgment.'); return {};
          }
          if (event.hook_event_name === 'Stop' && state.status === 'ACTIVE' && state.phase !== 'RECOVERING' && !state.pause_reason) {
            state.accepted_stop_occurrences = [...(state.accepted_stop_occurrences ?? []), message.payload.adapter_occurrence_id];
            delete state.recovery_prompt;
            store.save(state); // Persist admission before any asynchronous C.
          }
          accrue(); store.save(state);
          const result = handleLifecycle(event, state.host, pluginRoot, message.payload.adapter_occurrence_id);
          state = readJson(path) as MainSessionState;
          if (!result.stop_request || state.status !== 'ACTIVE' || state.phase === 'RECOVERING') return {};
          const request = result.stop_request;
          const outcome = captureRouteOutcome(state, buildMainSessionSnapshot(state, request, store.events()), request.stop_attempt_id, true);
          if (outcome) store.event(state, 'route_outcome', outcome);
          discoverLocalRoutes(state);
          initializeHttpRouteProbe(state, path);
          store.save(state);
          if (fixture?.transport?.timeout_ms != null) request.deadline_at = new Date(Date.now() + Number(fixture.transport.timeout_ms)).toISOString();
          const current = { abort: new AbortController(), request, socket, valid: true, epoch: state.input_epoch ?? 0 }; active = current;
          state.stop_transport = { request, outcome: 'pending' }; state.phase = 'JUDGE'; store.save(state);
          const invalidate = (reason: string) => {
            if (!current.valid) return; current.valid = false; if (active === current) active = null; current.abort.abort();
            state.stop_transport = { request, outcome: 'unknown', error: reason }; recover(reason); store.save(state);
          };
          const disconnected = () => { if (!socket.writableFinished) invalidate('Hook disconnected before its result was returned; delivery is unknown.'); };
          // A peer FIN can leave a pending writable half open until a response;
          // invalidate at readable end, not only the later full socket close.
          socket.once('end', disconnected);
          socket.once('close', disconnected);
          const timer = setTimeout(() => { invalidate('Stop hook deadline elapsed; late supervisor output is invalid.'); socket.end('{}\n'); }, Math.max(1, Date.parse(request.deadline_at) - Date.now()));
          try {
            const valid = () => {
              // The controller owns the task lock for the entire Stop. Read
              // the in-process checkpoint here instead of reopening
              // state.json while C/verification is active; Windows readers
              // can otherwise remain in a sharing violation indefinitely.
              const saved = state;
              return current.valid && active === current && !closing && !socket.destroyed && saved.status === 'ACTIVE' && saved.phase !== 'RECOVERING' && saved.run_generation === request.run_generation && saved.task_version === request.task_version && saved.contract_sha256 === request.contract_sha256 && saved.contract_sha256 === contractHash(saved.task) && (saved.input_epoch ?? 0) === current.epoch && saved.last_stop?.stop_attempt_id === request.stop_attempt_id && Date.now() < Date.parse(request.deadline_at);
            };
            const guarded = new class extends Store {
              override save(candidate: import('./types.js').State): void {
                if (!valid()) throw new Error('Obsolete judgment checkpoint rejected.');
                state.phase = candidate.phase;
                if (candidate.judge_thread_ids) state.judge_thread_ids = candidate.judge_thread_ids;
                state.codex_version = candidate.codex_version;
                super.save(state);
              }
            }(path);
            let decision: Decision;
            let outputFailures = 0;
            if (state.mode === 'simulated' && !fixture?.app_server_argv && !fixture?.transport?.decision) throw new Error('Missing explicit simulated supervisor adapter; configure it before explicit resume.');
            while (true) {
              try { decision = await evaluateStop(structuredClone(state), request, fixture, current.abort.signal, guarded); break; }
              catch (error) {
                if (!valid() || current.abort.signal.aborted) return {};
                const classification = classifyRecoveryError(error);
                state.recovery_failures = redact(recordRecoveryFailure((state.recovery_failures ?? []) as RecoveryFailure[], error)) as RecoveryFailure[];
                const backoff = nextBackoff((state.retry.attempt ?? 0) + 1);
                state.retry = { kind: classification.kind, attempt: backoff.attempt, next_at: backoff.next_at };
                store.save(state); store.event(state, 'main_session_retry', { ...classification, ...backoff, stop_attempt_id: request.stop_attempt_id });
                if (!classification.recoverable) throw error;
                if (++outputFailures >= 3) {
                  decision = plannerFailureFallback(buildMainSessionSnapshot(state, request, store.events()), 'C failed three bounded output attempts; gather source-linked route facts.');
                  store.event(state, 'judge_inventory_fallback', { failures: outputFailures, stop_attempt_id: request.stop_attempt_id, decision });
                  break;
                }
                const configuredDelay = state.mode === 'simulated' && Array.isArray(fixture?.recovery_delays_ms) ? Number(fixture.recovery_delays_ms[Math.min(outputFailures - 1, fixture.recovery_delays_ms.length - 1)]) : backoff.delay_seconds * 1000;
                await delay(Math.min(Math.max(0, configuredDelay), Math.max(1, Date.parse(request.deadline_at) - Date.now())), undefined, { signal: current.abort.signal });
              }
            }
            if (!valid()) return {};
            accrue();
            const limits = reachedLimits(state.task.limits, state);
            if (limits.time || (decision.action === 'CONTINUE' && limits.turns)) { pause('user_limit'); return {}; }
            state.retry = { kind: null, attempt: 0, next_at: null };
            state.last_decision = redact(decision) as Decision;
            state.host.hook_effective = state.mode === 'live' && state.host.source === 'native-desktop';
            state.host.reason = 'Correlated synchronous Stop judged and returned; actual main-session continuation requires subsequent matching activity.';
            if (decision.action !== 'CONTINUE') {
              // Do not let the 250 ms checkpoint writer race the terminal
              // checkpoint. On Windows that race can keep the state file in
              // a sharing window long enough for a valid DONE judgment to be
              // misclassified as an unknown recovery.
              clearInterval(checkpointTimer);
              state.status = decision.action; state.phase = 'IDLE'; state.pending_action = null;
              if (decision.action === 'DONE') cancelRecovery(state, 'done');
              state.stop_transport = { request, outcome: 'returned' };
              if (decision.action === 'DONE') state.binding.status = 'RELEASED';
              store.save(state);
              store.event(state, 'main_session_terminal', { action: decision.action, stop_attempt_id: request.stop_attempt_id, reason: decision.reason, external: decision.external });
              // Allow the active synchronous hook response to flush before closing B.
              socket.once('finish', () => setImmediate(shutdown));
              return {};
            }
            const delivery = randomUUID();
            const correlation = prepareRouteExecution(state, decision, buildMainSessionSnapshot(state, request, store.events()), delivery, request.stop_attempt_id);
            state.pending_action = { ...correlation, delivery_id: delivery, source_turn_id: request.turn_id, task_version: request.task_version, message: decision.next_message, stage: 'prepared', target_turn_id: null };
            store.event(state, 'send_prepared', { ...correlation, delivery_id: delivery, source_turn_id: request.turn_id, message: decision.next_message, transport: 'native-stop' });
            state.pending_action.stage = 'sent';
            store.event(state, 'send_attempted', { ...correlation, delivery_id: delivery, transport: 'native-stop' });
            state.direction_context = { delivery_id: delivery, at: new Date().toISOString(), run_generation: state.run_generation, input_epoch: state.input_epoch ?? 0, contract_sha256: state.contract_sha256 };
            state.continuation_confirmed = false; state.phase = 'WORKER'; delete state.recovery_window;
            state.stop_transport = { request, outcome: 'returned', delivery_id: delivery }; store.save(state);
            store.event(state, 'stop_hook_direction_returned', { ...correlation, stop_attempt_id: request.stop_attempt_id, delivery_id: delivery, session_id: request.session_id, execution_confirmed: false });
            scheduleMainSessionRecoveryPrompt(path, pluginRoot, fixturePath, state, state.pending_action.message, request.turn_id);
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
    // Publish an owned cancelable handle before the potentially slow external
    // model preflight. Reachability still does not mean ACTIVE or hook effective.
    state.controller = controller; store.save(state);
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    await preflightSupervisor(state, fixture, startupAbort.signal);
    const supervisorVersion = state.codex_version;
    state = readJson(path) as MainSessionState;
    if (closing || state.pause_reason || state.status === 'INTERRUPTED' || state.recovery_plan?.cancellation_boundary || (state.controller_startup_deadline && Date.now() >= Date.parse(state.controller_startup_deadline))) throw new Error('B startup canceled or deadline expired; explicit recovery required.');
    state.codex_version = supervisorVersion;
    state.controller = controller; state.status = 'ACTIVE'; state.phase = 'WORKER'; state.continuation_confirmed = false; state.active_checkpoint_at = new Date().toISOString();
    delete state.recovery_condition;
    delete state.recovery_window;
    delete state.recovery_interruption;
    state.host.reason = 'Bound controller reachable; Stop continuation and actual main-session activity still require evidence.';
    store.save(state); store.event(state, 'main_session_controller_started', { controller_id: id, main_session_id: state.main_session_id, pid: process.pid });
    checkpointTimer = setInterval(() => {
      // A Stop owns the checkpoint while judge/verification is in flight.
      // Repeated heartbeat renames during that window can keep Windows
      // readers in a sharing violation and strand a valid terminal decision.
      if (closing) return;
      const checkpoint = readJson(path) as MainSessionState;
      if (checkpoint.status === 'INTERRUPTED') { state = checkpoint; shutdown(); return; }
      if (active) return;
      state = checkpoint;
      accrue();
      const hostPid = (state.host as typeof state.host & { desktop_pid?: number }).desktop_pid;
      if (state.status === 'ACTIVE' && state.phase !== 'RECOVERING' && hostPid && processAbsent(hostPid)) {
        cancelActive('Desktop owner exited.');
        rearmBinding('Desktop owner exited; awaiting a trusted lifecycle receipt from the original A.');
        setImmediate(shutdown);
      }
      if (state.status === 'ACTIVE' && reachedLimits(state.task.limits, state).time) pause('user_limit');
      else store.save(state);
    }, 250);
    process.send?.({ ready: true, controller_id: id }); if (process.connected) process.disconnect();
    await new Promise<void>((done) => server!.once('close', done));
  } catch (error) {
    if (!closing && state.binding.status === 'BOUND' && state.main_session_id && state.status !== 'DONE' && state.status !== 'INTERRUPTED') {
      rearmBinding(String(redact((error as Error).message)));
    } else if (!closing && state.status !== 'INTERRUPTED' && state.controller?.id === id) {
      state.phase = 'RECOVERING'; state.host.hook_effective = false; state.last_error = String(redact((error as Error).message));
      state.recovery_condition = { kind: 'controller_startup', message: state.last_error, resume_when: 'Resolve the startup failure, then wait for the persisted recovery plan.' };
      armRecovery(state, state.recovery_condition);
      state.controller.lifecycle = 'exited'; store.save(state);
    }
    server?.close(); for (const socket of sockets) socket.end();
    throw error;
  } finally {
    clearInterval(checkpointTimer);
    if (lease !== undefined) {
      // This process created the exclusive lease and no recovery can reclaim
      // it while the controller is alive. Reading the lease again during
      // shutdown is both unnecessary and vulnerable to Windows sharing
      // violations, so release the owned path directly after closing it.
      closeSync(lease);
      try { unlinkSync(leasePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    recoveryOwner?.release();
    store.release();
    if (process.platform !== 'win32' && existsSync(controller.endpoint)) unlinkSync(controller.endpoint);
  }
}
