import { setTimeout as delay } from 'node:timers/promises';
import { AppServerJudge, archiveTerminatedJudge, validateDecision } from './judge.js';
import { connect, type Rpc } from './transport.js';
import { Store } from './store.js';
import { classifyRecoveryError, nextBackoff, recordRecoveryFailure, type RecoveryFailure } from './recovery.js';
import { plannerFailureFallback } from './route-execution.js';
import { redact } from './redact.js';
import type { Decision, Snapshot } from './types.js';
import type { MainSessionState, StopRequest } from './main-session.js';
import { completionGate, continueWith } from './completion-gate.js';

export interface JudgmentRoundContext {
  state: MainSessionState;
  request: StopRequest;
  fixture: any;
  signal: AbortSignal;
  store: Store;
  snapshot: Snapshot;
  command: string[];
}

export interface JudgmentPolicyContext {
  state: MainSessionState;
  request: StopRequest;
  fixture: any;
  signal: AbortSignal;
  store: Store;
  guarded: Store;
  valid: () => boolean;
  snapshot: () => Snapshot;
  evaluate: (state: MainSessionState, request: StopRequest, fixture: any, signal: AbortSignal, store: Store, snapshot: Snapshot) => Promise<Decision>;
}

export interface JudgmentPolicyResult {
  decision: Decision;
  snapshot: Snapshot;
  plannerFallback?: boolean;
}

/**
 * Own one fresh, read-only C judgment round for one admitted native Stop.
 * B supplies the snapshot and fence; this module owns C transport, event
 * pumping, validation, archive cleanup and the completion gate handoff.
 */
export async function runJudgmentRound(context: JudgmentRoundContext): Promise<Decision> {
  const { state, request, fixture, signal, store, snapshot, command } = context;
  store.snapshot(snapshot, null);
  const connection = await connect(command, state.task.workspace, signal);
  const timeout = state.mode === 'simulated' && Number.isFinite(fixture?.judge_timeout_ms) ? Math.max(1, Number(fixture.judge_timeout_ms)) : 120_000;
  const judge = new AppServerJudge(Math.min(timeout, Math.max(1, Date.parse(request.deadline_at) - Date.now() - 1_000)), connection.model);
  judge.bind(connection.rpc, (type, details) => {
    if (type === 'judge_created' && typeof details.thread_id === 'string') {
      state.judge_thread_ids ??= [];
      state.judge_thread_ids.push(details.thread_id);
      if (!signal.aborted && state.status === 'ACTIVE') store.save(state);
    }
    store.event(state, type, { ...details, stop_attempt_id: request.stop_attempt_id, main_session_id: state.main_session_id });
  }, (threadId) => archiveTerminatedJudge(command, state.task.workspace, threadId));
  connection.rpc.setRequestHandler((_id, method, params) => judge.serverRequest(method, params));
  const pump = (async () => {
    try {
      while (true) {
        const event = await connection.rpc.next();
        judge.observe(event.method, event.params);
      }
    } catch (error) {
      judge.connectionFailed(error as Error);
    }
  })();
  try {
    let decision: Decision;
    try {
      const rawDecision = await judge.judge(snapshot, signal);
      const rawNextMessage = rawDecision.action === 'CONTINUE' ? rawDecision.next_message : null;
      decision = validateDecision(JSON.stringify(rawDecision), snapshot);
      if (rawNextMessage !== decision.next_message) {
        store.event(state, 'judge_decision_normalized', {
          stop_attempt_id: request.stop_attempt_id,
          snapshot_id: snapshot.snapshot_id,
          plan_id: decision.route_plan?.plan_id ?? null,
          selected_route_id: decision.route_plan?.selected_route_id ?? null,
          raw_next_message: rawNextMessage,
          canonical_next_message: decision.next_message,
          reason: 'selected_route_actions_are_authoritative',
        });
      }
      store.snapshot(snapshot, judge.rawOutput, 'valid');
    } catch (error) {
      store.snapshot(snapshot, judge.rawOutput, 'invalid');
      if (!signal.aborted && judge.rawOutput && /evidence|worker claims|unknown evidence/i.test((error as Error).message)) {
        decision = continueWith(snapshot, `Gather concise structured tool or file-check evidence for every original acceptance item (${state.task.acceptance.map((item) => item.id).join(', ')}). Check remaining authorized routes and implement unfinished work; a final assistant claim alone cannot establish completion or external waiting. Rejected audit: ${(error as Error).message}`, 'Supervisor terminal decision lacked sufficient independent evidence.');
      } else throw error;
    }
    signal.throwIfAborted();
    store.event(state, 'decision', { role: 'judge', thread_id: state.judge_thread_ids?.at(-1), snapshot_id: snapshot.snapshot_id, stop_attempt_id: request.stop_attempt_id, worker_thread_id: state.main_session_id, decision });
    decision = await completionGate({ state, snapshot, store, rpc: connection.rpc, signal }, decision);
    signal.throwIfAborted();
    return decision;
  } finally {
    await connection.rpc.close();
    await pump;
  }
}

/** C owns bounded retry, timeout recovery and deterministic fallback for one Stop. */
export async function runJudgmentPolicy(context: JudgmentPolicyContext): Promise<JudgmentPolicyResult | null> {
  const { state, request, fixture, signal, store, guarded, valid, snapshot, evaluate } = context;
  let outputFailures = 0;
  while (true) {
    try {
      const currentSnapshot = snapshot();
      const decision = await evaluate(structuredClone(state), request, fixture, signal, guarded, currentSnapshot);
      if (!valid()) return null;
      return { decision, snapshot: currentSnapshot };
    } catch (error) {
      if (!valid() || signal.aborted) return null;
      const classification = classifyRecoveryError(error);
      state.recovery_failures = redact(recordRecoveryFailure((state.recovery_failures ?? []) as RecoveryFailure[], error)) as RecoveryFailure[];
      const backoff = nextBackoff((state.retry.attempt ?? 0) + 1);
      state.retry = { kind: classification.kind, attempt: backoff.attempt, next_at: backoff.next_at };
      store.save(state);
      store.event(state, 'main_session_retry', { ...classification, ...backoff, stop_attempt_id: request.stop_attempt_id });
      if (!classification.recoverable) throw error;
      outputFailures++;
      if (outputFailures >= 3) {
        const fallbackSnapshot = snapshot();
        const decision = plannerFailureFallback(fallbackSnapshot, 'C failed three bounded output attempts; gather source-linked route facts.', state, { allowRecoveryOverride: true });
        store.event(state, 'judge_inventory_fallback', { failures: outputFailures, stop_attempt_id: request.stop_attempt_id, decision, admission: 'bounded-diagnostic-recovery-override' });
        return { decision, snapshot: fallbackSnapshot, plannerFallback: true };
      }
      const configuredDelay = state.mode === 'simulated' && Array.isArray(fixture?.recovery_delays_ms) ? Number(fixture.recovery_delays_ms[Math.min(outputFailures - 1, fixture.recovery_delays_ms.length - 1)]) : backoff.delay_seconds * 1000;
      await delay(Math.min(Math.max(0, configuredDelay), Math.max(1, Date.parse(request.deadline_at) - Date.now())), undefined, { signal });
    }
  }
}
