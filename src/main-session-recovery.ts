import { randomUUID } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { codexCommand, connectWorker, type Rpc } from './transport.js';
import { canonicalPath, readJson, type MainSessionState } from './main-session.js';
import { Store } from './store.js';
import { routeCorrelation } from './route-execution.js';
import { extendRecoveryWindowForActiveWriter, interruptRecovery } from './recovery-coordinator.js';
import { redact } from './redact.js';

type RecoveryPrompt = NonNullable<MainSessionState['recovery_prompt']>;

class RecoverySetupError extends Error {}

/**
 * A native app-server can reject turn/start while the original A still owns
 * its writer.  This is a transient race, not a failed delivery and must not
 * overwrite the recovery checkpoint with a misleading error.  Keep retries
 * bounded by the existing recovery window (normally two minutes, with a
 * separately capped active-writer extension when the host proves that A is
 * still writing).
 */
const RECOVERY_PROMPT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

function isActiveWriterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /active writer|already has an active writer|writer is active|writer.*in progress|正在.*进行中|已有.*写入/i.test(message);
}

type WriterPreflight = 'in_progress' | 'idle' | 'unknown';

interface ThreadReadActivity {
  status: string | null;
  hasInProgressTurn: boolean;
}

/**
 * A read-only reconciliation for Codex's active-writer rejection.  Desktop
 * can leave a writer lock behind after the thread is already idle; this probe
 * distinguishes that host condition without mutating A or deleting a lock.
 */
async function readThreadActivity(rpc: Rpc, threadId: string): Promise<ThreadReadActivity | null> {
  try {
    const result = await rpc.request<any>('thread/read', { threadId, includeTurns: true });
    const thread = result?.thread;
    if (!thread || thread.id !== threadId) return null;
    const status = typeof thread.status?.type === 'string' ? thread.status.type : null;
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    return { status, hasInProgressTurn: turns.some((turn: any) => turn?.status === 'inProgress') };
  } catch {
    return null;
  }
}

function isStaleWriterObservation(observation: ThreadReadActivity | null): boolean {
  return !!observation && !observation.hasInProgressTurn && (observation.status === 'idle' || observation.status === 'notLoaded');
}

async function verifyRecoveryHooks(rpc: Rpc, workspace: string, pluginRoot: string): Promise<void> {
  const result = await rpc.request<any>('hooks/list', { cwds: [workspace] });
  const source = canonicalPath(resolve(pluginRoot, 'hooks/hooks.json'));
  const hooks = (result?.data ?? []).flatMap((entry: any) => entry.hooks ?? []).filter((hook: any) => typeof hook.sourcePath === 'string' && canonicalPath(hook.sourcePath) === source);
  for (const name of ['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop', 'interrupt']) {
    const hook = hooks.find((entry: any) => entry.eventName === name);
    if (!hook) throw new RecoverySetupError(`Codex 未加载 Needs Forever hook（${name}；期望 ${source}）；请检查插件是否已启用并重新加载宿主。`);
    if (!hook.enabled) throw new RecoverySetupError('Needs Forever hook 已被禁用；请在 Codex 设置 → Hooks 中启用。');
    if (hook.trustStatus !== 'trusted') throw new RecoverySetupError('Needs Forever hook 尚未信任；请在 Codex 设置 → Hooks 中审阅并信任。');
  }
}

