import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ThreadStartParams } from './protocol/generated/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from './protocol/generated/v2/ThreadStartResponse.js';
import type { TurnStartParams } from './protocol/generated/v2/TurnStartParams.js';
import type { TurnStartResponse } from './protocol/generated/v2/TurnStartResponse.js';
import type { State, Snapshot } from './types.js';
import { record, text } from './types.js';
import { Store } from './store.js';
import type { Judge } from './judge.js';
import { normalize, selectAction, type WorkerEvent } from './rules.js';
import { connect, type Rpc } from './transport.js';
import { redact } from './redact.js';

export class Supervisor {
  private rpc: Rpc | undefined;
  private readonly incoming: ({ kind: 'notification'; method: string; params: unknown } | { kind: 'response'; delivery: string; version: number; turn: string } | { kind: 'failure'; error: Error; delivery?: string; version?: number })[] = [];
  private wake: (() => void) | undefined;
  private readonly candidates = new Map<string, { started: boolean; client_id?: string; completed?: WorkerEvent }>();
  constructor(private readonly state: State, private readonly store: Store, private readonly judge: Judge) {}
  private save(): void { this.store.save(this.state); }
  private enqueue(message: (typeof this.incoming)[number]): void { this.incoming.push(message); this.wake?.(); }
  private async pump(rpc: Rpc): Promise<void> {
    try {
      while (this.state.status === 'ACTIVE') {
        const notification = await rpc.next();
        this.enqueue({ kind: 'notification', ...notification });
      }
    } catch (error) { this.enqueue({ kind: 'failure', error: error instanceof Error ? error : new Error('Connection failed.') }); }
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
  async start(argv: string[]): Promise<void> {
    const activeSince = Date.now();
    this.save();
    try {
      const connection = await connect(argv, this.state.task.workspace);
      this.rpc = connection.rpc;
      this.state.codex_version = connection.version;
      this.store.event(this.state, 'connection_verified', { codex_version: connection.version, disabled_mcp: connection.disabled_mcp, server_process_id: this.rpc.processId });
      const params: ThreadStartParams = { cwd: this.state.task.workspace, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: false };
      const created = await this.rpc.request<ThreadStartResponse>('thread/start', params);
      if (created.approvalPolicy !== 'never' || created.sandbox.type !== 'workspaceWrite' || created.sandbox.networkAccess !== false || created.sandbox.excludeTmpdirEnvVar !== true || created.sandbox.excludeSlashTmp !== true || resolve(created.cwd) !== this.state.task.workspace || created.sandbox.writableRoots.some((root) => {
        const suffix = relative(this.state.task.workspace, root);
        return !isAbsolute(root) || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..\\`) || suffix.startsWith('../');
      })) throw new Error('Worker sandbox/approval policy verification failed.');
      this.state.worker_thread_id = text(created.thread.id, 'worker thread id');
      this.store.event(this.state, 'worker_created', { role: 'worker', thread_id: this.state.worker_thread_id });
      void this.pump(this.rpc);
      this.sendNext(JSON.stringify(this.state.task), null);
      while (this.state.status === 'ACTIVE') {
        while (!this.incoming.length) await new Promise<void>((resolve_) => { this.wake = resolve_; });
        this.wake = undefined;
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
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            console.log(`worker: ${item.text}`);
            this.store.event(this.state, 'worker_output', { role: 'worker', thread_id: event.thread_id, turn_id: event.turn_id, text: item.text });
          }
        }
        this.state.phase = 'JUDGE';
        this.state.active_worker_turn_id = null;
        this.state.reviewing_turn_id = event.turn_id;
        this.save();
        const snapshot: Snapshot = { snapshot_id: randomUUID(), task_id: this.state.task_id, task_version: this.state.task_version, worker_thread_id: this.state.worker_thread_id!, worker_turn_id: event.turn_id, task: this.state.task, evidence: [{ id: 'E1', type: 'worker_terminal', value: redact(event.raw) }] };
        this.store.snapshot(snapshot, null);
        const decision = await this.judge.judge(snapshot);
        if (this.state.status !== 'ACTIVE' || this.state.task_version !== snapshot.task_version || this.state.reviewing_turn_id !== event.turn_id || this.state.active_worker_turn_id !== null) continue;
        this.store.snapshot(snapshot, decision);
        this.state.last_decision = decision;
        this.state.handled_turn_ids.push(event.turn_id);
        this.state.reviewing_turn_id = null;
        this.store.event(this.state, 'decision', { role: 'judge', thread_id: this.state.worker_thread_id, turn_id: event.turn_id, decision });
        if (decision.action === 'CONTINUE') {
          this.sendNext(text(decision.next_message, 'next_message'), event.turn_id);
        } else {
          if (decision.action !== 'DONE' && (decision.action !== 'WAIT_EXTERNAL' || !decision.external)) throw new Error('Invalid fixed judge decision.');
          if (decision.action === 'DONE' && this.state.task.verify) throw new Error('Independent verification is delivered by S2; fixture DONE cannot bypass configured verify.');
          this.state.status = decision.action;
          this.state.phase = 'IDLE';
          this.state.pending_action = null;
          this.save();
          console.log(decision.action === 'DONE' ? `DONE (simulated): ${decision.reason}` : `WAIT_EXTERNAL: ${decision.external!.missing}; resume when ${decision.external!.resume_when}`);
        }
      }
    } catch (error) {
      this.state.last_error = error instanceof Error ? error.message : 'Unknown supervisor failure.';
      this.state.phase = 'RECOVERING';
      this.store.event(this.state, 'recovery_required', { error: this.state.last_error, pending_action: this.state.pending_action, reconciliation: 'S3 not implemented; no resend performed' });
      this.save();
      throw error;
    } finally {
      this.state.elapsed_active_seconds += (Date.now() - activeSince) / 1000;
      this.save();
      await this.rpc?.close();
    }
  }
  private sendNext(message: string, sourceTurn: string | null): void {
    if (this.state.status !== 'ACTIVE' || this.state.active_worker_turn_id || this.state.reviewing_turn_id) throw new Error('Cannot send while a worker or judge is active.');
    const deliveryId = randomUUID();
    const fullMessage = `[supervisor:${deliveryId}]\n${message}`;
    this.state.pending_action = { delivery_id: deliveryId, source_turn_id: sourceTurn, task_version: this.state.task_version, message: fullMessage, stage: 'prepared', target_turn_id: null };
    this.state.phase = 'WORKER';
    this.save();
    this.store.event(this.state, 'send_prepared', { delivery_id: deliveryId });
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
