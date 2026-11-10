import { randomUUID } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { codexCommand, connectWorker, type Rpc } from './transport.js';
import { canonicalPath, readJson, type MainSessionState } from './main-session.js';
import { Store } from './store.js';
import { routeCorrelation } from './route-execution.js';
import { interruptRecovery } from './recovery-coordinator.js';
import { redact } from './redact.js';

type RecoveryPrompt = NonNullable<MainSessionState['recovery_prompt']>;

class RecoverySetupError extends Error {}

async function verifyRecoveryHooks(rpc: Rpc, workspace: string, pluginRoot: string): Promise<void> {
  const result = await rpc.request<any>('hooks/list', { cwds: [workspace] });
  const source = canonicalPath(resolve(pluginRoot, 'hooks/hooks.json'));
  const hooks = (result?.data ?? []).flatMap((entry: any) => entry.hooks ?? []).filter((hook: any) => typeof hook.sourcePath === 'string' && canonicalPath(hook.sourcePath) === source);
  for (const name of ['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop', 'interrupt']) {
    const hook = hooks.find((entry: any) => entry.eventName === name);
    if (!hook) throw new RecoverySetupError('Codex 未加载 Needs Forever hook；请检查插件是否已启用并重新加载宿主。');
    if (!hook.enabled) throw new RecoverySetupError('Needs Forever hook 已被禁用；请在 Codex 设置 → Hooks 中启用。');
    if (hook.trustStatus !== 'trusted') throw new RecoverySetupError('Needs Forever hook 尚未信任；请在 Codex 设置 → Hooks 中审阅并信任。');
  }
}

/** The global host also drives recovery when no B/coordinator is alive. */
export function driveNativeRecovery(path: string, pluginRoot: string, fixturePath?: string): void {
  const state = readJson(path) as MainSessionState;
  if (state.status !== 'ACTIVE' || state.control_mode !== 'main-session' || state.binding?.status !== 'PENDING_NATIVE_HOOK' || state.binding.operation !== 'rebind') return;
  if (state.recovery_window && Date.parse(state.recovery_window.deadline_at) <= Date.now()) return;
  const prompt = state.recovery_prompt;
  if (prompt?.kind === 'native_rebind' && prompt.run_generation === state.run_generation) {
    // The helper owns the worker turn until completion, not just its RPC ack.
    try {
      const owner = JSON.parse(readFileSync(`${path}.recovery-prompt.lock`, 'utf8')) as { pid: number };
      try { process.kill(owner.pid, 0); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    } catch { /* No live delivery helper; reconcile the saved delivery. */ }
    if (Date.parse(prompt.due_at) + 30_000 > Date.now()) return;
    // Keep the delivery id for uncertain outcomes; the helper reconciles it
    // against original-A history before considering any new send.
    spawnPrompt(path, pluginRoot, fixturePath, state.task.workspace);
    return;
  }
  scheduleNativeRebindPrompt(path, pluginRoot, fixturePath, state, state.recovery_plan?.reason.message ?? '原始 A 的监督绑定已失效。');
}

function spawnPrompt(path: string, pluginRoot: string, fixturePath: string | undefined, workspace: string): void {
  const script = resolve(pluginRoot, 'scripts/recovery-prompt.mjs');
  if (!existsSync(script)) throw new Error('Installed recovery prompt entry point is missing.');
  const child = spawn(process.execPath, [script, path, ...(fixturePath ? ['--test-fixture', fixturePath] : [])], { cwd: workspace, detached: true, windowsHide: true, stdio: 'ignore' });
  child.once('error', () => { const state = readJson(path) as MainSessionState; log(path, state, 'main_session_recovery_prompt_failed', { error: 'Unable to start the installed recovery helper.' }); });
  child.unref();
}

function promptDelayMs(fixturePath?: string): number {
  const value = Number(fixturePath ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as { recovery_prompt_delay_ms?: unknown }).recovery_prompt_delay_ms : process.env.NF_RECOVERY_PROMPT_DELAY_MS ?? 3_000);
  return Number.isFinite(value) && value >= 0 ? value : 3_000;
}

