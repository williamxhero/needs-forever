import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ThreadStartParams } from './protocol/generated/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from './protocol/generated/v2/ThreadStartResponse.js';
import type { ThreadResumeParams } from './protocol/generated/v2/ThreadResumeParams.js';
import type { TurnStartParams } from './protocol/generated/v2/TurnStartParams.js';
import type { TurnStartResponse } from './protocol/generated/v2/TurnStartResponse.js';
import type { State, Snapshot } from './types.js';
import { record, text } from './types.js';
import { Store } from './store.js';
import type { Judge } from './judge.js';
import { normalize, selectAction, reachedLimits, type WorkerEvent } from './rules.js';
import { connect, type Rpc } from './transport.js';
import { redact } from './redact.js';
import { buildSnapshot } from './snapshot.js';

export class Supervisor {
  private rpc: Rpc | undefined;
  private readonly incoming: ({ kind: 'notification'; method: string; params: unknown } | { kind: 'response'; delivery: string; version: number; turn: string } | { kind: 'failure'; error: Error; delivery?: string; version?: number })[] = [];
  private wake: (() => void) | undefined;
  private readonly candidates = new Map<string, { started: boolean; client_id?: string; completed?: WorkerEvent }>();
  private readonly displayedOutputs = new Set<string>();
  private activeCheckpoint = 0;
  private cancellation: Promise<void> | undefined;
  private readonly abort = new AbortController();
  constructor(private readonly state: State, private readonly store: Store, private readonly judge: Judge, private readonly fixture?: { simulate_verification?: boolean }) {}
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
  private resetIdle(): void {
    this.state.active_worker_turn_id = null;
    this.state.reviewing_turn_id = null;
    this.state.pending_action = null;
  }
  private enqueue(message: (typeof this.incoming)[number]): void { this.incoming.push(message); this.wake?.(); }
  private async pump(rpc: Rpc): Promise<void> {
    try {
      while (this.state.status === 'ACTIVE') {
        const notification = await rpc.next();
        if (this.fixture && notification.method === 'supervisor/test/pause') { this.pause(); continue; }
        const params = notification.params && typeof notification.params === 'object' ? record(notification.params) : {};
        if (params.threadId === this.state.worker_thread_id && ['item/completed', 'turn/completed', 'turn/plan/updated'].includes(notification.method)) this.store.event(this.state, 'worker_evidence', { role: 'worker', thread_id: params.threadId, method: notification.method, params });
        if (params.threadId === this.state.worker_thread_id && notification.method === 'item/completed') this.displayOutput(record(redact(params.item)), String(params.turnId));
        this.judge.observe?.(notification.method, notification.params);
        this.enqueue({ kind: 'notification', ...notification });
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Connection failed.');
      this.judge.connectionFailed?.(failure);
      this.enqueue({ kind: 'failure', error: failure });
    }
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
    this.activeCheckpoint = Date.now();
    this.save();
    const checkpoint = setInterval(() => {
      if (this.state.status !== 'ACTIVE') return;
      this.accrue();
      if (reachedLimits(this.state.task.limits, this.state).time) this.pause('user_limit');
      else this.save();
    }, 100);
    try {
      if (resume && this.state.pending_action?.stage === 'sent') throw new Error('Unknown sent delivery retained; S3 reconciliation required before any resend.');
      if (resume && !this.state.worker_thread_id) throw new Error('Resume requires the saved worker thread identity; S3 recovery required.');
      const connection = await connect(argv, this.state.task.workspace, this.abort.signal);
      this.rpc = connection.rpc;
      this.judge.bind?.(this.rpc, (type, details) => {
        if (type === 'judge_created' && typeof details.thread_id === 'string') { (this.state.judge_thread_ids ??= []).push(details.thread_id); this.save(); }
        this.store.event(this.state, type, { role: 'judge', ...details });
      });
      if (this.state.status !== 'ACTIVE') return;
      this.state.codex_version = connection.version;
      this.store.event(this.state, 'connection_verified', { codex_version: connection.version, disabled_mcp: connection.disabled_mcp, server_process_id: this.rpc.processId });
      const params: ThreadStartParams = { cwd: this.state.task.workspace, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: false };
      const resumeParams: ThreadResumeParams = { ...params, threadId: this.state.worker_thread_id!, excludeTurns: false };
      const created = await this.rpc.request<ThreadStartResponse>(resume ? 'thread/resume' : 'thread/start', resume ? resumeParams : params);
      if (this.state.status !== 'ACTIVE') return;
      if (created.approvalPolicy !== 'never' || created.sandbox.type !== 'workspaceWrite' || created.sandbox.networkAccess !== false || created.sandbox.excludeTmpdirEnvVar !== true || created.sandbox.excludeSlashTmp !== true || resolve(created.cwd) !== this.state.task.workspace || created.sandbox.writableRoots.some((root) => {
        const suffix = relative(this.state.task.workspace, root);
        return !isAbsolute(root) || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..\\`) || suffix.startsWith('../');
      })) throw new Error('Worker sandbox/approval policy verification failed.');
      if (resume && created.thread.id !== this.state.worker_thread_id) throw new Error('Resumed worker identity mismatch.');
      this.state.worker_thread_id = text(created.thread.id, 'worker thread id');
      this.store.event(this.state, resume ? 'worker_resumed' : 'worker_created', { role: 'worker', thread_id: this.state.worker_thread_id });
      void this.pump(this.rpc);
      const knownTurnId = this.state.active_worker_turn_id ?? this.state.reviewing_turn_id;
      if (resume && knownTurnId) {
        const known = created.thread.turns.find((turn) => turn.id === knownTurnId);
        if (!known) throw new Error('Saved in-flight turn is absent from resume history; S3 reconciliation required, no resend.');
        this.state.active_worker_turn_id = knownTurnId;
        this.state.reviewing_turn_id = null;
        this.state.phase = 'WORKER';
        this.save();
        if (known.status === 'completed') this.enqueue({ kind: 'notification', method: 'turn/completed', params: { threadId: this.state.worker_thread_id, turn: known } });
        else if (known.status === 'interrupted') { this.resetIdle(); this.sendNext(JSON.stringify(this.state.task), null); }
        else if (known.status !== 'inProgress') throw new Error(`Resumed turn status ${known.status}; S3 diagnostic recovery required.`);
      } else { this.resetIdle(); this.sendNext(JSON.stringify(this.state.task), null); }
      while (this.state.status === 'ACTIVE') {
        while (!this.incoming.length && this.state.status === 'ACTIVE') await new Promise<void>((resolve_) => { this.wake = resolve_; });
        this.wake = undefined;
        if (this.state.status !== 'ACTIVE') break;
        const incoming = this.incoming.shift()!;
        if (incoming.kind === 'failure') {
          if (incoming.delivery && (incoming.version !== this.state.task_version || incoming.delivery !== this.state.pending_action?.delivery_id || this.state.pending_action.stage === 'confirmed')) {
            this.store.event(this.state, 'stale_send_result_ignored', { delivery_id: incoming.delivery, error: incoming.error.message });
            continue;
          }
          throw incoming.error;
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
        if (event.status !== 'completed') throw new Error(`Worker terminal status ${event.status}; error classification/recovery remains S3, no DONE inferred.`);
        const turn = record(record(redact(event.raw)).turn);
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
        try { decision = await this.judge.judge(snapshot, this.abort.signal); }
        catch (error) {
          if (this.state.status !== 'ACTIVE') { this.store.event(this.state, 'stale_judge_result_ignored', { snapshot_id: snapshot.snapshot_id }); continue; }
          if (this.judge.rawOutput !== undefined) this.store.snapshot(snapshot, this.judge.rawOutput, 'invalid');
          throw error;
        }
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
            if (!this.fixture?.simulate_verification) throw new Error('Independent verification is delivered by S2; fixture DONE cannot bypass configured verify.');
            this.state.phase = 'VERIFY';
            this.save();
            this.store.event(this.state, 'fixture_verification_started', { worker_turn_id: event.turn_id });
            try {
              await this.rpc.request('command/exec', { command: this.state.task.verify.argv, cwd: this.state.task.workspace, timeoutMs: this.state.task.verify.timeout_seconds * 1000 });
            } catch (error) { if (this.state.status === 'ACTIVE') throw error; }
            if (this.state.status !== 'ACTIVE' || this.state.task_version !== snapshot.task_version || this.state.active_worker_turn_id !== null) {
              this.store.event(this.state, 'stale_verification_result_ignored');
              continue;
            }
            throw new Error('S1 verification fixture only tests cancellation; real acceptance is S2.');
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
      this.state.last_error = error instanceof Error ? error.message : 'Unknown supervisor failure.';
      this.state.phase = 'RECOVERING';
      this.store.event(this.state, 'recovery_required', { error: this.state.last_error, pending_action: this.state.pending_action, reconciliation: 'S3 not implemented; no resend performed' });
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