/** The global host also drives recovery when no B/coordinator is alive. */
export function driveNativeRecovery(path: string, pluginRoot: string, fixturePath?: string): void {
  const state = readJson(path) as MainSessionState;
  if (state.status !== 'ACTIVE' || state.control_mode !== 'main-session' || !state.main_session_id) return;
  const prompt = state.recovery_prompt;
  if (prompt && prompt.run_generation === state.run_generation && (prompt.kind !== 'native_rebind' || (state.binding?.status === 'PENDING_NATIVE_HOOK' && state.binding.operation === 'rebind'))) {
    if (state.recovery_window && Date.parse(state.recovery_window.deadline_at) <= Date.now()) return;
    // The helper owns the worker turn until completion, not just its RPC ack.
    try {
      const owner = JSON.parse(readFileSync(`${path}.recovery-prompt.lock`, 'utf8')) as { pid: number };
      try { process.kill(owner.pid, 0); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    } catch { /* No live delivery helper; reconcile the saved delivery. */ }
    // `due_at` is advanced after every bounded deferral.  Older checkpoints
    // used a fixed thirty-second grace period; honoring the persisted due time
    // avoids both a busy loop and an unnecessary extra thirty-second stall.
    if (Date.parse(prompt.due_at) > Date.now()) return;
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
  child.once('error', () => {
    // A detached helper can fail after the caller has returned.  Never let a
    // state-read or audit-write failure become an uncaught exception in this
    // callback; the next global watchdog tick remains responsible for retry.
    try {
      const state = readJson(path) as MainSessionState;
      log(path, state, 'main_session_recovery_prompt_failed', { error: 'Unable to start the installed recovery helper.' });
    } catch { /* preserve the checkpoint and let the watchdog retry */ }
  });
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
  let unresolved = false;
  for (const line of readFileSync(eventPath(statePath), 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (types.has(String(event.type ?? '')) && event.delivery_id === deliveryId) unresolved = true;
      // A known active-writer rejection proves that the preceding `sent`
      // audit was a preflight marker, not an accepted provider delivery. It
      // may therefore be retried with the same id. Unknown send outcomes keep
      // the conservative no-duplicate behavior (retryable=false).
      if (event.type === 'main_session_recovery_prompt_deferred' && event.delivery_id === deliveryId && event.retryable === true) unresolved = false;
    } catch { /* ignore malformed historical lines */ }
  }
  return unresolved;
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
  const mainSessionId = state.main_session_id;
  if (!mainSessionId) { lease.release(); return; }
  const abort = new AbortController();
  const remaining = state.recovery_window ? Date.parse(state.recovery_window.deadline_at) - Date.now() : 30_000;
  const timer = setTimeout(() => abort.abort(), Math.max(1, Math.min(30_000, remaining)));
  let monitor: NodeJS.Timeout | undefined;
  let writerPreflight: WriterPreflight = 'unknown';
  try {
    log(statePath, state, 'main_session_recovery_prompt_attempted', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, message: prompt.message, task_version: prompt.task_version, run_generation: prompt.run_generation });
    const connection = await connectWorker(fixtureCommand(fixturePath, state), state.task.workspace, abort.signal);
    try {
      const pluginRoot = prompt.plugin_root ?? state.controller?.plugin_root;
      if (pluginRoot) await verifyRecoveryHooks(connection.rpc, state.task.workspace, pluginRoot);
      let resumed: any;
      try {
        resumed = await connection.rpc.request<any>('thread/resume', { threadId: mainSessionId, cwd: state.task.workspace, excludeTurns: false });
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        const activity = await readThreadActivity(connection.rpc, mainSessionId);
        // A few Codex hosts report the thread itself as `active` even after
        // its turn history is idle.  Once the same delivery has already
        // survived one retry, an active-writer rejection with no
        // in-progress turn is the legacy stale-writer evidence we already
        // persist and bound.  Keep this fallback for those hosts while the
        // explicit idle/notLoaded classification above remains preferred.
        const repeatedIdleWriter = typeof prompt.retry_attempt === 'number'
          && Number.isInteger(prompt.retry_attempt)
          && prompt.retry_attempt >= 1
          && !!activity
          && !activity.hasInProgressTurn;
        if (isStaleWriterObservation(activity)) {
          const status = activity?.status ?? 'unknown';
          deferRecoveryPrompt(
            statePath,
            prompt.delivery_id,
            `Codex thread/read 显示原始 A 为 ${status} 且没有进行中的回合，但 thread/resume 仍被 active writer 拒绝；疑似宿主写锁未释放。NF 不会删除锁或终止 Codex，需重启 Codex 宿主后再恢复。`,
            error,
            true,
            'recovery_stale_writer',
            'unknown',
            false,
          );
        } else if (repeatedIdleWriter) {
          deferRecoveryPrompt(
            statePath,
            prompt.delivery_id,
            'Codex 宿主的 thread 历史已没有进行中的回合，但 thread/resume 仍报告 active writer；疑似宿主 writer 锁残留，NF 将继续有限重试并记录诊断。',
            error,
            true,
            'recovery_stale_active_writer',
            'idle',
          );
        } else {
          deferRecoveryPrompt(statePath, prompt.delivery_id, '原始 A 当前仍有进行中的回合，NF 等待其完成后自动重试。', error);
        }
        return;
      }
      if (!resumed?.thread || resumed.thread.id !== state.main_session_id) throw new Error('Recovery adapter resumed a different thread; no prompt was sent.');
      const turns = Array.isArray(resumed.thread.turns) ? resumed.thread.turns : [];
      const existing = matchingClientId(turns, prompt.delivery_id);
      if (existing) {
        log(statePath, state, 'main_session_recovery_prompt_acknowledged', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, target_turn_id: existing, reconciled: true });
        return;
      }
      if (hasDeliveryEvent(statePath, prompt.delivery_id, new Set(['main_session_recovery_prompt_sent']))) {
        deferRecoveryPrompt(statePath, prompt.delivery_id, '上一次发送结果不确定，NF 不重复发送；确认原始 A 历史后自动重试。', undefined, false);
        return;
      }
      writerPreflight = turns.some((turn: any) => turn?.status === 'inProgress') ? 'in_progress' : 'idle';
      if (writerPreflight === 'in_progress') {
        deferRecoveryPrompt(statePath, prompt.delivery_id, '原始 A 当前已有进行中的回合，NF 将在其结束后自动重试。');
        return;
      }
      const latest = currentPrompt(statePath);
      if (!latest || latest.prompt.delivery_id !== prompt.delivery_id || latest.prompt.message !== prompt.message) return;
      log(statePath, state, 'main_session_recovery_prompt_sent', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, message: prompt.message });
      let response: any;
      try {
        response = await connection.rpc.request<any>('turn/start', { threadId: state.main_session_id, clientUserMessageId: prompt.delivery_id, input: [{ type: 'text', text: prompt.message, text_elements: [] }] });
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        const activity = await readThreadActivity(connection.rpc, mainSessionId);
        const repeatedIdleWriter = typeof prompt.retry_attempt === 'number'
          && Number.isInteger(prompt.retry_attempt)
          && prompt.retry_attempt >= 1
          && !!activity
          && !activity.hasInProgressTurn;
        if (isStaleWriterObservation(activity)) {
          const status = activity?.status ?? 'unknown';
          deferRecoveryPrompt(
            statePath,
            prompt.delivery_id,
            `Codex thread/read 显示原始 A 为 ${status} 且没有进行中的回合，但 turn/start 仍被 active writer 拒绝；疑似宿主写锁未释放。NF 不会删除锁或终止 Codex，需重启 Codex 宿主后再恢复。`,
            error,
            true,
            'recovery_stale_writer',
            'idle',
            false,
          );
        } else if (repeatedIdleWriter) {
          deferRecoveryPrompt(
            statePath,
            prompt.delivery_id,
            'Codex 宿主的 thread 历史已没有进行中的回合，但 turn/start 仍报告 active writer；疑似宿主 writer 锁残留，NF 将继续有限重试并记录诊断。',
            error,
            true,
            'recovery_stale_active_writer',
            'idle',
          );
        } else {
          deferRecoveryPrompt(statePath, prompt.delivery_id, '原始 A 当前仍有进行中的回合，NF 等待其完成后自动重试。', error);
        }
        return;
      }
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
    } else if (isActiveWriterError(error)) {
      // Codex -32600 / "already has an active writer" means A is still
      // running.  Preserve the Stop and prompt identities, clear the stale
      // failure text, and record an auditable bounded retry instead.
      const retryAttempt = Number.isInteger(prompt.retry_attempt) ? (prompt.retry_attempt as number) : 0;
      const staleWriter = writerPreflight === 'idle' && retryAttempt >= 1;
      deferRecoveryPrompt(
        statePath,
        prompt.delivery_id,
        staleWriter
          ? 'Codex 宿主的 thread 历史已没有进行中的回合，但 turn/start 仍报告 active writer；疑似宿主 writer 锁残留，NF 将继续有限重试并记录诊断。'
          : '原始 A 当前仍有进行中的回合，NF 等待其结束后自动重试。',
        error,
        true,
        staleWriter ? 'recovery_stale_active_writer' : 'recovery_active_writer',
        writerPreflight,
      );
    } else {
      const latest = currentPrompt(statePath);
      if (latest?.prompt.delivery_id === prompt.delivery_id) {
        const reason = String(redact(error instanceof Error ? error.message : String(error)));
        latest.state.last_error = reason;
        latest.state.recovery_condition = { kind: 'recovery_transport', message: reason, resume_when: 'The provider recovery transport must become available before the recovery deadline.' };
        new Store(statePath).save(latest.state);
      }
    }
    if (!isActiveWriterError(error)) {
      log(statePath, state, 'main_session_recovery_prompt_failed', { delivery_id: prompt.delivery_id, main_session_id: state.main_session_id, error: error instanceof Error ? error.message : String(error) });
    }
  } finally { clearTimeout(timer); if (monitor) clearInterval(monitor); lease.release(); }
}

