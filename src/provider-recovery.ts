import { randomUUID } from 'node:crypto';
import type { MainSessionState } from './main-session.js';
import { Store } from './store.js';
import { waitForNativeReceipt } from './recovery-episode.js';
import {
  createProviderState,
  type DeliveryReconciliation,
  type MainSessionProvider,
  type ProviderActivity,
  type ProviderIdentity,
  type ProviderThreadSnapshot,
  type ProviderWriterState,
} from './main-session-provider.js';

export type ProviderRecoveryOutcome = 'confirmed' | 'sent' | 'waiting' | 'unavailable' | 'stale';

export interface ProviderRecoveryResult {
  outcome: ProviderRecoveryOutcome;
  reason: string;
  delivery: DeliveryReconciliation | null;
  activity: ProviderActivity | null;
  thread: ProviderThreadSnapshot | null;
}

export interface ProviderRecoveryOptions {
  statePath?: string;
  identity: ProviderIdentity;
  currentState?: () => MainSessionState;
  reason?: string;
}

function stale(state: MainSessionState, options: ProviderRecoveryOptions, taskVersion: number, generation: string, inputEpoch: number): boolean {
  const current = options.currentState?.();
  return state.task_version !== taskVersion
    || state.run_generation !== generation
    || (state.input_epoch ?? 0) !== inputEpoch
    || !!current && (current.task_version !== taskVersion || current.run_generation !== generation || (current.input_epoch ?? 0) !== inputEpoch || current.status === 'DONE' || current.status === 'PAUSED' || current.status === 'INTERRUPTED');
}

function persist(state: MainSessionState, options: ProviderRecoveryOptions, eventType: string, payload: Record<string, unknown>): void {
  if (!options.statePath) return;
  const store = new Store(options.statePath);
  store.save(state);
  store.event(state, eventType, payload);
}

function setWaiting(state: MainSessionState, kind: string, message: string): void {
  state.status = 'WAIT_EXTERNAL';
  state.phase = 'RECOVERING';
  state.continuation_confirmed = false;
  state.last_error = message;
  state.recovery_condition = { kind, message, resume_when: 'A same-thread provider activity or a fresh native receipt is required before WORKER can resume.' };
  if (state.recovery_plan) waitForNativeReceipt(state, state.recovery_condition);
}

function projectWriter(state: MainSessionState, writer: ProviderWriterState): void {
  state.provider = { ...(state.provider ?? createProviderState({
    schema_version: 1,
    provider_kind: 'unavailable',
    evidence_level: 'unavailable',
    available: false,
    attached: false,
    same_thread_verified: false,
    capabilities: { read_thread: false, read_writer: false, resume_send: false, subscribe_events: false, read_history: false, reconcile_delivery: false },
    target_thread_id: null,
    target_session_id: null,
    main_session_id: null,
    workspace: null,
    host_instance_id: null,
    host_fingerprint: null,
    protocol_version: null,
    provider_version: null,
    endpoint_fingerprint: null,
    task_version: null,
    run_generation: null,
    contract_sha256: null,
    limitation_reason: null,
    observed_at: new Date().toISOString(),
  })), writer, updated_at: new Date().toISOString() };
}

