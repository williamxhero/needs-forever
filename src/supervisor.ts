import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ThreadStartParams } from './protocol/generated/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from './protocol/generated/v2/ThreadStartResponse.js';
import type { ThreadResumeParams } from './protocol/generated/v2/ThreadResumeParams.js';
import type { ThreadResumeResponse } from './protocol/generated/v2/ThreadResumeResponse.js';
import type { TurnStartParams } from './protocol/generated/v2/TurnStartParams.js';
import type { TurnStartResponse } from './protocol/generated/v2/TurnStartResponse.js';
import type { CommandExecParams } from './protocol/generated/v2/CommandExecParams.js';
import type { CommandExecResponse } from './protocol/generated/v2/CommandExecResponse.js';
import type { PendingAction, State, Snapshot } from './types.js';
import { record, text } from './types.js';
import { Store } from './store.js';
import { archiveTerminatedJudge, type Judge } from './judge.js';
import { normalize, selectAction, reachedLimits, type WorkerEvent } from './rules.js';
import { connect, RpcServerError, type Rpc } from './transport.js';
import { redact } from './redact.js';
import { buildSnapshot } from './snapshot.js';
import { classifyRecoveryError, nextBackoff, recordRecoveryFailure } from './recovery.js';
import { setTimeout as delay } from 'node:timers/promises';

type TurnsListResponse = { data: Array<import('./protocol/generated/v2/Turn.js').Turn>; nextCursor: string | null };

export class Supervisor {
  private rpc: Rpc | undefined;
  private readonly incoming: ({ kind: 'notification'; method: string; params: unknown } | { kind: 'response'; delivery: string; version: number; turn: string } | { kind: 'failure'; error: Error; delivery?: string; version?: number })[] = [];
  private wake: (() => void) | undefined;
  private readonly candidates = new Map<string, { started: boolean; client_id?: string; completed?: WorkerEvent }>();
  private readonly displayedOutputs = new Set<string>();
  private reconcileInFlight = false;
  private activeCheckpoint = 0;
  private cancellation: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private nativeThreadUnloadRequested = false;
  private nativeThreadUnloadPending = false;
  private deferredNativeUnloadCompletion: { method: string; params: unknown } | undefined;
  constructor(private readonly state: State, private readonly store: Store, private readonly judge: Judge, private readonly fixture?: { simulate_verification?: boolean; recovery_enabled?: boolean; recovery_delays_ms?: number[]; real_judge?: boolean; reconcile_interval_ms?: number; native_thread_unload_once?: boolean }) {}

  private async maybeRequestNativeThreadUnload(rpc: Rpc, threadId: string): Promise<void> {
    if (!this.fixture?.native_thread_unload_once || this.nativeThreadUnloadRequested) return;
    this.nativeThreadUnloadRequested = true;
    this.nativeThreadUnloadPending = true;
    const params: { threadId: string } = { threadId };
    try {
      await rpc.request('thread/unsubscribe', params);
      this.store.event(this.state, 'native_thread_unload_requested', { thread_id: threadId, method: 'thread/unsubscribe' });
    } catch (error) {
      // The completion notification is still represented by the worker's
      // history. Do not leave the pump permanently deferring notifications
      // when the unload request itself fails or its connection disappears.
      this.nativeThreadUnloadPending = false;
      this.deferredNativeUnloadCompletion = undefined;
      this.store.event(this.state, 'native_thread_unload_failed', {
        thread_id: threadId,
        method: 'thread/unsubscribe',
        error: error instanceof Error ? error.message : String(error),
        action: 'reconcile_worker_history_after_reconnect',
      });
      throw error;
    }
  }

  private async scheduleRecovery(error: unknown): Promise<boolean> {
    const classification = classifyRecoveryError(error);
    this.state.recovery_failures = recordRecoveryFailure(this.state.recovery_failures as import('./recovery.js').RecoveryFailure[] | undefined ?? [], error);
    if (classification.wait_external) {
      const resumeWhen = classification.resume_when ?? 'Resolve the external condition, then explicitly resume the task.';
      this.state.last_error = classification.message;
      this.state.recovery_condition = { kind: classification.kind, message: classification.message, resume_when: resumeWhen };
      this.state.status = 'WAIT_EXTERNAL';
      this.state.phase = 'IDLE';
      this.state.reviewing_turn_id = null;
      if (this.state.pending_action?.stage !== 'sent') this.state.pending_action = null;
      this.state.retry = { kind: null, attempt: 0, next_at: null };
      this.save();
      this.store.event(this.state, 'external_wait_required', { kind: classification.kind, error: classification.message, resume_when: resumeWhen });
      console.log(`WAIT_EXTERNAL: ${classification.message}; resume when ${resumeWhen}`);
      return false;
    }
    const attempt = this.state.retry.attempt + 1;
    const configured = this.fixture?.recovery_delays_ms;
    const backoff = nextBackoff(attempt);
    const delayMs = configured?.[Math.min(attempt - 1, configured.length - 1)] ?? backoff.delay_seconds * 1000;
    const nextAt = new Date(Date.now() + delayMs).toISOString();
    this.state.last_error = classification.message;
    this.state.phase = 'RECOVERING';
    this.state.retry = { kind: classification.kind, attempt, next_at: nextAt };
    const latest = this.state.recovery_failures.at(-1)!;
    this.store.event(this.state, 'recovery_retry_scheduled', { kind: classification.kind, error: classification.message, attempt, next_at: nextAt, delay_seconds: delayMs / 1000, instruction: latest.instruction });
    this.save();
    console.log(`RECOVERING: ${classification.kind}; attempt ${attempt}; retry at ${nextAt}; ${latest.instruction}`);
    try {
      await delay(delayMs, undefined, { signal: this.abort.signal });
    } catch (error) {
      if (this.abort.signal.aborted) return false;
      throw error;
    }
    if (this.state.status !== 'ACTIVE' || this.abort.signal.aborted) return false;
    return true;
  }

