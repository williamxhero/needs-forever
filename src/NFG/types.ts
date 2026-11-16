import type { State } from '../types.js';
import type { RouteStatus } from '../route-contract.js';
import type { MainSessionProviderState } from '../main-session-provider.js';

export interface TaskStateView {
  title: string;
  sessionId: string;
  taskId: string;
  status: State['status'];
  phase: State['phase'];
  mode: State['mode'];
  goal: string;
  workspace: string;
  acceptance: { id: string; text: string }[];
  workerThreadId: string | null;
  workerTurnCount: number;
  updatedAt: string;
  lastDecision: State['last_decision'];
  retry: State['retry'];
  lastError: string | null;
  pauseReason: State['pause_reason'] | null;
  recoveryCondition: State['recovery_condition'] | null;
  recoveryPlan: State['recovery_plan'] | null;
  /** A stable, UI-facing projection of automatic recovery and cancellation. */
  recovery: RecoveryView;
  recoveryPhase: State['phase'];
  recoverySource: RecoveryView['source'];
  recoveryReason: string | null;
  recoveryAttempt: number;
  nextRetryAt: string | null;
  nativeReceipt: RecoveryView['nativeReceipt'];
  cancellationBoundary: RecoveryView['cancellationBoundary'];
  supervisionRound: State['supervision_round'] | null;
  provider: MainSessionProviderState | null;
}

export interface RecoveryView {
  phase: State['phase'];
  source: 'automatic' | 'user_pause' | 'user_limit' | 'delete' | 'done' | 'interrupted' | 'none';
  reason: string | null;
  kind: string | null;
  attempt: number;
  nextRetryAt: string | null;
  nativeReceipt: 'waiting' | 'received' | 'not_required';
  cancellationBoundary: 'none' | 'user_pause' | 'user_limit' | 'delete' | 'done' | 'interrupted';
}

export interface HumanEvent {
  at: string;
  role: 'worker' | 'supervisor' | 'system';
  eventType: string;
  summary: string;
  result: string | null;
  details: Record<string, unknown>;
}

export interface TechnicalEvent extends HumanEvent {
  threadId: string | null;
  turnId: string | null;
  deliveryId: string | null;
  snapshotId: string | null;
}

export interface WorkRound {
  id: string;
  startedAt: string;
  endedAt: string;
  worker: HumanEvent | null;
  stop: HumanEvent | null;
  supervisor: HumanEvent[];
  continuation: HumanEvent[];
  result: HumanEvent | null;
  routeAudit: RouteAuditView | null;
  technicalEvents: TechnicalEvent[];
}

/** Historical display only: this projection never validates or authorizes execution. */
export interface RouteAuditView {
  kind: 'c2' | 'legacy';
  planId: string;
  selectedRouteId: string;
  diagnosis: { class: string; statement: string; evidenceIds: string[] };
  selectionReason: string;
  singleRouteReason: string | null;
  candidates: {
    routeId: string;
    title: string;
    resource: string;
    hypothesis: string;
    status: RouteStatus;
    evidenceIds: string[];
    actions: string[];
    expectedEvidence: string[];
    expectedSignal: string;
    risk: string;
    fallback: { routeId: string | null; when: string };
    discriminatingCheck: string | null;
  }[];
  successCondition: string;
  stopCondition: string;
}

export interface TaskSummary {
  title: string;
  sessionId: string;
  taskId: string;
  status: State['status'];
  phase: State['phase'];
  updatedAt: string;
  lastResult: string;
}

export interface TaskRecord {
  title: string;
  sessionId: string;
  taskId: string;
  state: TaskStateView;
  summary: string;
  rounds: WorkRound[];
  eventCount: number;
  snapshotIds: string[];
  updatedAt: string;
}

export interface TaskCatalogOptions {
  workspace: string;
  /** Additional workspace roots managed by the global daemon. */
  workspaces?: string[];
}