/** Schedule an auditable prompt to the original A when native binding was
 * invalidated. The prompt only triggers A's native UserPromptSubmit receipt;
 * it never changes the task contract or fabricates a binding. */
export function scheduleNativeRebindPrompt(path: string, pluginRoot: string, fixturePath: string | undefined, state: MainSessionState, reason: string): boolean {
  if (state.control_mode !== 'main-session' || !state.main_session_id || state.status !== 'ACTIVE' || state.binding.status !== 'PENDING_NATIVE_HOOK' || state.binding.operation !== 'rebind') return false;
  if (state.recovery_window && Date.parse(state.recovery_window.deadline_at) <= Date.now()) return false;
  const existing = state.recovery_prompt;
  if (existing?.kind === 'native_rebind' && existing.run_generation === state.run_generation) return false;
  const deliveryId = randomUUID();
  const delayMs = promptDelayMs(fixturePath);
  const message = `NF 自动恢复绑定：原始 A 的监督绑定已失效。请继续当前任务，保持原目标和授权，不要重复旧方向；这条消息用于重新建立本机监督绑定。\n\n原因为：${reason}`;
  state.recovery_prompt = { plugin_root: pluginRoot, kind: 'native_rebind', delivery_id: deliveryId, source_turn_id: state.recovery_parent?.turn_id ?? null, task_version: state.task_version, run_generation: state.run_generation, message, due_at: new Date(Date.now() + delayMs).toISOString() };
  const store = new Store(path);
  store.save(state);
  store.event(state, 'main_session_recovery_prompt_scheduled', { kind: 'native_rebind', delivery_id: deliveryId, main_session_id: state.main_session_id, due_at: state.recovery_prompt.due_at, reason: 'NF 自动推动原始 A 产生新的 native lifecycle receipt。', ...(state.recovery_parent?.stop_attempt_id ? { stop_attempt_id: state.recovery_parent.stop_attempt_id } : {}), ...(state.recovery_parent?.turn_id ? { turn_id: state.recovery_parent.turn_id } : {}) });
  spawnPrompt(path, pluginRoot, fixturePath, state.task.workspace);
  return true;
}

function fixtureCommand(fixturePath: string | undefined, state: MainSessionState): string[] {
  if (!fixturePath) {
    const binary = state.host.desktop_binary;
    if (state.host.source === 'native-desktop' && binary && /[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][^\\/]+[\\/]codex\.exe$/i.test(binary) && existsSync(binary)) return [binary];
    return codexCommand();
  }
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { app_server_argv?: unknown };
  if (!Array.isArray(fixture.app_server_argv) || !fixture.app_server_argv.length || !fixture.app_server_argv.every((value) => typeof value === 'string' && value.length)) {
    throw new Error('Recovery prompt fixture is missing app_server_argv.');
  }
  return fixture.app_server_argv as string[];
}

function eventPath(statePath: string): string { return resolve(resolve(statePath, '..'), 'events.jsonl'); }

function hasDeliveryEvent(statePath: string, deliveryId: string, types: Set<string>): boolean {
  if (!existsSync(eventPath(statePath))) return false;
  return readFileSync(eventPath(statePath), 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      return types.has(String(event.type ?? '')) && event.delivery_id === deliveryId;
    } catch { return false; }
  });
}

function acquireLease(statePath: string): { release: () => void } | null {
  const path = `${statePath}.recovery-prompt.lock`;
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
      if (Number.isInteger(owner.pid)) { try { process.kill(owner.pid!, 0); return null; } catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') return null; } }
      unlinkSync(path);
      fd = openSync(path, 'wx', 0o600);
    } catch { return null; }
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, state_path: statePath, at: new Date().toISOString() }));
  closeSync(fd);
  let released = false;
  return { release: () => { if (released) return; released = true; try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } };
}

