import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Decision, State } from '../types.js';
import type {
  HumanEvent,
  RecoveryView,
  TaskRecord,
  TaskStateView,
  TaskSummary,
  TechnicalEvent,
  WorkRound,
} from './types.js';
import { SessionIdAllocator, routeAuditForRound, taskDirectory } from './projection.js';

/**
 * NFG's read-only view of a pi-nf task.
 *
 * pi-nf publishes its own audit projection at `<workspace>/.pi-nf/<task_id>/audit.json`.
 * It is computed from committed pi-durable state, never read back by pi-nf, and the
 * durable database remains the only authority. NFG renders the fields it already
 * has; a missing or malformed projection is simply not a discoverable task.
 */
export type PiNfAudit = {
  schema_version: 1;
  engine: 'pi-nf';
  generated_at: string;
  task_id: string;
  task_version: number;
  contract: {
    task_id: string;
    workspace: string;
    goal: string;
    acceptance: { id: string; text: string }[];
  };
  control: {
    status: string;
    phase: string;
    worker_turns: number;
    last_round_id: string | null;
    last_decision: { action: string; reason: string } | null;
    last_error: string | null;
    pause_reason: string | null;
    limit_reason: string | null;
    updated_at: string;
  };
  verification: { configured: boolean; baseline_count: number; state: string; last_result: unknown };
  rounds: PiNfAuditRound[];
  events: { type: string; at: string; details?: unknown }[];
};

export type PiNfAuditRound = {
  round_id: string;
  started_at: string;
  updated_at: string;
  status: 'open' | 'decided' | 'interrupted' | 'superseded';
  snapshot_id: string | null;
  evidence_count: number;
  /** Full pi-nf decision (diagnosis and route plan included) for NFG's route audit. */
  decision: Record<string, unknown> & { action: 'CONTINUE' | 'DONE' | 'WAIT_EXTERNAL' } | null;
  delivery: {
    stage: string;
    submission_id: string | null;
    submission_status: string | null;
    delivered: boolean;
    message: string;
    submitted_at: string | null;
    route_id: string | null;
    plan_id: string | null;
  } | null;
  verification: { passed: boolean; result: unknown; at: string } | null;
  errors: { type: string; at: string; message: string | null }[];
};

