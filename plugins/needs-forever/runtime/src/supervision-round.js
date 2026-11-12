import { Store } from './store.js';
import { prepareRouteExecution } from './route-execution.js';
import { runJudgmentPolicy } from './judgment-round.js';
/** One admitted Stop round: B admits the request and applies C's result. */
export async function runSupervisionRound(context) {
    const { state, request, fixture, signal, store, guarded, delivery, valid, snapshot, evaluate } = context;
    if (state.mode === 'simulated' && !fixture?.app_server_argv && !fixture?.transport?.decision)
        throw new Error('Missing explicit simulated supervisor adapter; configure it before explicit resume.');
    const judged = await runJudgmentPolicy({ state, request, fixture, signal, store, guarded, valid, snapshot, evaluate });
    if (!judged || !valid())
        return null;
    const { decision, snapshot: judgedSnapshot } = judged;
    const correlation = decision.action === 'CONTINUE' ? prepareRouteExecution(state, decision, judgedSnapshot, delivery, request.stop_attempt_id, judged.plannerFallback ? { plannerFallback: true } : undefined) : {};
    return { decision, correlation };
}