function currentPrompt(statePath: string): { state: MainSessionState; prompt: RecoveryPrompt } | null {
  try {
    const state = readJson(statePath) as MainSessionState;
    const prompt = state.recovery_prompt;
    if (!prompt || state.status !== 'ACTIVE' || state.control_mode !== 'main-session' || !state.main_session_id) return null;
    if (state.recovery_window && Date.parse(state.recovery_window.deadline_at) <= Date.now()) return null;
    if (state.task_version !== prompt.task_version || state.run_generation !== prompt.run_generation) return null;
    if (prompt.kind !== 'native_rebind' && (!state.pending_action || state.pending_action.delivery_id !== prompt.delivery_id || state.pending_action.message !== prompt.message || state.pending_action.plan_id !== prompt.plan_id || state.pending_action.route_id !== prompt.route_id || state.pending_action.source_stop_attempt_id !== prompt.source_stop_attempt_id || state.pending_action.stage === 'confirmed' || state.continuation_confirmed)) return null;
    if (prompt.kind === 'native_rebind' && (state.binding.status !== 'PENDING_NATIVE_HOOK' || state.binding.operation !== 'rebind')) return null;
    return { state, prompt };
  } catch { return null; }
}

function log(statePath: string, state: MainSessionState, type: string, details: Record<string, unknown> = {}): void {
  const parent = state.last_stop ?? state.recovery_parent;
  const prompt = state.recovery_prompt;
  const stopId = prompt?.source_stop_attempt_id ?? parent?.stop_attempt_id;
  const turnId = prompt?.source_turn_id ?? parent?.turn_id;
  new Store(statePath).event(state, type, { role: 'worker', source: 'nf', transport: 'codex-app-server', ...routeCorrelation(prompt), ...(stopId ? { stop_attempt_id: stopId } : {}), ...(turnId ? { turn_id: turnId } : {}), ...details });
}

