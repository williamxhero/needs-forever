import { Store } from './store.js';
import { prepareRouteExecution } from './route-execution.js';
import { runJudgmentPolicy } from './judgment-round.js';
function timestamp() { return new Date().toISOString(); }
function routeFields(value) {
    return {
        ...(value?.plan_id ? { plan_id: value.plan_id } : {}),
        ...(value?.route_id ? { route_id: value.route_id } : {}),
        ...(value?.planner_fallback ? { planner_fallback: true } : {}),
    };
}
/** Start the durable B-owned projection for exactly one native Stop. */
export function startSupervisionRound(state, request, store) {
    const existing = state.supervision_round;
    if (existing && existing.stop_attempt_id === request.stop_attempt_id && existing.run_generation === request.run_generation && existing.input_epoch === (state.input_epoch ?? 0) && existing.status !== 'cancelled' && existing.status !== 'interrupted') {
        if (existing.admission_count > 0 || existing.delivery_count > 0)
            throw new Error('Native Stop supervision round was already admitted; duplicate delivery is forbidden.');
        return existing;
    }
    const at = timestamp();
    const round = {
        stop_attempt_id: request.stop_attempt_id,
        run_generation: request.run_generation,
        task_version: request.task_version,
        input_epoch: state.input_epoch ?? 0,
        status: 'judging',
        admission_count: 0,
        delivery_count: 0,
        confirmation_count: 0,
        started_at: at,
        updated_at: at,
    };
    state.supervision_round = round;
    store.save(state);
    store.event(state, 'supervision_round_started', {
        stop_attempt_id: request.stop_attempt_id,
        run_generation: request.run_generation,
        input_epoch: state.input_epoch ?? 0,
        owner: 'supervision-round',
    });
    return round;
}
/** Record one successful B admission.  The count is a hard duplicate fence. */
export function recordSupervisionAdmission(state, request, decision, correlation, store) {
    const current = state.supervision_round;
    if (!current || current.stop_attempt_id !== request.stop_attempt_id || current.run_generation !== request.run_generation || current.task_version !== request.task_version || current.input_epoch !== (state.input_epoch ?? 0))
        throw new Error('Supervision admission fence is stale.');
    if (current.admission_count > 0)
        throw new Error('Native Stop admission already recorded.');
    current.admission_count = 1;
    current.status = 'admitted';
    current.decision_action = decision.action;
    Object.assign(current, routeFields(correlation));
    current.updated_at = timestamp();
    store.save(state);
    store.event(state, 'supervision_round_admitted', {
        stop_attempt_id: request.stop_attempt_id,
        run_generation: request.run_generation,
        input_epoch: state.input_epoch ?? 0,
        action: decision.action,
        ...routeFields(correlation),
        owner: 'supervision-round',
    });
}
/** Record the one native continuation delivery returned by B. */
export function recordSupervisionDelivery(state, request, deliveryId, store) {
    const current = state.supervision_round;
    if (!current || current.stop_attempt_id !== request.stop_attempt_id || current.run_generation !== request.run_generation || current.task_version !== request.task_version || current.input_epoch !== (state.input_epoch ?? 0))
        throw new Error('Supervision delivery fence is stale.');
    if (current.delivery_count > 0)
        throw new Error('Native Stop delivery already recorded.');
    if (current.admission_count !== 1)
        throw new Error('Native Stop delivery requires one admitted decision.');
    current.delivery_count = 1;
    current.delivery_id = deliveryId;
    current.status = 'delivered';
    current.updated_at = timestamp();
    store.save(state);
    store.event(state, 'supervision_round_delivery_recorded', {
        stop_attempt_id: request.stop_attempt_id,
        delivery_id: deliveryId,
        run_generation: request.run_generation,
        input_epoch: state.input_epoch ?? 0,
        owner: 'supervision-round',
    });
}
/** Confirm the one matching native A activity; late/foreign activity is ignored by lifecycle fences. */
export function recordSupervisionConfirmation(state, request, deliveryId, store) {
    const current = state.supervision_round;
    if (!current || current.stop_attempt_id !== request.stop_attempt_id || current.run_generation !== request.run_generation || current.task_version !== request.task_version || current.input_epoch !== (state.input_epoch ?? 0) || current.delivery_id !== deliveryId)
        return;
    if (current.confirmation_count > 0)
        return;
    current.confirmation_count = 1;
    current.status = 'confirmed';
    current.updated_at = timestamp();
    store.save(state);
    store.event(state, 'supervision_round_confirmation_recorded', {
        stop_attempt_id: request.stop_attempt_id,
        delivery_id: deliveryId,
        run_generation: request.run_generation,
        input_epoch: state.input_epoch ?? 0,
        owner: 'supervision-round',
    });
}
/** Fence all current-round outputs on pause, new input, recovery, or deletion. */
export function cancelSupervisionRound(state, store, reason) {
    const current = state.supervision_round;
    if (!current || current.status === 'cancelled' || current.status === 'terminal' || current.status === 'confirmed')
        return;
    current.status = 'cancelled';
    current.interruption_reason = reason;
    current.updated_at = timestamp();
    store.save(state);
    store.event(state, 'supervision_round_cancelled', {
        stop_attempt_id: current.stop_attempt_id,
        run_generation: current.run_generation,
        input_epoch: current.input_epoch,
        reason,
        owner: 'supervision-round',
    });
}
/** One admitted Stop round: B admits the request and applies C's result. */
export async function runSupervisionRound(context) {
    const { state, request, fixture, signal, store, guarded, delivery, valid, snapshot, evaluate } = context;
    if (state.mode === 'simulated' && !fixture?.app_server_argv && !fixture?.transport?.decision)
        throw new Error('Missing explicit simulated supervisor adapter; configure it before explicit resume.');
    startSupervisionRound(state, request, store);
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
        admit: (decision, judgedSnapshot) => {
            const correlation = prepareRouteExecution(state, decision, judgedSnapshot, delivery, request.stop_attempt_id);
            recordSupervisionAdmission(state, request, decision, correlation, store);
            return correlation;
        },
    });
    if (!judged || !valid())
        return null;
    const { decision } = judged;
    if (state.supervision_round?.admission_count === 0)
        recordSupervisionAdmission(state, request, decision, {}, store);
    const correlation = decision.action === 'CONTINUE' ? judged.admission : {};
    return { decision, correlation };
}