export type PiNfTaskDirectory = { taskId: string; directory: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseAudit(raw: unknown): PiNfAudit | null {
  const value = asRecord(raw);
  const contract = asRecord(value?.contract);
  const control = asRecord(value?.control);
  if (!value || value.schema_version !== 1 || value.engine !== 'pi-nf') return null;
  if (!text(value.task_id) || !contract || !text(contract.goal) || !text(contract.workspace)) return null;
  if (!control || !text(control.status) || !text(control.phase)) return null;
  return {
    schema_version: 1,
    engine: 'pi-nf',
    generated_at: text(value.generated_at) ?? new Date(0).toISOString(),
    task_id: text(value.task_id)!,
    task_version: number(value.task_version, 1),
    contract: {
      task_id: text(contract.task_id) ?? text(value.task_id)!,
      workspace: text(contract.workspace)!,
      goal: text(contract.goal)!,
      acceptance: array(contract.acceptance).flatMap((item) => {
        const entry = asRecord(item);
        const id = text(entry?.id);
        const description = text(entry?.text);
        return id && description ? [{ id, text: description }] : [];
      }),
    },
    control: {
      status: text(control.status)!,
      phase: text(control.phase)!,
      worker_turns: number(control.worker_turns),
      last_round_id: text(control.last_round_id),
      last_decision: (() => {
        const decision = asRecord(control.last_decision);
        const action = text(decision?.action);
        const reason = text(decision?.reason);
        return action && reason ? { action, reason } : null;
      })(),
      last_error: text(control.last_error),
      pause_reason: text(control.pause_reason),
      limit_reason: text(control.limit_reason),
      updated_at: text(control.updated_at) ?? text(value.generated_at) ?? new Date(0).toISOString(),
    },
    verification: {
      configured: asRecord(value.verification)?.configured === true,
      baseline_count: number(asRecord(value.verification)?.baseline_count),
      state: text(asRecord(value.verification)?.state) ?? 'not_configured',
      last_result: asRecord(value.verification)?.last_result ?? null,
    },
    rounds: array(value.rounds).flatMap((item): PiNfAuditRound[] => {
      const round = asRecord(item);
      const roundId = text(round?.round_id);
      if (!round || !roundId) return [];
      const decision = asRecord(round.decision);
      const action = text(decision?.action);
      const delivery = asRecord(round.delivery);
      const verification = asRecord(round.verification);
      const errors = array(round.errors).flatMap((entry) => {
        const error = asRecord(entry);
        const type = text(error?.type);
        return type ? [{ type, at: text(error?.at) ?? new Date(0).toISOString(), message: text(error?.message) }] : [];
      });
      return [{
        round_id: roundId,
        started_at: text(round.started_at) ?? new Date(0).toISOString(),
        updated_at: text(round.updated_at) ?? text(round.started_at) ?? new Date(0).toISOString(),
        status: round.status === 'open' || round.status === 'decided' || round.status === 'interrupted' || round.status === 'superseded' ? round.status : 'open',
        snapshot_id: text(round.snapshot_id),
        evidence_count: number(round.evidence_count),
        decision: action === 'CONTINUE' || action === 'DONE' || action === 'WAIT_EXTERNAL'
          ? { ...decision, action }
          : null,
        delivery: delivery
          ? {
            stage: text(delivery.stage) ?? 'submitted',
            submission_id: text(delivery.submission_id),
            submission_status: text(delivery.submission_status),
            delivered: delivery.delivered === true,
            message: text(delivery.message) ?? '',
            submitted_at: text(delivery.submitted_at),
            route_id: text(delivery.route_id),
            plan_id: text(delivery.plan_id),
          }
          : null,
        verification: verification
          ? { passed: verification.passed === true, result: verification.result ?? null, at: text(verification.at) ?? new Date(0).toISOString() }
          : null,
        errors,
      }];
    }),
    events: array(value.events).flatMap((item) => {
      const event = asRecord(item);
      const type = text(event?.type);
      if (!type) return [];
      return [{ type, at: text(event?.at) ?? new Date(0).toISOString(), details: event?.details }];
    }),
  };
}

export function readPiNfAudit(directory: string): PiNfAudit | null {
  const path = resolve(directory, 'audit.json');
  if (!existsSync(path)) return null;
  try {
    return parseAudit(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Discover `<workspace>/.pi-nf/<task_id>/audit.json` projections read-only. */
export function piNfTaskDirectories(workspace: string): PiNfTaskDirectory[] {
  const root = resolve(workspace, '.pi-nf');
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const tasks: PiNfTaskDirectory[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let directory: string;
    try { directory = taskDirectory(root, entry.name); } catch { continue; }
    if (existsSync(resolve(directory, 'audit.json'))) tasks.push({ taskId: entry.name, directory });
  }
  return tasks;
}

const PI_NF_STATUS: Record<string, State['status']> = {
  ACTIVE: 'ACTIVE',
  JUDGING: 'ACTIVE',
  WAIT_EXTERNAL: 'WAIT_EXTERNAL',
  PAUSED: 'PAUSED',
  DONE: 'DONE',
  INTERRUPTED: 'INTERRUPTED',
};

const PI_NF_PHASE: Record<string, State['phase']> = {
  IDLE: 'IDLE',
  WORKER: 'WORKER',
  JUDGE: 'JUDGE',
  VERIFY: 'VERIFY',
  RECOVERING: 'RECOVERING',
};

function status(audit: PiNfAudit): State['status'] {
  return PI_NF_STATUS[audit.control.status] ?? 'ACTIVE';
}

function phase(audit: PiNfAudit): State['phase'] {
  return PI_NF_PHASE[audit.control.phase] ?? 'IDLE';
}

function lastResult(audit: PiNfAudit): string {
  return audit.control.last_decision?.action ?? status(audit);
}

function human(input: {
  at: string;
  role: HumanEvent['role'];
  eventType: string;
  summary: string;
  result?: string | null;
  details?: Record<string, unknown>;
}): TechnicalEvent {
  return {
    at: input.at,
    role: input.role,
    eventType: input.eventType,
    summary: input.summary,
    result: input.result ?? null,
    details: { runtime: 'pi-nf', ...(input.details ?? {}) },
    threadId: null,
    turnId: null,
    deliveryId: null,
    snapshotId: null,
  };
}

const ERROR_SUMMARY: Record<string, string> = {
  'nf.judge_retry': 'C 输出被拒绝，重试判断',
  'nf.judge_rejected': 'C 输出被拒绝，任务中断',
  'nf.judge_interrupted': 'C 判断中断',
  'nf.snapshot_failed': '证据快照失败',
  'nf.verification_interrupted': '验证中断',
  'nf.verification_missing_baseline': '验证缺少保护基线',
};

function buildRound(audit: PiNfAudit, round: PiNfAuditRound): WorkRound {
  const decisionAt = audit.events.find((event) => event.type === 'nf.decision'
    && (asRecord(event.details)?.round_id === round.round_id))?.at ?? round.updated_at;
  const started = human({
    at: round.started_at,
    role: 'worker',
    eventType: 'nf.judge_started',
    summary: 'A 完成本轮；B 记录证据并启动独立判断 C',
    details: {
      round_id: round.round_id,
      snapshot_id: round.snapshot_id,
      evidence_count: round.evidence_count,
    },
  });
  const supervisor: TechnicalEvent[] = [];
  let decisionEvent: TechnicalEvent | null = null;
  if (round.decision) {
    decisionEvent = human({
      at: decisionAt,
      role: 'supervisor',
      eventType: 'decision',
      summary: `C 判断：${round.decision.action}`,
      result: round.decision.action,
      details: {
        round_id: round.round_id,
        snapshot_id: round.snapshot_id,
        decision: round.decision,
      },
    });
    decisionEvent.snapshotId = round.snapshot_id;
    supervisor.push(decisionEvent);
  }
  if (round.verification) {
    supervisor.push(human({
      at: round.verification.at,
      role: 'supervisor',
      eventType: 'verification_result',
      summary: round.verification.passed ? '独立验证通过' : '独立验证失败',
      result: round.verification.passed ? 'PASS' : 'FAIL',
      details: { round_id: round.round_id, passed: round.verification.passed, result: round.verification.result },
    }));
  }
  for (const error of round.errors) {
    supervisor.push(human({
      at: error.at,
      role: 'supervisor',
      eventType: error.type,
      summary: ERROR_SUMMARY[error.type] ?? error.type.replaceAll('_', ' '),
      result: error.type === 'nf.judge_retry' ? null : 'INTERRUPTED',
      details: { round_id: round.round_id, error: error.message },
    }));
  }
  const continuation: TechnicalEvent[] = [];
  if (round.delivery) {
    const deliveryId = round.delivery.submission_id ?? `${round.round_id}:direction`;
    const at = round.delivery.submitted_at ?? decisionAt;
    const prepared = human({
      at,
      role: 'worker',
      eventType: 'send_prepared',
      summary: 'NF 已提交方向',
      result: 'PREPARED',
      details: {
        round_id: round.round_id,
        message: round.delivery.message,
        submission_id: round.delivery.submission_id,
        submission_status: round.delivery.submission_status,
        route_id: round.delivery.route_id,
        plan_id: round.delivery.plan_id,
      },
    });
    prepared.deliveryId = deliveryId;
    continuation.push(prepared);
    if (round.delivery.delivered) {
      const confirmed = human({
        at,
        role: 'worker',
        eventType: 'send_confirmed',
        summary: 'A 已接收方向',
        result: 'CONFIRMED',
        details: { round_id: round.round_id, message: round.delivery.message, submission_status: round.delivery.submission_status },
      });
      confirmed.deliveryId = deliveryId;
      continuation.push(confirmed);
    }
  }
  const technicalEvents = [started, ...supervisor, ...continuation].sort((left, right) => left.at.localeCompare(right.at));
  const roundValue: WorkRound = {
    id: round.round_id,
    startedAt: technicalEvents[0]?.at ?? round.started_at,
    endedAt: technicalEvents.at(-1)?.at ?? round.updated_at,
    worker: started,
    stop: started,
    supervisor,
    continuation,
    result: decisionEvent ?? supervisor.at(-1) ?? null,
    routeAudit: null,
    technicalEvents,
  };
  roundValue.routeAudit = routeAuditForRound(roundValue);
  return roundValue;
}

function rounds(audit: PiNfAudit): WorkRound[] {
  return audit.rounds
    .filter((round) => round.decision !== null || round.errors.length > 0 || round.verification !== null)
    .map((round) => buildRound(audit, round));
}

function stateView(audit: PiNfAudit, title: string, sessionId: string): TaskStateView {
  const taskStatus = status(audit);
  const taskPhase = phase(audit);
  const pauseReason: State['pause_reason'] | null = audit.control.pause_reason === 'user_limit'
    ? 'user_limit'
    : audit.control.pause_reason === 'user'
      ? 'user'
      : null;
  const cancellationBoundary: RecoveryView['cancellationBoundary'] = taskStatus === 'INTERRUPTED'
    ? 'interrupted'
    : taskStatus === 'DONE'
      ? 'done'
      : pauseReason === 'user_limit'
        ? 'user_limit'
        : pauseReason === 'user'
          ? 'user_pause'
          : 'none';
  const recovery: RecoveryView = {
    phase: taskPhase,
    source: cancellationBoundary,
    reason: cancellationBoundary === 'none' ? null : audit.control.last_error ?? audit.control.limit_reason,
    kind: null,
    attempt: 0,
    nextRetryAt: null,
    nativeReceipt: 'not_required',
    cancellationBoundary,
  };
  const summary = audit.control.last_decision;
  const lastDecision: State['last_decision'] = summary
    && (summary.action === 'CONTINUE' || summary.action === 'DONE' || summary.action === 'WAIT_EXTERNAL')
    ? {
      action: summary.action as Decision['action'],
      reason: summary.reason,
      evidence_ids: [],
      next_message: '',
      external: null,
    }
    : null;
  return {
    title,
    sessionId,
    taskId: audit.task_id,
    status: taskStatus,
    phase: taskPhase,
    mode: 'live',
    goal: audit.contract.goal,
    workspace: audit.contract.workspace,
    acceptance: audit.contract.acceptance,
    workerThreadId: null,
    workerTurnCount: audit.control.worker_turns,
    updatedAt: audit.control.updated_at,
    lastDecision,
    retry: { kind: null, attempt: 0, next_at: null },
    lastError: audit.control.last_error,
    pauseReason,
    recoveryCondition: null,
    recoveryPlan: null,
    recovery,
    recoveryPhase: recovery.phase,
    recoverySource: recovery.source,
    recoveryReason: recovery.reason,
    recoveryAttempt: recovery.attempt,
    nextRetryAt: recovery.nextRetryAt,
    nativeReceipt: recovery.nativeReceipt,
    cancellationBoundary: recovery.cancellationBoundary,
    supervisionRound: null,
    provider: null,
  };
}

export function piNfSummary(audit: PiNfAudit, sessions: SessionIdAllocator): TaskSummary {
  const taskStatus = status(audit);
  const sessionId = sessions.assign(`pi-nf:${audit.task_id}`, taskStatus, audit.task_id);
  return {
    title: audit.task_id,
    sessionId,
    taskId: audit.task_id,
    status: taskStatus,
    phase: phase(audit),
    updatedAt: audit.control.updated_at,
    lastResult: lastResult(audit),
  };
}

export function piNfRecord(audit: PiNfAudit, sessions: SessionIdAllocator): TaskRecord {
  const taskStatus = status(audit);
  const sessionId = sessions.assign(`pi-nf:${audit.task_id}`, taskStatus, audit.task_id);
  const taskRounds = rounds(audit);
  return {
    title: audit.task_id,
    sessionId,
    taskId: audit.task_id,
    state: stateView(audit, audit.task_id, sessionId),
    summary: '',
    rounds: taskRounds,
    eventCount: audit.events.length,
    snapshotIds: [...new Set(taskRounds.flatMap((round) => round.technicalEvents.flatMap((event) => event.snapshotId ?? [])))],
    updatedAt: audit.control.updated_at,
  };
}
