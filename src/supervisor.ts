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
import { normalize, selectAction } from './rules.js';
import { connect, type Rpc } from './transport.js';
import { redact } from './redact.js';

export class Supervisor {
  private rpc: Rpc | undefined;
  constructor(private readonly state: State, private readonly store: Store, private readonly judge: Judge) {}
  private save(): void { this.store.save(this.state); }
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
      await this.sendNext(JSON.stringify(this.state.task), null);
      while (this.state.status === 'ACTIVE') {
        const incoming = await this.rpc.next();
        const event = normalize(incoming.method, incoming.params);
        if (!event) continue;
        const action = selectAction(this.state, event);
        this.store.event(this.state, `worker_${event.type}`, { role: 'worker', thread_id: event.thread_id, turn_id: event.turn_id, status: event.status, action });
        if (action !== 'judge') continue;
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
        const decision = await this.judge.judge(snapshot);
        this.store.snapshot(snapshot, decision);
        this.state.last_decision = decision;
        this.state.handled_turn_ids.push(event.turn_id);
        this.state.reviewing_turn_id = null;
        if (decision.action !== 'WAIT_EXTERNAL' || !decision.external) throw new Error('Ticket #23 accepts only explicit WAIT_EXTERNAL fixtures; continuation/completion gates are delivered by #24.');
        this.state.status = 'WAIT_EXTERNAL';
        this.state.phase = 'IDLE';
        this.state.pending_action = null;
        this.store.event(this.state, 'decision', { role: 'judge', thread_id: this.state.worker_thread_id, turn_id: event.turn_id, decision });
        this.save();
        console.log(`WAIT_EXTERNAL: ${decision.external.missing}; resume when ${decision.external.resume_when}`);
      }
    } catch (error) {
      this.state.last_error = error instanceof Error ? error.message : 'Unknown supervisor failure.';
      this.state.phase = 'RECOVERING';
      this.store.event(this.state, 'recovery_unimplemented', { error: this.state.last_error });
      this.save();
      throw error;
    } finally {
      this.state.elapsed_active_seconds += (Date.now() - activeSince) / 1000;
      this.save();
      await this.rpc?.close();
    }
  }
  private async sendNext(message: string, sourceTurn: string | null): Promise<void> {
    const deliveryId = randomUUID();
    this.state.pending_action = { delivery_id: deliveryId, source_turn_id: sourceTurn, task_version: this.state.task_version, message, stage: 'prepared', target_turn_id: null };
    this.state.phase = 'WORKER';
    this.save();
    this.store.event(this.state, 'send_prepared', { delivery_id: deliveryId });
    const params: TurnStartParams = { threadId: this.state.worker_thread_id!, clientUserMessageId: deliveryId, input: [{ type: 'text', text: `[supervisor:${deliveryId}]\n${message}`, text_elements: [] }] };
    this.state.pending_action.stage = 'sent';
    this.save();
    const result = await this.rpc!.request<TurnStartResponse>('turn/start', params);
    const turnId = text(result.turn.id, 'turn id');
    this.state.pending_action.stage = 'confirmed';
    this.state.pending_action.target_turn_id = turnId;
    this.state.active_worker_turn_id = turnId;
    this.state.worker_turn_count++;
    this.save();
    this.store.event(this.state, 'send_confirmed', { role: 'worker', thread_id: this.state.worker_thread_id, turn_id: turnId, delivery_id: deliveryId });
  }
}