export async function recoverMainSessionWithProvider(state: MainSessionState, provider: MainSessionProvider, options: ProviderRecoveryOptions): Promise<ProviderRecoveryResult> {
  const taskVersion = state.task_version;
  const generation = state.run_generation;
  const inputEpoch = state.input_epoch ?? 0;
  if (state.status === 'DONE' || state.status === 'PAUSED' || state.status === 'INTERRUPTED') return { outcome: 'stale', reason: `Recovery is fenced by terminal state ${state.status}.`, delivery: null, activity: null, thread: null };
  let receipt;
  try { receipt = await provider.probe({ target: options.identity }); }
  catch (error) { const reason = error instanceof Error ? error.message : String(error); setWaiting(state, 'recovery_desktop_provider_unavailable', reason); persist(state, options, 'provider_recovery_unavailable', { reason, task_version: taskVersion, run_generation: generation }); return { outcome: 'unavailable', reason, delivery: null, activity: null, thread: null }; }
  if (stale(state, options, taskVersion, generation, inputEpoch)) return { outcome: 'stale', reason: 'Provider probe completed after the recovery generation changed.', delivery: null, activity: null, thread: null };
  state.provider = createProviderState(receipt);
  persist(state, options, 'provider_capability_probe', { provider_kind: receipt.provider_kind, available: receipt.available, same_thread_verified: receipt.same_thread_verified, target_thread_id: receipt.target_thread_id, target_session_id: receipt.target_session_id, task_version: taskVersion, run_generation: generation });
  if (!receipt.available || !receipt.same_thread_verified) {
    const reason = receipt.limitation_reason ?? 'Desktop provider is unavailable or same-thread identity is unverified.';
    setWaiting(state, 'recovery_desktop_provider_unavailable', reason);
    persist(state, options, 'provider_recovery_unavailable', { reason, provider_kind: receipt.provider_kind });
    return { outcome: 'unavailable', reason, delivery: null, activity: null, thread: null };
  }
  let thread: ProviderThreadSnapshot;
  try { thread = await provider.readThread({ target: options.identity }); }
  catch (error) { const reason = error instanceof Error ? error.message : String(error); setWaiting(state, 'recovery_history_unreadable', reason); persist(state, options, 'provider_recovery_history_unreadable', { reason }); return { outcome: 'waiting', reason, delivery: null, activity: null, thread: null }; }
  if (stale(state, options, taskVersion, generation, inputEpoch)) return { outcome: 'stale', reason: 'Thread read completed after the recovery generation changed.', delivery: null, activity: null, thread: null };
  projectWriter(state, thread.writer);
  if (thread.writer.status === 'in-progress' || thread.writer.status === 'active-writer') {
    const reason = thread.writer.reason ?? 'The original A owns an active writer; recovery is waiting without competing for it.';
    setWaiting(state, 'recovery_active_writer', reason);
    persist(state, options, 'provider_recovery_active_writer', { turn_id: thread.writer.turn_id, owner_session_id: thread.writer.owner_session_id, reason });
    return { outcome: 'waiting', reason, delivery: null, activity: null, thread };
  }

  const pending = state.pending_action;
  if (!pending) {
    state.phase = state.status === 'WAIT_EXTERNAL' ? 'RECOVERING' : state.phase;
    persist(state, options, 'provider_recovery_attached', { target_thread_id: thread.thread_id, target_session_id: thread.session_id });
    return { outcome: 'waiting', reason: 'Same-thread provider attached; no pending delivery is eligible to be sent.', delivery: null, activity: null, thread };
  }
  let delivery = await provider.reconcileDelivery({ target: options.identity, delivery_id: pending.delivery_id, message: pending.message, client_message_id: pending.delivery_id, target_turn_id: pending.target_turn_id });
  if (stale(state, options, taskVersion, generation, inputEpoch)) return { outcome: 'stale', reason: 'Delivery reconciliation completed after the recovery generation changed.', delivery, activity: null, thread };
  state.provider = { ...(state.provider ?? createProviderState(receipt)), last_delivery: delivery, updated_at: new Date().toISOString() };
  persist(state, options, 'provider_delivery_reconciled', { delivery_id: delivery.delivery_id, outcome: delivery.outcome, matched_by: delivery.matched_by, target_turn_id: delivery.target_turn_id });
  if (delivery.outcome === 'confirmed' && delivery.matched_by === 'activity') {
    state.continuation_confirmed = true;
    state.status = 'ACTIVE'; state.phase = 'WORKER'; delete state.recovery_condition; delete state.last_error;
    const activity: ProviderActivity = { event_id: randomUUID(), type: 'activity', target_thread_id: options.identity.target_thread_id, target_session_id: options.identity.target_session_id, turn_id: delivery.target_turn_id, delivery_id: delivery.delivery_id, observed_at: new Date().toISOString(), details: { matched_by: delivery.matched_by } };
    state.provider = { ...(state.provider ?? createProviderState(receipt)), a_activity: activity, continuation_confirmation: activity, last_delivery: delivery, updated_at: new Date().toISOString() };
    persist(state, options, 'main_session_continuation_confirmed', { delivery_id: delivery.delivery_id, target_turn_id: delivery.target_turn_id, source: 'provider_activity' });
    return { outcome: 'confirmed', reason: 'Same-thread provider activity confirmed A execution.', delivery, activity, thread };
  }
  if (delivery.outcome === 'active_writer') {
    const reason = delivery.reason ?? 'The original A owns an active writer.'; setWaiting(state, 'recovery_active_writer', reason); return { outcome: 'waiting', reason, delivery, activity: null, thread };
  }
  if (delivery.outcome === 'not_found') {
    const sent = await provider.send({ target: options.identity, delivery_id: pending.delivery_id, message: pending.message });
    if (stale(state, options, taskVersion, generation, inputEpoch)) return { outcome: 'stale', reason: 'Provider send completed after the recovery generation changed.', delivery, activity: null, thread };
    delivery = { delivery_id: sent.delivery_id, outcome: sent.outcome === 'confirmed' ? 'confirmed' : sent.outcome === 'active-writer' ? 'active_writer' : sent.outcome === 'unavailable' ? 'unavailable' : sent.outcome === 'already-present' || sent.outcome === 'sent' ? 'sent' : 'unknown', matched_by: sent.outcome === 'confirmed' ? 'activity' : 'none', target_turn_id: sent.target_turn_id, reason: sent.reason, observed_at: sent.observed_at };
    state.provider = { ...(state.provider ?? createProviderState(receipt)), last_delivery: delivery, updated_at: new Date().toISOString() };
    persist(state, options, 'provider_delivery_sent', { delivery_id: sent.delivery_id, outcome: sent.outcome, target_turn_id: sent.target_turn_id });
    if (sent.outcome === 'confirmed') { state.continuation_confirmed = true; state.status = 'ACTIVE'; state.phase = 'WORKER'; delete state.recovery_condition; delete state.last_error; return { outcome: 'confirmed', reason: 'Provider returned explicit same-thread execution confirmation.', delivery, activity: null, thread }; }
  }
  const reason = delivery.reason ?? 'Delivery remains unconfirmed; recovery is waiting for same-thread activity or a native receipt.';
  setWaiting(state, delivery.outcome === 'unavailable' ? 'recovery_desktop_provider_unavailable' : 'recovery_delivery_unknown', reason);
  persist(state, options, 'provider_recovery_waiting', { delivery_id: delivery.delivery_id, outcome: delivery.outcome, reason });
  return { outcome: delivery.outcome === 'unavailable' ? 'unavailable' : 'waiting', reason, delivery, activity: null, thread };
}

export function invalidateProviderRecovery(state: MainSessionState, reason: string, kind: 'pause' | 'input' | 'contract' | 'done' = 'input'): void {
  state.input_epoch = (state.input_epoch ?? 0) + 1;
  state.run_generation = randomUUID();
  state.continuation_confirmed = false;
  if (state.provider) state.provider = { ...state.provider, status: 'disconnected', limitation_reason: reason, next_action: 'A new recovery generation must be probed before delivery.', updated_at: new Date().toISOString() };
  if (kind === 'pause') { state.status = 'PAUSED'; state.phase = 'IDLE'; state.pause_reason = 'user'; }
  else if (kind === 'done') { state.status = 'DONE'; state.phase = 'IDLE'; }
  else { state.phase = 'RECOVERING'; state.recovery_condition = { kind: 'provider_generation_invalidated', message: reason, resume_when: 'Probe the new generation before resuming provider delivery.' }; }
}
