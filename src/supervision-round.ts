import { setTimeout as delay } from 'node:timers/promises';
import type { Decision, Snapshot } from './types.js';
import type { MainSessionState, StopRequest } from './main-session.js';
import { Store } from './store.js';
import { classifyRecoveryError, nextBackoff, recordRecoveryFailure, type RecoveryFailure } from './recovery.js';
import { plannerFailureFallback, prepareRouteExecution } from './route-execution.js';
import { redact } from './redact.js';
import { buildMainSessionSnapshot } from './main-supervision.js';

export interface SupervisionRoundContext {
  state: MainSessionState;
  request: StopRequest;
  fixture: any;
  signal: AbortSignal;
  store: Store;
  guarded: Store;
  delivery: string;
  valid: () => boolean;
  evaluate: (state: MainSessionState, request: StopRequest, fixture: any, signal: AbortSignal, store: Store, snapshot: Snapshot) => Promise<Decision>;
}

export interface SupervisionRoundResult {
  decision: Decision;
  correlation: ReturnType<typeof prepareRouteExecution>;
}

/** One admitted Stop round: C judgment, bounded recovery and result admission. */
export async function runSupervisionRound(context: SupervisionRoundContext): Promise<SupervisionRoundResult | null> {
  const { state, request, fixture, signal, store, guarded, delivery, valid, evaluate } = context;
  let decision: Decision;
  let correlation: ReturnType<typeof prepareRouteExecution> = {};
  let outputFailures = 0;
  if (state.mode === 'simulated' && !fixture?.app_server_argv && !fixture?.transport?.decision) throw new Error('Missing explicit simulated supervisor adapter; configure it before explicit resume.');
  while (true) {
    try {
      const snapshot = buildMainSessionSnapshot(state, request, store.events());
      decision = await evaluate(structuredClone(state), request, fixture, signal, guarded, snapshot);
      if (!valid()) return null;
      if (decision.action === 'CONTINUE') correlation = prepareRouteExecution(state, decision, snapshot, delivery, request.stop_attempt_id);
      break;
    } catch (error) {
      if (!valid() || signal.aborted) return null;
      const classification = classifyRecoveryError(error);
      state.recovery_failures = redact(recordRecoveryFailure((state.recovery_failures ?? []) as RecoveryFailure[], error)) as RecoveryFailure[];
      const backoff = nextBackoff((state.retry.attempt ?? 0) + 1);
      state.retry = { kind: classification.kind, attempt: backoff.attempt, next_at: backoff.next_at };
      store.save(state);
      store.event(state, 'main_session_retry', { ...classification, ...backoff, stop_attempt_id: request.stop_attempt_id });
      if (!classification.recoverable) throw error;
      if (++outputFailures >= 3) {
        const snapshot = buildMainSessionSnapshot(state, request, store.events());
        decision = plannerFailureFallback(snapshot, 'C failed three bounded output attempts; gather source-linked route facts.', state, { allowRecoveryOverride: true });
        correlation = prepareRouteExecution(state, decision, snapshot, delivery, request.stop_attempt_id, { plannerFallback: true });
        store.event(state, 'judge_inventory_fallback', { failures: outputFailures, stop_attempt_id: request.stop_attempt_id, decision, admission: 'bounded-diagnostic-recovery-override' });
        break;
      }
      const configuredDelay = state.mode === 'simulated' && Array.isArray(fixture?.recovery_delays_ms) ? Number(fixture.recovery_delays_ms[Math.min(outputFailures - 1, fixture.recovery_delays_ms.length - 1)]) : backoff.delay_seconds * 1000;
      await delay(Math.min(Math.max(0, configuredDelay), Math.max(1, Date.parse(request.deadline_at) - Date.now())), undefined, { signal });
    }
  }
  if (!valid()) return null;
  return { decision, correlation };
}
