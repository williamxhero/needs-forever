export interface Task {
  schema_version: 1;
  task_id: string;
  workspace: string;
  goal: string;
  acceptance: { id: string; text: string }[];
  authorization: string;
  verify?: { argv: string[]; timeout_seconds: number; protected_files: string[] };
  limits: { max_worker_turns: number | null; max_minutes: number | null };
}
export interface Decision {
  action: 'CONTINUE' | 'DONE' | 'WAIT_EXTERNAL';
  reason: string;
  evidence_ids: string[];
  next_message: string;
  external: { missing: string; attempted: string[]; why_no_other_work: string; resume_when: string } | null;
}
export interface PendingAction {
  delivery_id: string;
  source_turn_id: string | null;
  task_version: number;
  message: string;
  stage: 'prepared' | 'sent' | 'confirmed';
  target_turn_id: string | null;
}
export interface State {
  schema_version: 1;
  task_id: string;
  task_version: number;
  task: Task;
  worker_thread_id: string | null;
  status: 'ACTIVE' | 'WAIT_EXTERNAL' | 'PAUSED' | 'DONE';
  phase: 'WORKER' | 'JUDGE' | 'VERIFY' | 'RECOVERING' | 'IDLE';
  active_worker_turn_id: string | null;
  reviewing_turn_id: string | null;
  handled_turn_ids: string[];
  pending_action: PendingAction | null;
  retry: { kind: string | null; attempt: number; next_at: string | null };
  last_decision: Decision | null;
  worker_turn_count: number;
  elapsed_active_seconds: number;
  updated_at: string;
  codex_version: string | null;
  mode: 'live' | 'simulated';
  last_error?: string;
  pause_reason?: 'user' | 'user_limit';
}
export interface Snapshot {
  snapshot_id: string;
  task_id: string;
  task_version: number;
  worker_thread_id: string;
  worker_turn_id: string;
  task: Task;
  evidence: { id: string; type: string; value: unknown }[];
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string.`);
  return value;
}
