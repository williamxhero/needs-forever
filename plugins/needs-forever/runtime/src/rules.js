import { record, text } from './types.js';
export function reachedLimits(limits, usage) {
    return {
        turns: limits.max_worker_turns !== null && usage.worker_turn_count >= limits.max_worker_turns,
        time: limits.max_minutes !== null && usage.elapsed_active_seconds >= limits.max_minutes * 60,
    };
}
export function normalize(method, params) {
    if (method === 'item/started' || method === 'item/completed') {
        const data = record(params);
        const item = record(data.item);
        if (item.type !== 'userMessage' || typeof item.clientId !== 'string')
            return null;
        return { type: 'input', thread_id: text(data.threadId, 'threadId'), turn_id: text(data.turnId, 'turnId'), status: 'input', client_id: item.clientId, raw: params };
    }
    if (method !== 'turn/started' && method !== 'turn/completed')
        return null;
    const data = record(params);
    const turn = record(data.turn);
    return { type: method === 'turn/started' ? 'started' : 'completed', thread_id: text(data.threadId, 'threadId'), turn_id: text(turn.id, 'turn.id'), status: text(turn.status, 'turn.status'), raw: params };
}
export function selectAction(state, event) {
    if (state.status !== 'ACTIVE' || event.thread_id !== state.worker_thread_id)
        return 'ignore';
    if (state.handled_turn_ids.includes(event.turn_id) || state.reviewing_turn_id === event.turn_id)
        return 'ignore';
    if (event.type !== 'completed')
        return 'observe';
    if (state.active_worker_turn_id !== event.turn_id)
        return 'ignore';
    return 'judge';
}