function matchingClientId(turns: unknown[], deliveryId: string): string | null {
  for (const value of turns) {
    if (!value || typeof value !== 'object') continue;
    const turn = value as { id?: unknown; items?: unknown[] };
    for (const item of turn.items ?? []) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item as { type?: unknown; clientId?: unknown };
      if (candidate.type === 'userMessage' && candidate.clientId === deliveryId) return typeof turn.id === 'string' ? turn.id : null;
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
export async function deliverMainSessionRecoveryPrompt(statePath: string, fixturePath?: string): Promise<void> {
  const initial = currentPrompt(statePath);
  if (!initial) return;
  const dueAt = Date.parse(initial.prompt.due_at);
  if (Number.isFinite(dueAt) && dueAt > Date.now()) await delay(dueAt - Date.now());
  const current = currentPrompt(statePath);
  if (!current) return;
  const lease = acquireLease(statePath);
  if (!lease) return;
  const { state, prompt } = current;
  const abort = new AbortController();
  const remaining = state.recovery_window ? Date.parse(state.recovery_window.deadline_at) - Date.now() : 30_000;
  const timer = setTimeout(() => abort.abort(), Math.max(1, Math.min(30_000, remaining)));
  let monitor: NodeJS.Timeout | undefined;
  try {
    log(statePath, state, 'main_session_recovery_prompt_attempted', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, message: prompt.message, task_version: prompt.task_version, run_generation: prompt.run_generation });
    const connection = await connectWorker(fixtureCommand(fixturePath, state), state.task.workspace, abort.signal);
    try {
      const pluginRoot = prompt.plugin_root ?? state.controller?.plugin_root;
      if (pluginRoot) await verifyRecoveryHooks(connection.rpc, state.task.workspace, pluginRoot);
      const resumed = await connection.rpc.request<any>('thread/resume', { threadId: state.main_session_id, cwd: state.task.workspace, excludeTurns: false });
      if (!resumed?.thread || resumed.thread.id !== state.main_session_id) throw new Error('Recovery adapter resumed a different thread; no prompt was sent.');
      const turns = Array.isArray(resumed.thread.turns) ? resumed.thread.turns : [];
      const existing = matchingClientId(turns, prompt.delivery_id);
      if (existing) {
        log(statePath, state, 'main_session_recovery_prompt_acknowledged', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, target_turn_id: existing, reconciled: true });
        return;
      }
      if (hasDeliveryEvent(statePath, prompt.delivery_id, new Set(['main_session_recovery_prompt_sent']))) {
        log(statePath, state, 'main_session_recovery_prompt_deferred', { delivery_id: prompt.delivery_id, reason: 'Previous send outcome is uncertain; no duplicate message was sent.' });
        return;
      }
      if (turns.some((turn: any) => turn?.status === 'inProgress')) {
        log(statePath, state, 'main_session_recovery_prompt_deferred', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, reason: 'Original A already has an in-progress turn.' });
        return;
      }
      const latest = currentPrompt(statePath);
      if (!latest || latest.prompt.delivery_id !== prompt.delivery_id || latest.prompt.message !== prompt.message) return;
      log(statePath, state, 'main_session_recovery_prompt_sent', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, message: prompt.message });
      const response = await connection.rpc.request<any>('turn/start', { threadId: state.main_session_id, clientUserMessageId: prompt.delivery_id, input: [{ type: 'text', text: prompt.message, text_elements: [] }] });
      const targetTurnId = typeof response?.turn?.id === 'string' ? response.turn.id : null;
      log(statePath, state, 'main_session_recovery_prompt_acknowledged', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, target_turn_id: targetTurnId, reconciled: false });
      if (!targetTurnId) throw new Error('Recovery turn acknowledgement has no turn id.');
      clearTimeout(timer);
      // A belongs to this app-server until the turn finishes. Closing stdio
      // after turn/start used to interrupt A before hooks could rebind it.
      monitor = setInterval(() => {
        try {
          const latest = readJson(statePath) as MainSessionState;
          if (latest.status === 'PAUSED' || latest.status === 'INTERRUPTED' || latest.task_version !== state.task_version || (latest.recovery_window && Date.parse(latest.recovery_window.deadline_at) <= Date.now())) abort.abort();
        } catch { abort.abort(); }
      }, 250);
      while (!abort.signal.aborted) {
        const event = await connection.rpc.next();
        const params = event.params as any;
        if (event.method === 'turn/completed' && params?.threadId === state.main_session_id && params?.turn?.id === targetTurnId) {
          log(statePath, state, 'main_session_recovery_turn_completed', { delivery_id: prompt.delivery_id, target_turn_id: targetTurnId, status: params.turn.status });
          break;
        }
      }
    } finally { await connection.rpc.close(); }
  } catch (error) {
    if (error instanceof RecoverySetupError) {
      const latest = currentPrompt(statePath);
      if (latest?.prompt.delivery_id === prompt.delivery_id) {
        interruptRecovery(latest.state, Date.now(), error.message);
        const store = new Store(statePath); store.save(latest.state);
        store.event(latest.state, 'recovery_interrupted', { reason: error.message, cause: 'hook_setup' });
      }
    } else {
      const latest = currentPrompt(statePath);
      if (latest?.prompt.delivery_id === prompt.delivery_id) {
        const reason = String(redact(error instanceof Error ? error.message : String(error)));
        latest.state.last_error = reason;
        latest.state.recovery_condition = { kind: 'recovery_transport', message: reason, resume_when: 'The provider recovery transport must become available before the recovery deadline.' };
        new Store(statePath).save(latest.state);
      }
    }
    log(statePath, state, 'main_session_recovery_prompt_failed', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, error: error instanceof Error ? error.message : String(error) });
  } finally { clearTimeout(timer); if (monitor) clearInterval(monitor); lease.release(); }
}
