import type { Decision } from './types.js';
import type { MainSessionState, StopRequest } from './main-session.js';
import { Store } from './store.js';
import { prepareRouteExecution } from './route-execution.js';
import { runJudgmentPolicy } from './judgment-round.js';

export interface SupervisionRoundContext {
  state: MainSessionState;
  request: StopRequest;
  fixture: any;
  signal: AbortSignal;
  store: Store;
  guarded: Store;
  delivery: string;
  valid: () => boolean;
  snapshot: () => import('./types.js').Snapshot;
  evaluate: (state: MainSessionState, request: StopRequest, fixture: any, signal: AbortSignal, store: Store, snapshot: import('./types.js').Snapshot) => Promise<Decision>;
}

export interface SupervisionRoundResult {
  decision: Decision;
  correlation: ReturnType<typeof prepareRouteExecution>;
}

/** One admitted Stop round: B admits the request and applies C's result. */
export async function runSupervisionRound(context: SupervisionRoundContext): Promise<SupervisionRoundResult | null> {
  const { state, request, fixture, signal, store, guarded, delivery, valid, snapshot, evaluate } = context;
  if (state.mode === 'simulated' && !fixture?.app_server_argv && !fixture?.transport?.decision) throw new Error('Missing explicit simulated supervisor adapter; configure it before explicit resume.');
  const judged = await runJudgmentPolicy({
    state,
    request,
    fixture,
    signal,
    store,
    guarded,
    valid,
    snapshot,
    evaluate,
    admit: (decision, judgedSnapshot) => prepareRouteExecution(state, decision, judgedSnapshot, delivery, request.stop_attempt_id),
  });
  if (!judged || !valid()) return null;
  const { decision } = judged;
  const correlation = decision.action === 'CONTINUE' ? (judged.admission as ReturnType<typeof prepareRouteExecution>) : {};
  return { decision, correlation };
}
