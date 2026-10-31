import { record, text } from './types.js';
import type { State } from './types.js';

export interface WorkerEvent { type: 'started' | 'completed' | 'input'; thread_id: string; turn_id: string; status: string; client_id?: string; raw: unknown }
export function normalize(method: string, params: unknown): WorkerEvent | null {
  if (method === 'item/started' || method === 'item/completed') {
    const data = record(params);
    const item = record(data.item);
    if (item.type !== 'userMessage' || typeof item.clientId !== 'string') return null;
    return { type: 'input', thread_id: text(data.threadId, 'threadId'), turn_id: text(data.turnId, 'turnId'), status: 'input', client_id: item.clientId, raw: params };
  }
  if (method !== 'turn/started' && method !== 'turn/completed') return null;
  const data = record(params);
  const turn = record(data.turn);
  return { type: method === 'turn/started' ? 'started' : 'completed', thread_id: text(data.threadId, 'threadId'), turn_id: text(turn.id, 'turn.id'), status: text(turn.status, 'turn.status'), raw: params };
}
export function selectAction(state: State, event: WorkerEvent): 'ignore' | 'observe' | 'judge' {
  if (state.status !== 'ACTIVE' || event.thread_id !== state.worker_thread_id) return 'ignore';
  if (state.handled_turn_ids.includes(event.turn_id) || state.reviewing_turn_id === event.turn_id) return 'ignore';
  if (event.type !== 'completed') return 'observe';
  if (state.active_worker_turn_id !== event.turn_id) return 'ignore';
  return 'judge';
}