/**
 * Persist a single retry schedule for a prompt that could not be delivered
 * because A was still writing (or because the preflight observed an active
 * turn).  The helper owns the same delivery id across retries, so no duplicate
 * prompt can be created, and the recovery deadline remains the hard stop.
 */
function deferRecoveryPrompt(statePath: string, deliveryId: string, reason: string, error?: unknown, retryable = true, conditionKind = 'recovery_active_writer', writerPreflight: WriterPreflight = 'unknown', extendActiveWriterWindow = true): void {
  try {
    const initial = currentPrompt(statePath);
    if (!initial?.prompt || initial.prompt.delivery_id !== deliveryId) return;
    const store = new Store(statePath);
    const latest = currentPrompt(statePath);
    if (!latest?.prompt || latest.prompt.delivery_id !== deliveryId) return;
    const previousAttempt = Number.isInteger(latest.prompt.retry_attempt) ? latest.prompt.retry_attempt! : 0;
    const retryAttempt = previousAttempt + 1;
    const delayMs = RECOVERY_PROMPT_RETRY_DELAYS_MS[Math.min(retryAttempt - 1, RECOVERY_PROMPT_RETRY_DELAYS_MS.length - 1)] ?? RECOVERY_PROMPT_RETRY_DELAYS_MS.at(-1)!;
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    const hadActiveWriterCap = latest.state.recovery_window?.active_writer_capped_at;
    const activeWriterWindow = extendActiveWriterWindow ? extendRecoveryWindowForActiveWriter(latest.state, Date.now(), delayMs) : null;
    latest.prompt.retry_attempt = retryAttempt;
    latest.prompt.due_at = retryAt;
    latest.state.recovery_condition = {
      kind: conditionKind,
      message: reason,
      resume_when: conditionKind === 'recovery_stale_active_writer'
        ? '宿主应释放残留 writer；NF 将按退避时间有限重试并保留诊断，仍未恢复会明确标记为中断。'
        : '原始 A 当前回合结束后，NF 将按退避时间自动重试；active-writer 最多延长至首次证据后 10 分钟，仍未恢复会明确标记为中断。',
    };
    // An active writer is expected while A is finishing.  Do not let a stale
    // transport error make NFG claim that the task is permanently failing.
    delete latest.state.last_error;
    // Recovery helpers intentionally do not take the long-lived controller
    // task lock: B may still own it while A is finishing its active turn.
    store.save(latest.state);
    if (activeWriterWindow?.extended) {
      store.event(latest.state, 'recovery_active_writer_window_extended', {
        delivery_id: deliveryId,
        main_session_id: latest.state.main_session_id,
        previous_deadline_at: activeWriterWindow.previous_deadline_at,
        deadline_at: activeWriterWindow.deadline_at,
        active_writer_started_at: activeWriterWindow.active_writer_started_at,
        active_writer_max_deadline_at: activeWriterWindow.active_writer_max_deadline_at,
        capped: activeWriterWindow.capped,
        preflight: writerPreflight,
        diagnosis: conditionKind,
      });
    } else if (activeWriterWindow?.capped && !hadActiveWriterCap) {
      // The cap is represented in state; emit an explicit marker once when
      // the budget can no longer be extended.
      store.event(latest.state, 'recovery_active_writer_window_capped', {
        delivery_id: deliveryId,
        main_session_id: latest.state.main_session_id,
        deadline_at: activeWriterWindow.deadline_at,
        active_writer_started_at: activeWriterWindow.active_writer_started_at,
        active_writer_max_deadline_at: activeWriterWindow.active_writer_max_deadline_at,
      });
    }
    store.event(latest.state, 'main_session_recovery_prompt_deferred', {
      delivery_id: deliveryId,
      main_session_id: latest.state.main_session_id,
      reason,
      retryable,
      retry_attempt: retryAttempt,
      retry_at: retryAt,
      preflight: writerPreflight,
      diagnosis: conditionKind,
      ...(conditionKind === 'recovery_stale_writer' ? { diagnostic: 'thread/read 为空闲或未加载且无 inProgress 回合；未删除 Codex writer lock。' } : {}),
      ...(error ? { error: String(redact(error instanceof Error ? error.message : String(error))) } : {}),
    });
  } catch (failure) {
    // Deferral is best-effort bookkeeping around a transient writer race.
    // Never turn a lock/rename race into an unhandled detached-process error.
    // Keep a separate audit marker when possible; the original Stop and
    // prompt remain intact and the watchdog will make the next attempt.
    try {
      const latest = currentPrompt(statePath);
      if (latest?.prompt.delivery_id === deliveryId) {
        new Store(statePath).event(latest.state, 'main_session_recovery_prompt_defer_failed', {
          delivery_id: deliveryId,
          main_session_id: latest.state.main_session_id,
          reason: 'NF 无法持久化本次暂缓，watchdog 将继续重试。',
          error: String(redact(failure instanceof Error ? failure.message : String(failure))),
        });
      }
    } catch { /* preserve the checkpoint; the next watchdog tick retries */ }
  }
}
