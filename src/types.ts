import type { C2Context, C2Mode, Diagnosis, RoutePlan } from './planning-contract.js';
import type { RouteCatalogData, RouteLedgerData } from './route-contract.js';
import type { RouteEvidence, RouteIdentity } from './route-contract.js';
export interface RouteCorrelation { plan_id?: string; route_id?: string; source_stop_attempt_id?: string }
export interface RouteExecution extends RouteCorrelation {
  delivery_id: string;
  task_version: number;
  route: RouteIdentity;
  evidence: RouteEvidence[];
  confirmed: boolean;
  lifecycle_fence: string;
  discriminating_check?: import('./route-contract.js').RouteDiscriminatingCheck;
  completed_stop_attempt_id?: string;
}
export interface Task {
  schema_version: 1;
  task_id: string;
  workspace: string;
  goal: string;
  acceptance: { id: string; text: string }[];
  authorization: string;
  c2?: { mode: C2Mode };
  verify?: { argv: string[]; timeout_seconds: number; protected_files: string[] };
  limits: { max_worker_turns: number | null; max_minutes: number | null };
}
export interface Decision {
  action: 'CONTINUE' | 'DONE' | 'WAIT_EXTERNAL';
  reason: string;
  evidence_ids: string[];
  next_message: string;
  external: { missing: string; attempted: string[]; why_no_other_work: string; resume_when: string } | null;
  diagnosis?: Diagnosis | null;
  route_plan?: RoutePlan | null;
}
export interface PendingAction extends RouteCorrelation {
  delivery_id: string;
  source_turn_id: string | null;
  task_version: number;
  message: string;
  stage: 'prepared' | 'sent' | 'confirmed';
  target_turn_id: string | null;
}
/** Durable ownership and retry contract for the automatic recovery loop.
 *
 * The plan deliberately lives beside the ordinary retry field.  `retry` is
 * the short lived C/judge backoff; this record is the cross-process lifecycle
 * boundary used when B, the host, or the installed plugin disappears.
 */
export interface RecoveryPlan {
  owner: { id: string; pid: number; lease_path: string; task_version: number; generation: string; heartbeat_at: string } | null;
  generation: string;
  task_version: number;
  attempt: number;
  next_retry_at: string | null;
  reason: { kind: string; message: string; resume_when: string };
  status: 'armed' | 'waiting_native' | 'running' | 'cancelled';
  cancellation_boundary: { kind: 'pause' | 'delete' | 'done'; at: string; generation: string } | null;
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
  judge_thread_ids?: string[];
  protected_baseline?: { path: string; sha256: string; content_base64: string }[];
  recovery_failures?: { signature: string; kind: string; count: number; message: string; instruction: string; at: string }[];
  recovery_condition?: { kind: string; message: string; resume_when: string };
  recovery_plan?: RecoveryPlan;
  route_catalog?: RouteCatalogData;
  route_probe?: { state_path: string; nonce: string; scope_sha256: string; argv_prefix: string[] };
  route_ledger?: RouteLedgerData;
  route_execution?: RouteExecution;
}
export interface Snapshot {
  snapshot_id: string;
  task_id: string;
  task_version: number;
  worker_thread_id: string;
  worker_turn_id: string;
  task: Task;
  evidence: { id: string; type: string; value: unknown; source?: { event_id: string; observed_at?: string; thread_id?: string; turn_id?: string; item_id?: string } }[];
  plan?: unknown;
  recent_verification?: unknown;
  recent_instructions?: unknown[];
  repeated_failure?: unknown;
  omissions?: string[];
  evidence_complete?: boolean;
  c2?: C2Context;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string.`);
  return value;
}