  private async judgeWithRecovery(snapshot: Snapshot, argv: string[]): Promise<import('./types.js').Decision | null> {
    const enabled = this.fixture?.recovery_enabled === true || this.fixture?.recovery_delays_ms !== undefined || this.fixture === undefined;
    let currentSnapshot = snapshot;
    while (this.state.status === 'ACTIVE') {
      try {
        const decision = await this.judge.judge(currentSnapshot, this.abort.signal);
        this.state.retry = { kind: null, attempt: 0, next_at: null };
        this.save();
        return decision;
      } catch (error) {
        if (this.state.status !== 'ACTIVE') {
          this.store.event(this.state, 'stale_judge_result_ignored', { snapshot_id: currentSnapshot.snapshot_id });
          return null;
        }
        if (!enabled) throw error;
        if (this.judge.rawOutput !== undefined) this.store.snapshot(currentSnapshot, this.judge.rawOutput, 'invalid');
        if (!(await this.scheduleRecovery(error))) return null;
        if (this.fixture?.real_judge === true || this.fixture === undefined) {
          while (this.state.status === 'ACTIVE') {
            try {
              await this.reconnectAndReconcile(argv);
              if (this.state.status !== 'ACTIVE') return null;
              break;
            } catch (reconnectError) {
              if (!(await this.scheduleRecovery(reconnectError))) return null;
            }
          }
        }
        if (this.state.status !== 'ACTIVE') return null;
        const latestFailure = this.state.recovery_failures?.at(-1);
        if (latestFailure && latestFailure.count >= 3) {
          currentSnapshot = buildSnapshot(this.state, currentSnapshot.worker_turn_id, this.store.events());
          this.store.snapshot(currentSnapshot, null);
          this.store.event(this.state, 'judge_snapshot_rebuilt', { snapshot_id: currentSnapshot.snapshot_id, reason: 'repeated_recovery_failure', instruction: latestFailure.instruction });
        }
        this.state.phase = 'JUDGE';
        this.save();
      }
    }
    return null;
  }
  private accrue(): void {
    const now = Date.now();
    if (this.activeCheckpoint && this.state.status === 'ACTIVE') this.state.elapsed_active_seconds += (now - this.activeCheckpoint) / 1000;
    this.activeCheckpoint = now;
  }
  pause(reason: 'user' | 'user_limit' = 'user'): void {
    if (this.state.status !== 'ACTIVE') return;
    this.accrue();
    const turn = this.state.active_worker_turn_id;
    this.state.status = 'PAUSED';
    this.state.task_version++;
    this.state.pause_reason = reason;
    this.state.phase = 'IDLE';
    if (this.state.pending_action?.stage !== 'sent') this.state.pending_action = null;
    this.state.retry = { kind: null, attempt: 0, next_at: null };
    this.save();
    this.store.event(this.state, 'paused', { reason, active_turn_id: turn });
    console.log(`PAUSED: ${reason}`);
    this.wake?.();
    this.cancellation = (async () => {
      if (turn && this.rpc) {
        await Promise.race([this.rpc.request('turn/interrupt', { threadId: this.state.worker_thread_id, turnId: turn }).catch(() => {}), new Promise<void>((done) => setTimeout(done, 100))]);
      }
      this.abort.abort();
      await this.rpc?.close();
      this.store.event(this.state, 'owned_calls_cancelled');
    })();
  }
  private save(): void { this.store.save(this.state); }
  private async connectWithRecovery(argv: string[]): Promise<{ rpc: Rpc; version: string; disabled_mcp: string[] }> {
    const enabled = this.fixture?.recovery_enabled === true || this.fixture?.recovery_delays_ms !== undefined || this.fixture === undefined;
    let failure: unknown;
    while (this.state.status === 'ACTIVE') {
      try { return await connect(argv, this.state.task.workspace, this.abort.signal); }
      catch (error) {
        failure = error;
        if (!enabled || !(await this.scheduleRecovery(error))) break;
        if (this.state.status !== 'ACTIVE') break;
      }
    }
    throw failure instanceof Error ? failure : new Error('Unable to connect to app-server.');
  }
  private resetIdle(): void {
    this.state.active_worker_turn_id = null;
    this.state.reviewing_turn_id = null;
    this.state.pending_action = null;
  }
  private enqueue(message: (typeof this.incoming)[number]): void { this.incoming.push(message); this.wake?.(); }
  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    const data = params && typeof params === 'object' ? record(params) : {};
    const threadId = typeof data.threadId === 'string' ? data.threadId : undefined;
    this.store.event(this.state, 'server_request', { method, thread_id: threadId ?? null, params: redact(params) });
    const answer = (value: unknown): unknown => { this.store.event(this.state, 'server_request_answered', { method, thread_id: threadId ?? null, answer: redact(value) }); return value; };
    if (threadId && (this.state.judge_thread_ids ?? []).includes(threadId)) {
      if (this.judge.serverRequest) return this.judge.serverRequest(method, params);
      throw new RpcServerError(-32601, 'Judge request handler unavailable.');
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return answer({ decision: 'decline' });
    if (method === 'item/permissions/requestApproval') return answer({ permissions: {}, scope: 'turn' });
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') return answer({ decision: 'abort' });
    if (method === 'mcpServer/elicitation/request') return answer({ action: 'cancel', content: null, _meta: null });
    if (method === 'item/tool/call') return answer({ contentItems: [], success: false });
    if (method === 'item/tool/requestUserInput') {
      const answers: Record<string, { answers: string[] }> = {};
      for (const value of Array.isArray(data.questions) ? data.questions : []) {
        if (!value || typeof value !== 'object') continue;
        const question = record(value);
        const id = typeof question.id === 'string' ? question.id : undefined;
        if (!id || question.isSecret === true) continue;
        const options = Array.isArray(question.options) ? question.options : [];
        const first = options.find((option) => option && typeof option === 'object' && typeof record(option).label === 'string');
        answers[id] = { answers: first ? [String(record(first).label)] : [] };
      }
      return answer({ answers });
    }
    if (threadId && this.state.active_worker_turn_id && threadId === this.state.worker_thread_id) {
      void this.rpc?.request('turn/interrupt', { threadId, turnId: this.state.active_worker_turn_id }).catch(() => {});
      this.store.event(this.state, 'unknown_server_request', { method, thread_id: threadId, action: 'interrupt_requested' });
    }
    throw new RpcServerError(-32601, 'Method not found.');
  }
  private bindRpc(rpc: Rpc): Rpc { this.rpc = rpc; rpc.setRequestHandler((_id, method, params) => this.handleServerRequest(method, params)); return rpc; }
  private bindJudge(rpc: Rpc, argv: string[]): void {
    this.judge.bind?.(rpc, (type, details) => {
      if (type === 'judge_created' && typeof details.thread_id === 'string') { (this.state.judge_thread_ids ??= []).push(details.thread_id); this.save(); }
      this.store.event(this.state, type, { role: 'judge', ...details });
    }, (threadId) => archiveTerminatedJudge(argv, this.state.task.workspace, threadId));
  }
  private async reconcileWorkerHistory(resumed: ThreadStartResponse, allowResendWhenAbsent = true): Promise<void> {
    const pending = this.state.pending_action;
    const turns = resumed.thread.turns;
    if (!pending || pending.stage !== 'sent') {
      const active = this.state.active_worker_turn_id;
      if (!active) return;
      const matchingActive = turns.find((turn) => turn.id === active);
      if (!matchingActive) throw new Error('Saved active worker turn is absent from resume history; no resend performed.');
      this.store.event(this.state, 'worker_history_reconciled', { turn_id: active, status: matchingActive.status });
      if (matchingActive.status === 'completed') this.enqueue({ kind: 'notification', method: 'turn/completed', params: { threadId: this.state.worker_thread_id, turn: matchingActive } });
      else if (matchingActive.status === 'interrupted') this.continueAfterInterrupted(null, matchingActive);
      else if (matchingActive.status === 'failed') {
        const error = this.recordFailedHistory(matchingActive);
        this.continueAfterTerminal(null, matchingActive, error);
      }
      return;
    }
    const matching = turns.find((turn) => Array.isArray(turn.items) && turn.items.some((item) => item.type === 'userMessage' && item.clientId === pending.delivery_id));
    if (!matching) {
      if (!allowResendWhenAbsent) {
        this.store.event(this.state, 'send_reconciliation_deferred', { delivery_id: pending.delivery_id, reason: 'history_does_not_yet_confirm_absence' });
        this.save();
        return;
      }
      const message = pending.message.replace(/^\[supervisor:[^\]]+\]\n/, '');
      this.state.pending_action = null;
      this.state.active_worker_turn_id = null;
      this.state.reviewing_turn_id = null;
      this.state.phase = 'WORKER';
      this.save();
      this.store.event(this.state, 'send_reconciled_absent', { delivery_id: pending.delivery_id, action: 'resend_after_history_check' });
      this.sendNext(message, pending.source_turn_id);
      return;
    }
    this.store.event(this.state, 'send_reconciled_present', { delivery_id: pending.delivery_id, turn_id: matching.id, status: matching.status });
    if (matching.status === 'completed') {
      this.confirm(matching.id, pending.delivery_id, this.state.task_version, 'history');
      this.enqueue({ kind: 'notification', method: 'turn/completed', params: { threadId: this.state.worker_thread_id, turn: matching } });
    } else if (matching.status === 'inProgress') {
      this.confirm(matching.id, pending.delivery_id, this.state.task_version, 'history');
    } else if (matching.status === 'interrupted') {
      this.continueAfterInterrupted(pending, matching);
    } else if (matching.status === 'failed') {
      const error = this.recordFailedHistory(matching);
      this.continueAfterTerminal(pending, matching, error);
    }
  }
  private async hydrateWorkerTurns(rpc: Rpc, resumed: ThreadResumeResponse): Promise<ThreadResumeResponse> {
    const cursor = resumed.turnsBackwardsCursor;
    if (!cursor) return resumed;
    const turns = [...resumed.thread.turns];
    let nextCursor: string | null = cursor;
    const seenCursors = new Set<string>();
    while (nextCursor) {
      if (seenCursors.has(nextCursor)) throw new Error('Paginated worker history cursor repeated.');
      seenCursors.add(nextCursor);
      const page: TurnsListResponse = await rpc.request<TurnsListResponse>('thread/turns/list', { threadId: this.state.worker_thread_id, cursor: nextCursor, sortDirection: 'desc', limit: 100, itemsView: 'full' });
      if (!Array.isArray(page.data) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('Invalid paginated worker history response.');
      for (const turn of page.data) if (!turns.some((known) => known.id === turn.id)) turns.push(turn);
      nextCursor = page.nextCursor;
    }
    return { ...resumed, thread: { ...resumed.thread, turns } };
  }
  private async reconcileOnce(): Promise<void> {
    if (this.reconcileInFlight || this.state.status !== 'ACTIVE' || !this.rpc || !this.state.worker_thread_id || this.state.reviewing_turn_id) return;
    this.reconcileInFlight = true;
    try {
      const params: ThreadResumeParams = { threadId: this.state.worker_thread_id, cwd: this.state.task.workspace, approvalPolicy: 'never', sandbox: 'workspace-write', excludeTurns: false };
      const resumed = await this.hydrateWorkerTurns(this.rpc, await this.rpc.request<ThreadResumeResponse>('thread/resume', params));
      if (this.state.status !== 'ACTIVE') return;
      if (resumed.thread.id !== this.state.worker_thread_id) throw new Error('Periodic reconciliation changed worker identity.');
      this.validateWorker(resumed);
      this.store.event(this.state, 'worker_history_reconciled_periodic', { thread_id: this.state.worker_thread_id, turns: resumed.thread.turns.length });
      await this.reconcileWorkerHistory(resumed, false);
    } finally {
      this.reconcileInFlight = false;
    }
  }
  private recordFailedHistory(turn: { id: string; error?: { message?: string } | null }): Error {
    const message = turn.error?.message ?? `Worker turn ${turn.id} failed without an error message.`;
    this.state.last_error = message;
    this.store.event(this.state, 'worker_history_failed', { turn_id: turn.id, error: message });
    this.save();
    return new Error(`Worker turn ${turn.id} failed: ${message}`);
  }
  private continueAfterInterrupted(pending: PendingAction | null, turn: { id: string }): void {
    const message = pending?.message.replace(/^\[supervisor:[^\]]+\]\n/, '') ?? JSON.stringify(this.state.task);
    this.state.pending_action = null;
    this.state.active_worker_turn_id = null;
    this.state.reviewing_turn_id = null;
    this.state.phase = 'WORKER';
    this.save();
    this.store.event(this.state, 'worker_history_interrupted', { turn_id: turn.id, old_delivery_id: pending?.delivery_id ?? null, action: 'new_continuation' });
    this.sendNext(message, pending?.source_turn_id ?? turn.id);
  }
  private continueAfterTerminal(pending: PendingAction | null, turn: { id: string }, error: Error): void {
    const message = pending?.message.replace(/^\[supervisor:[^\]]+\]\n/, '') ?? JSON.stringify(this.state.task);
    this.state.pending_action = null;
    this.state.active_worker_turn_id = null;
    this.state.reviewing_turn_id = null;
    this.state.phase = 'WORKER';
    this.save();
    this.store.event(this.state, 'worker_history_failed_continuation', { turn_id: turn.id, old_delivery_id: pending?.delivery_id ?? null, error: error.message, action: 'new_continuation' });
    this.sendNext(`The previous worker turn failed with this error: ${error.message}\nContinue the authorized task from the current workspace using a repaired or different route.\n${message}`, pending?.source_turn_id ?? turn.id);
  }
  private async reconnectAndReconcile(argv: string[]): Promise<void> {
    const old = this.rpc;
    this.rpc = undefined;
    await old?.close();
    if (this.state.status !== 'ACTIVE') return;
    const connection = await connect(argv, this.state.task.workspace, this.abort.signal);
    const rpc = this.bindRpc(connection.rpc);
    this.bindJudge(rpc, argv);
    const params: ThreadResumeParams = { threadId: this.state.worker_thread_id!, cwd: this.state.task.workspace, approvalPolicy: 'never', sandbox: 'workspace-write', excludeTurns: false };
    const resumed = await this.hydrateWorkerTurns(rpc, await rpc.request<ThreadResumeResponse>('thread/resume', params));
    if (this.state.status !== 'ACTIVE') return;
    if (resumed.thread.id !== this.state.worker_thread_id) throw new Error('Recovery changed worker identity.');
    this.validateWorker(resumed);
    this.state.codex_version = connection.version;
    this.store.event(this.state, 'connection_reconnected', { thread_id: this.state.worker_thread_id, server_process_id: rpc.processId, codex_version: connection.version });
    await this.reconcileWorkerHistory(resumed);
    if (this.state.status !== 'ACTIVE') return;
    void this.pump(rpc);
  }
  private async pump(rpc: Rpc): Promise<void> {
    try {
      while (this.state.status === 'ACTIVE' && rpc === this.rpc) {
        const notification = await rpc.next();
        if (rpc !== this.rpc) return;
        if (this.fixture && notification.method === 'supervisor/test/pause') { this.pause(); continue; }
        const params = notification.params && typeof notification.params === 'object' ? record(notification.params) : {};
        const statusType = params.status && typeof params.status === 'object' ? record(params.status).type : undefined;
        const threadUnavailable = ['thread/closed', 'thread/notLoaded', 'thread/unloaded'].includes(notification.method)
          || (notification.method === 'thread/status/changed' && statusType === 'notLoaded');
        if (params.threadId === this.state.worker_thread_id && threadUnavailable) {
          this.nativeThreadUnloadPending = false;
          this.store.event(this.state, 'worker_thread_unavailable', { thread_id: params.threadId, method: notification.method, status: statusType ?? null });
          this.enqueue({ kind: 'failure', error: new Error(`Worker thread ${notification.method}${statusType === 'notLoaded' ? ' (notLoaded)' : ''}; recovery will resume the saved worker identity.`) });
          if (this.deferredNativeUnloadCompletion) {
            this.enqueue({ kind: 'notification', ...this.deferredNativeUnloadCompletion });
            this.deferredNativeUnloadCompletion = undefined;
          }
          continue;
        }
        if (typeof params.threadId === 'string' && params.threadId === this.state.worker_thread_id && notification.method === 'turn/completed') {
          await this.maybeRequestNativeThreadUnload(rpc, params.threadId);
          if (this.nativeThreadUnloadPending) {
            this.deferredNativeUnloadCompletion = notification;
            continue;
          }
        }
        if (params.threadId === this.state.worker_thread_id && ['item/completed', 'turn/completed', 'turn/plan/updated'].includes(notification.method)) this.store.event(this.state, 'worker_evidence', { role: 'worker', thread_id: params.threadId, method: notification.method, params });
        if (params.threadId === this.state.worker_thread_id && notification.method === 'item/completed') this.displayOutput(record(redact(params.item)), String(params.turnId));
        this.judge.observe?.(notification.method, notification.params);
        this.enqueue({ kind: 'notification', ...notification });
      }
    } catch (error) {
      if (rpc !== this.rpc) return;
      const failure = error instanceof Error ? error : new Error('Connection failed.');
      this.judge.connectionFailed?.(failure);
      this.enqueue({ kind: 'failure', error: failure });
    }
  }
  private async restoreAfterVerification(argv: string[], old: Rpc): Promise<void> {
    // This is a known, idle-worker verification cancellation, not ambiguous
    // turn recovery. No worker turn is replayed or inferred from history.
    this.rpc = undefined;
    await old.close();
    this.store.event(this.state, 'verification_terminated', { via: 'owned_app_server_exit', server_process_id: old.processId, reason: 'Stable 0.166.0 cannot independently terminate buffered command/exec.' });
    if (this.state.status !== 'ACTIVE') return;
    const connection = await connect(argv, this.state.task.workspace, this.abort.signal);
    const rpc = this.bindRpc(connection.rpc);
    const params: ThreadResumeParams = { threadId: this.state.worker_thread_id!, cwd: this.state.task.workspace, approvalPolicy: 'never', sandbox: 'workspace-write', excludeTurns: false };
    const resumed = await this.hydrateWorkerTurns(rpc, await rpc.request<ThreadResumeResponse>('thread/resume', params));
    if (resumed.thread.id !== this.state.worker_thread_id) throw new Error('Verification recovery changed worker identity.');
    this.validateWorker(resumed);
    if (resumed.thread.turns.some((turn) => turn.status === 'inProgress')) throw new Error('Verification recovery found an unexpected active worker turn; no send performed.');
    this.bindJudge(rpc, argv);
    this.store.event(this.state, 'verification_worker_restored', { thread_id: this.state.worker_thread_id, server_process_id: rpc.processId });
    void this.pump(rpc);
  }
  private validateWorker(created: ThreadStartResponse): void {
    if (created.approvalPolicy !== 'never' || created.sandbox.type !== 'workspaceWrite' || created.sandbox.networkAccess !== false || created.sandbox.excludeTmpdirEnvVar !== true || created.sandbox.excludeSlashTmp !== true || resolve(created.cwd) !== this.state.task.workspace || created.sandbox.writableRoots.some((root) => {
      const suffix = relative(this.state.task.workspace, root);
      return !isAbsolute(root) || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..\\`) || suffix.startsWith('../');
    })) throw new Error('Worker sandbox/approval policy verification failed.');
  }
  private displayOutput(item: Record<string, unknown>, turnId: string): void {
    const identity = `${turnId}/${String(item.id)}`;
    if (item.type !== 'agentMessage' || typeof item.text !== 'string' || this.displayedOutputs.has(identity)) return;
    this.displayedOutputs.add(identity);
    console.log(`worker: ${item.text}`);
    this.store.event(this.state, 'worker_output', { role: 'worker', thread_id: this.state.worker_thread_id, turn_id: turnId, text: item.text });
  }
  private confirm(turnId: string, delivery: string, version: number, via: string): void {
    const pending = this.state.pending_action;
    if (this.state.status !== 'ACTIVE' || this.state.task_version !== version || !pending || pending.delivery_id !== delivery || pending.task_version !== version || pending.stage === 'confirmed' || this.state.active_worker_turn_id || this.state.reviewing_turn_id || this.state.handled_turn_ids.includes(turnId)) return;
    pending.stage = 'confirmed';
    pending.target_turn_id = turnId;
    this.state.active_worker_turn_id = turnId;
    this.state.phase = 'WORKER';
    this.state.worker_turn_count++;
    this.save();
    this.store.event(this.state, 'send_confirmed', { role: 'worker', thread_id: this.state.worker_thread_id, turn_id: turnId, delivery_id: delivery, via });
    const completed = this.candidates.get(turnId)?.completed;
    this.candidates.clear();
    if (completed) this.enqueue({ kind: 'notification', method: 'turn/completed', params: completed.raw });
  }
  async start(argv: string[], resume = false): Promise<void> {
    this.store.protect(this.state);
    this.activeCheckpoint = Date.now();
    this.save();
    let lastReconcileAt = Date.now();
    const reconcileIntervalMs = this.fixture?.reconcile_interval_ms ?? 30_000;
    const checkpoint = setInterval(() => {
      if (this.state.status !== 'ACTIVE') return;
      this.accrue();
      if (reachedLimits(this.state.task.limits, this.state).time) this.pause('user_limit');
      else this.save();
      if (this.state.status === 'ACTIVE' && Date.now() - lastReconcileAt >= reconcileIntervalMs) {
        lastReconcileAt = Date.now();
        void this.reconcileOnce().catch((error: unknown) => this.enqueue({ kind: 'failure', error: error instanceof Error ? error : new Error('Periodic worker reconciliation failed.') }));
      }
    }, 100);
    try {
      if (resume && !this.state.worker_thread_id) throw new Error('Resume requires the saved worker thread identity; explicit recovery cannot proceed.');
      const connection = await this.connectWithRecovery(argv);
      const rpc = this.bindRpc(connection.rpc);
      this.bindJudge(rpc, argv);
      if (this.state.status !== 'ACTIVE') return;
      this.state.codex_version = connection.version;
      this.store.event(this.state, 'connection_verified', { codex_version: connection.version, disabled_mcp: connection.disabled_mcp, server_process_id: rpc.processId });
      if (this.state.status !== 'ACTIVE') return;
      this.state.retry = { kind: null, attempt: 0, next_at: null };
      this.state.phase = 'WORKER';
      this.save();
      const params: ThreadStartParams = { cwd: this.state.task.workspace, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: false };
      const resumeParams: ThreadResumeParams = { ...params, threadId: this.state.worker_thread_id!, excludeTurns: false };
      const created = resume
        ? await this.hydrateWorkerTurns(rpc, await rpc.request<ThreadResumeResponse>('thread/resume', resumeParams))
        : await rpc.request<ThreadStartResponse>('thread/start', params);
      if (this.state.status !== 'ACTIVE') return;
      this.validateWorker(created);
      if (resume && created.thread.id !== this.state.worker_thread_id) throw new Error('Resumed worker identity mismatch.');
      this.state.worker_thread_id = text(created.thread.id, 'worker thread id');
      this.store.event(this.state, resume ? 'worker_resumed' : 'worker_created', { role: 'worker', thread_id: this.state.worker_thread_id });
      void this.pump(rpc);
      const knownTurnId = this.state.active_worker_turn_id ?? this.state.reviewing_turn_id;
      if (resume && knownTurnId) {
        const known = created.thread.turns.find((turn) => turn.id === knownTurnId);
        if (!known) throw new Error('Saved in-flight turn is absent from resume history; no resend is performed until explicit recovery evidence is available.');
        this.state.active_worker_turn_id = knownTurnId;
        this.state.reviewing_turn_id = null;
        this.state.phase = 'WORKER';
        this.save();
        if (known.status === 'completed') this.enqueue({ kind: 'notification', method: 'turn/completed', params: { threadId: this.state.worker_thread_id, turn: known } });
        else if (known.status === 'interrupted') this.continueAfterInterrupted(this.state.pending_action, known);
        else if (known.status === 'failed') {
          const error = this.recordFailedHistory(known);
          this.continueAfterTerminal(this.state.pending_action, known, error);
        }
        else if (known.status !== 'inProgress') throw new Error(`Resumed turn status ${known.status}; explicit recovery diagnostics are required.`);
      } else if (resume && this.state.pending_action?.stage === 'sent') {
        await this.reconcileWorkerHistory(created);
      } else { this.resetIdle(); this.sendNext(JSON.stringify(this.state.task), null); }
      while (this.state.status === 'ACTIVE') {
        while (!this.incoming.length && this.state.status === 'ACTIVE') await new Promise<void>((resolve_) => { this.wake = resolve_; });
        this.wake = undefined;
        if (this.state.status !== 'ACTIVE') break;
        const incoming = this.incoming.shift()!;
        if (this.nativeThreadUnloadPending && incoming.kind === 'notification') {
          this.incoming.push(incoming);
          await delay(10);
          continue;
        }
        if (incoming.kind === 'failure') {
          if (incoming.delivery && (incoming.version !== this.state.task_version || incoming.delivery !== this.state.pending_action?.delivery_id || this.state.pending_action.stage === 'confirmed')) {
            this.store.event(this.state, 'stale_send_result_ignored', { delivery_id: incoming.delivery, error: incoming.error.message });
            continue;
          }
          const enabled = this.fixture?.recovery_enabled === true || this.fixture?.recovery_delays_ms !== undefined || this.fixture === undefined;
          if (!enabled || !this.state.worker_thread_id) throw incoming.error;
          let recoveryError: unknown = incoming.error;
          while (this.state.status === 'ACTIVE') {
            if (!(await this.scheduleRecovery(recoveryError))) break;
            try {
              await this.reconnectAndReconcile(argv);
              if (this.state.status !== 'ACTIVE') break;
              this.state.phase = 'WORKER';
              this.save();
              break;
            } catch (error) {
              recoveryError = error;
            }
          }
          continue;
        }
        if (incoming.kind === 'response') {
          this.confirm(incoming.turn, incoming.delivery, incoming.version, 'response');
          continue;
        }
        const event = normalize(incoming.method, incoming.params);
        if (!event) continue;
        const action = selectAction(this.state, event);
        this.store.event(this.state, `worker_${event.type}`, { role: 'worker', thread_id: event.thread_id, turn_id: event.turn_id, status: event.status, action });
        if (action === 'observe' && !this.state.active_worker_turn_id && this.state.pending_action?.stage === 'sent') {
          const candidate = this.candidates.get(event.turn_id) ?? { started: false };
          if (event.type === 'started' && event.status === 'inProgress') candidate.started = true;
          if (event.type === 'input' && event.client_id) candidate.client_id = event.client_id;
          this.candidates.set(event.turn_id, candidate);
          if (candidate.started && candidate.client_id === this.state.pending_action.delivery_id) this.confirm(event.turn_id, this.state.pending_action.delivery_id, this.state.task_version, 'started+clientId');
        }
        if (action === 'ignore' && event.type === 'completed' && event.thread_id === this.state.worker_thread_id && this.state.pending_action?.stage === 'sent' && !this.state.handled_turn_ids.includes(event.turn_id)) {
          const candidate = this.candidates.get(event.turn_id);
          if (candidate) candidate.completed = event;
        }
        if (action !== 'judge') continue;
        const turn = record(record(redact(event.raw)).turn);
        if (event.status !== 'completed') {
          let detail = `Worker turn ${event.turn_id} ended with status ${event.status}.`;
          if (turn.error && typeof turn.error === 'object' && !Array.isArray(turn.error)) {
            const error = record(turn.error);
            if (typeof error.message === 'string' && error.message.trim()) detail = error.message;
          }
          const terminalError = new Error(`Worker turn ${event.turn_id} ${event.status}: ${detail}`);
          this.store.event(this.state, 'worker_terminal_recovery_required', { turn_id: event.turn_id, status: event.status, error: terminalError.message });
          const enabled = this.fixture?.recovery_enabled === true || this.fixture?.recovery_delays_ms !== undefined || this.fixture === undefined;
          if (!enabled || !this.state.worker_thread_id) throw terminalError;
          let recoveryError: unknown = terminalError;
          while (this.state.status === 'ACTIVE') {
            if (!(await this.scheduleRecovery(recoveryError))) break;
            try {
              await this.reconnectAndReconcile(argv);
              if (this.state.status !== 'ACTIVE') break;
              this.state.phase = 'WORKER';
              this.save();
              break;
            } catch (error) {
              recoveryError = error;
            }
          }
          continue;
        }
        if (Array.isArray(turn.items)) for (const value of turn.items) {
          const item = record(value);
          this.displayOutput(item, event.turn_id);
        }
        this.state.phase = 'JUDGE';
        this.state.active_worker_turn_id = null;
        this.state.reviewing_turn_id = event.turn_id;
        this.save();
        const snapshot: Snapshot = this.judge.rawOutput === undefined ? { snapshot_id: randomUUID(), task_id: this.state.task_id, task_version: this.state.task_version, worker_thread_id: this.state.worker_thread_id!, worker_turn_id: event.turn_id, task: this.state.task, evidence: [{ id: 'E1', type: 'worker_terminal', value: redact(event.raw) }] } : buildSnapshot(this.state, event.turn_id, this.store.events());
        this.store.snapshot(snapshot, null);
        let decision;
        try {
          decision = await this.judgeWithRecovery(snapshot, argv);
          if (this.judge.rawOutput !== undefined && decision === null && this.state.status === 'ACTIVE') this.store.snapshot(snapshot, this.judge.rawOutput, 'invalid');
        } catch (error) {
          if (this.state.status !== 'ACTIVE') { this.store.event(this.state, 'stale_judge_result_ignored', { snapshot_id: snapshot.snapshot_id }); continue; }
          if (this.judge.rawOutput !== undefined) this.store.snapshot(snapshot, this.judge.rawOutput, 'invalid');
          throw error;
        }
        if (decision === null) continue;
        if (this.state.status !== 'ACTIVE' || this.state.task_version !== snapshot.task_version || this.state.reviewing_turn_id !== event.turn_id || this.state.active_worker_turn_id !== null) {
          this.store.event(this.state, 'stale_judge_result_ignored', { snapshot_id: snapshot.snapshot_id });
          continue;
        }
        this.store.snapshot(snapshot, this.judge.rawOutput ?? decision, this.judge.rawOutput === undefined ? 'fixture-only' : 'valid');
        this.state.last_decision = decision;
        this.state.handled_turn_ids.push(event.turn_id);
        this.state.reviewing_turn_id = null;
        this.store.event(this.state, 'decision', { role: 'judge', thread_id: this.judge.rawOutput === undefined ? null : this.state.judge_thread_ids?.at(-1), worker_thread_id: this.state.worker_thread_id, worker_turn_id: event.turn_id, snapshot_id: snapshot.snapshot_id, decision });
        if (decision.action === 'CONTINUE') {
          this.sendNext(text(decision.next_message, 'next_message'), event.turn_id);
        } else {
          if (decision.action !== 'DONE' && (decision.action !== 'WAIT_EXTERNAL' || !decision.external)) throw new Error('Invalid fixed judge decision.');
          if (decision.action === 'DONE' && this.state.task.verify) {
            if (!this.fixture?.simulate_verification) {
              this.state.phase = 'VERIFY';
              this.save();
              const before = this.store.protectedChanges(this.state);
              const verify = this.state.task.verify;
              let result: { exitCode: number | null; stdout: string; stderr: string; timed_out?: boolean };
              if (before.length) result = { exitCode: null, stdout: '', stderr: 'Protected files changed before verification.' };
              else {
                const watchdog = new Error('Independent verification supervisor timeout; command did not settle within its timeout plus 1 second grace.');
                let timer: ReturnType<typeof setTimeout> | undefined;
                const executingRpc = this.rpc;
                if (!executingRpc) throw new Error('Verification requires an active app-server connection.');
                try {
                  const command: CommandExecParams = {
                    command: verify.argv, cwd: this.state.task.workspace, timeoutMs: verify.timeout_seconds * 1000,
                    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.state.task.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
                  };
                  result = await Promise.race([executingRpc.request<CommandExecResponse>('command/exec', command), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(watchdog), verify.timeout_seconds * 1000 + 1000); })]);
                } catch (error) {
                  const message = error instanceof Error ? error.message : 'Unknown independent verification failure.';
                  if (error === watchdog) await this.restoreAfterVerification(argv, executingRpc);
                  else if (this.state.status === 'ACTIVE' && !message.includes('sandbox error: command timed out')) throw error;
                  result = { exitCode: null, stdout: '', stderr: message, timed_out: error === watchdog || message.includes('sandbox error: command timed out') };
                } finally { if (timer) clearTimeout(timer); }
                if (!result || (result.exitCode !== null && !Number.isInteger(result.exitCode)) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error('Invalid independent verification response; exitCode/stdout/stderr are required.');
              }
              if (this.state.status !== 'ACTIVE' || this.state.task_version !== snapshot.task_version || this.state.active_worker_turn_id !== null) {
                this.store.event(this.state, 'stale_verification_result_ignored');
                continue;
              }
              const after = this.store.protectedChanges(this.state);
              const passed = result.exitCode === 0 && !before.length && !after.length;
              const evidence = { argv: verify.argv, ...result, protected_before: before, protected_after: after, passed };
              this.store.event(this.state, 'verification_result', evidence);
              if (!passed) {
                const changed = new Set([...before, ...after].map((file) => file.path));
                const restore = (this.state.protected_baseline ?? []).filter((file) => changed.has(file.path));
                this.sendNext(`Independent verification failed. Repair the task and restore any changed protected files to their original content; never change the fixed verification command. Evidence: ${JSON.stringify(redact(evidence))}. Original protected contents (base64): ${JSON.stringify(restore)}`, event.turn_id);
                continue;
              }
            } else {
              this.state.phase = 'VERIFY';
              this.save();
              this.store.event(this.state, 'fixture_verification_started', { worker_turn_id: event.turn_id });
              try {
                if (!this.rpc) throw new Error('Verification requires an active app-server connection.');
                await this.rpc.request('command/exec', { command: this.state.task.verify.argv, cwd: this.state.task.workspace, timeoutMs: this.state.task.verify.timeout_seconds * 1000 });
              } catch (error) { if (this.state.status === 'ACTIVE') throw error; }
              if (this.state.status !== 'ACTIVE' || this.state.task_version !== snapshot.task_version || this.state.active_worker_turn_id !== null) {
                this.store.event(this.state, 'stale_verification_result_ignored');
                continue;
              }
              throw new Error('S1 verification fixture only tests cancellation; real acceptance is S2.');
            }
          }
          this.accrue();
          this.state.status = decision.action;
          this.state.phase = 'IDLE';
          this.state.pending_action = null;
          this.state.retry = { kind: null, attempt: 0, next_at: null };
          this.save();
          console.log(decision.action === 'DONE' ? `DONE (${this.state.mode}): ${decision.reason}` : `WAIT_EXTERNAL: ${decision.external!.missing}; resume when ${decision.external!.resume_when}`);
        }
      }
    } catch (error) {
      if (this.state.status !== 'ACTIVE') return;
      const classification = classifyRecoveryError(error);
      this.state.last_error = classification.message;
      this.state.phase = 'RECOVERING';
      this.state.retry = { kind: classification.kind, attempt: this.state.retry.attempt + 1, next_at: null };
      this.store.event(this.state, 'recovery_required', {
        kind: classification.kind,
        recoverable: classification.recoverable,
        wait_external: classification.wait_external,
        error: this.state.last_error,
        pending_action: this.state.pending_action,
        reconciliation: 'No resend performed until connection and delivery history reconciliation completes.',
      });
      this.save();
      throw error;
    } finally {
      clearInterval(checkpoint);
      this.accrue();
      this.save();
      await this.cancellation;
      await this.rpc?.close();
    }
  }
  private sendNext(message: string, sourceTurn: string | null): void {
    if (this.state.status !== 'ACTIVE' || this.state.active_worker_turn_id || this.state.reviewing_turn_id) throw new Error('Cannot send while a worker or judge is active.');
    this.accrue();
    const limits = reachedLimits(this.state.task.limits, this.state);
    if (limits.turns || limits.time) { this.pause('user_limit'); return; }
    const deliveryId = randomUUID();
    const fullMessage = `[supervisor:${deliveryId}]\n${message}`;
    this.state.pending_action = { delivery_id: deliveryId, source_turn_id: sourceTurn, task_version: this.state.task_version, message: fullMessage, stage: 'prepared', target_turn_id: null };
    this.state.phase = 'WORKER';
    this.save();
    this.store.event(this.state, 'send_prepared', { delivery_id: deliveryId, source_turn_id: sourceTurn, message: fullMessage });
    const params: TurnStartParams = { threadId: this.state.worker_thread_id!, clientUserMessageId: deliveryId, input: [{ type: 'text', text: fullMessage, text_elements: [] }] };
    this.state.pending_action.stage = 'sent';
    this.save();
    const version = this.state.task_version;
    this.store.event(this.state, 'send_attempted', { delivery_id: deliveryId });
    void this.rpc!.request<TurnStartResponse>('turn/start', params).then((result) => {
      this.enqueue({ kind: 'response', delivery: deliveryId, version, turn: text(result.turn.id, 'turn id') });
    }).catch((error: unknown) => {
      this.enqueue({ kind: 'failure', delivery: deliveryId, version, error: error instanceof Error ? error : new Error('turn/start failed.') });
    });
  }
}
