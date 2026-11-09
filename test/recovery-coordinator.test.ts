import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRecoveryPlan, armRecovery, waitForNativeReceipt, cancelRecovery, recoveryCurrent, acquireRecoveryOwner, reconcileStaleOwner, reconcileRecoveryTick } from '../src/recovery-coordinator.js';
import type { MainSessionState } from '../src/main-session.js';

function state(name: string): MainSessionState {
  const workspace = resolve('runs/recovery-coordinator', `${name}-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  const task = { schema_version: 1 as const, task_id: name, workspace, goal: 'goal', acceptance: [{ id: 'A1', text: 'done' }], authorization: 'local', limits: { max_worker_turns: null, max_minutes: null } };
  const value = {
    schema_version: 1 as const, task_id: name, task_version: 1, task, worker_thread_id: null,
    status: 'ACTIVE' as const, phase: 'WORKER' as const, active_worker_turn_id: null, reviewing_turn_id: null,
    handled_turn_ids: [], pending_action: null, retry: { kind: null, attempt: 0, next_at: null }, last_decision: null,
    worker_turn_count: 0, elapsed_active_seconds: 0, updated_at: new Date().toISOString(), codex_version: null, mode: 'simulated' as const,
    control_mode: 'main-session' as const, main_session_id: `session-${name}`, run_generation: `generation-${name}`,
    contract_sha256: 'contract', binding: { status: 'BOUND' as const, tool_use_id: 'tool', bound_at: null, challenge: 'challenge', task_path: resolve(workspace, 'task.json') },
    host: { desktop_version: null, cli_version: null, hook_effective: false, source: 'simulated' as const, reason: 'test' },
  };
  writeFileSync(value.binding.task_path, JSON.stringify(task));
  return value;
}

test('automatic recovery persists bounded backoff and preserves generation across process reconstruction', () => {
  const value = state('backoff');
  value.recovery_plan = createRecoveryPlan(value, { kind: 'native_hook_required', message: 'waiting', resume_when: 'receipt' }, true);
  const first = armRecovery(value, { kind: 'controller_exit', message: 'B exited', resume_when: 'retry' }, 0);
  assert.equal(first.attempt, 1);
  assert.equal(first.next_retry_at, '1970-01-01T00:00:05.000Z');
  const restored = JSON.parse(JSON.stringify(value)) as typeof value;
  const second = armRecovery(restored, { kind: 'network', message: 'temporary', resume_when: 'retry' }, 5_000);
  assert.equal(second.generation, first.generation);
  assert.equal(second.attempt, 2);
  assert.equal(second.next_retry_at, '1970-01-01T00:00:20.000Z');
});

test('manual cancellation is a durable boundary that rejects stale recovery results', () => {
  const value = state('cancel');
  value.recovery_plan = createRecoveryPlan(value, { kind: 'controller_exit', message: 'B exited', resume_when: 'retry' });
  armRecovery(value, value.recovery_plan.reason, 0);
  const generation = value.recovery_plan.generation;
  cancelRecovery(value, 'pause', 1_000);
  assert.equal(value.recovery_plan.status, 'cancelled');
  assert.equal(value.recovery_plan.cancellation_boundary?.kind, 'pause');
  assert.equal(recoveryCurrent(value, { generation, task_version: 1 }), false);
  waitForNativeReceipt(value, { kind: 'native_hook_required', message: 'receipt', resume_when: 'receipt' });
  assert.equal(value.recovery_plan.status, 'cancelled', 'a late receipt must not clear a user cancellation');
});

test('only the current generation may acquire the recovery owner lease', () => {
  const value = state('lease');
  value.recovery_plan = createRecoveryPlan(value, { kind: 'controller_exit', message: 'B exited', resume_when: 'retry' });
  const owner = acquireRecoveryOwner(resolve(value.task.workspace, 'state.json'), value);
  assert.equal(owner.owner.generation, value.run_generation);
  owner.release();
  value.run_generation = 'new-generation';
  assert.throws(() => acquireRecoveryOwner(resolve(value.task.workspace, 'state.json'), value), /stale|cancelled/i);
});

test('a restarted process reconciles a dead owner into a pending native receipt without starting B/C', () => {
  const value = state('restart');
  value.recovery_plan = createRecoveryPlan(value, { kind: 'controller_exit', message: 'B exited', resume_when: 'receipt' });
  value.recovery_plan.owner = { id: 'old-owner', pid: 2_147_483_647, lease_path: 'old', task_version: 1, generation: value.run_generation, heartbeat_at: new Date(0).toISOString() };
  value.recovery_plan.status = 'running';
  value.controller = { id: 'old-controller', pid: 2_147_483_647, endpoint: 'old', token: 'old', lifecycle: 'running', started_at: new Date(0).toISOString(), run_generation: value.run_generation, plugin_root: value.task.workspace };
  const oldGeneration = value.run_generation;
  assert.equal(reconcileStaleOwner(value), true);
  assert.equal(value.phase, 'RECOVERING');
  assert.equal(value.binding.status, 'PENDING_NATIVE_HOOK');
  assert.equal(value.binding.operation, 'rebind');
  assert.equal(value.recovery_plan.status, 'waiting_native');
  assert.equal(value.recovery_plan.cancellation_boundary, null);
  assert.notEqual(value.run_generation, oldGeneration);
});

test('a detached coordinator consumes a due retry and rotates the native receipt fence without starting B/C', () => {
  const value = state('watchdog-tick');
  value.recovery_plan = createRecoveryPlan(value, { kind: 'controller_exit', message: 'B exited', resume_when: 'receipt' });
  value.recovery_plan.owner = null;
  value.recovery_plan.status = 'armed';
  value.recovery_plan.next_retry_at = new Date(0).toISOString();
  value.controller = { id: 'old-controller', pid: 2_147_483_647, endpoint: 'old', token: 'old', lifecycle: 'running', started_at: new Date(0).toISOString(), run_generation: value.run_generation, plugin_root: value.task.workspace };
  const statePath = resolve(value.task.workspace, 'state.json');
  writeFileSync(statePath, JSON.stringify(value));
  const oldGeneration = value.run_generation;
  const tick = reconcileRecoveryTick(statePath, 1_000);
  const saved = JSON.parse(readFileSync(statePath, 'utf8')) as MainSessionState;
  assert.equal(tick.waitingNative, true);
  assert.equal(saved.binding.status, 'PENDING_NATIVE_HOOK');
  assert.equal(saved.binding.operation, 'rebind');
  assert.equal(saved.recovery_plan?.status, 'waiting_native');
  assert.notEqual(saved.run_generation, oldGeneration);
  assert.equal(saved.controller?.lifecycle, 'exited');
});
