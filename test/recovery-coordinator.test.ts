import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRecoveryPlan, armRecovery, waitForNativeReceipt, cancelRecovery, recoveryCurrent, acquireRecoveryOwner, reconcileStaleOwner, reconcileRecoveryTick, resetRecoveryWindow, extendRecoveryWindowForActiveWriter, interruptRecovery } from '../src/recovery-coordinator.js';
import type { MainSessionState } from '../src/main-session.js';
import { Store } from '../src/store.js';
import { spawnSync } from 'node:child_process';
import { handleLifecycle } from '../src/lifecycle.js';
import { armNativeRebind } from '../src/main-session.js';

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

test('active-writer evidence extends recovery in bounded audited-sized steps and caps at ten minutes', () => {
  const value = state('active-writer-window');
  value.phase = 'RECOVERING';
  value.recovery_window = { started_at: new Date(0).toISOString(), deadline_at: new Date(120_000).toISOString() };
  const first = extendRecoveryWindowForActiveWriter(value, 120_000, 5_000);
  assert.equal(first?.extended, true);
  assert.equal(first?.previous_deadline_at, new Date(120_000).toISOString());
  assert.equal(first?.deadline_at, new Date(180_000).toISOString());
  assert.equal(first?.active_writer_started_at, new Date(120_000).toISOString());
  assert.equal(first?.active_writer_max_deadline_at, new Date(720_000).toISOString());
  const second = extendRecoveryWindowForActiveWriter(value, 180_000, 15_000);
  assert.equal(second?.extended, true);
  assert.equal(second?.deadline_at, new Date(240_000).toISOString());
  value.recovery_window.deadline_at = new Date(720_000).toISOString();
  const capped = extendRecoveryWindowForActiveWriter(value, 720_000, 60_000);
  assert.equal(capped?.extended, false);
  assert.equal(capped?.capped, true);
  assert.equal(value.recovery_window.active_writer_capped_at, new Date(720_000).toISOString());
});

test('active-writer timeout reports the bounded ten-minute window instead of the base two-minute window', () => {
  const value = state('active-writer-timeout-reason');
  value.phase = 'RECOVERING';
  value.recovery_condition = { kind: 'recovery_active_writer', message: '原始 A 当前仍有进行中的回合，NF 等待其完成后自动重试。', resume_when: 'retry' };
  value.recovery_window = {
    started_at: new Date(0).toISOString(),
    deadline_at: new Date(720_000).toISOString(),
    active_writer_started_at: new Date(120_000).toISOString(),
    active_writer_max_deadline_at: new Date(720_000).toISOString(),
    active_writer_capped_at: new Date(700_000).toISOString(),
  };
  interruptRecovery(value, 720_000);
  assert.equal(value.recovery_condition?.kind, 'recovery_active_writer_timeout');
  assert.match(value.recovery_interruption?.reason ?? '', /active writer 已达 10 分钟/);
  assert.doesNotMatch(value.recovery_interruption?.reason ?? '', /超过 2 分钟/);
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

test('recovery exceeding two minutes is durably interrupted even with a live owner', () => {
  const value = state('recovery-timeout');
  value.phase = 'RECOVERING';
  value.binding = { ...value.binding, status: 'PENDING_NATIVE_HOOK', operation: 'rebind', armed_at: new Date(0).toISOString() };
  value.recovery_plan = createRecoveryPlan(value, { kind: 'native_rebind', message: 'receipt missing', resume_when: 'receipt' }, true);
  value.recovery_plan.owner = { id: 'live', pid: process.pid, lease_path: 'test', task_version: 1, generation: value.run_generation, heartbeat_at: new Date(119_000).toISOString() };
  const path = resolve(value.task.workspace, 'state.json');
  writeFileSync(path, JSON.stringify(value));
  reconcileRecoveryTick(path, 119_999);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'ACTIVE');
  const tick = reconcileRecoveryTick(path, 120_000);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.status, 'INTERRUPTED');
  assert.equal(saved.phase, 'IDLE');
  assert.equal(saved.recovery_plan.cancellation_boundary.kind, 'interrupted');
  assert.equal(saved.recovery_plan.next_retry_at, null);
  assert.equal(saved.binding.status, 'RELEASED');
  assert.equal(saved.host.hook_effective, false);
  assert.equal(saved.contract_sha256, value.contract_sha256);
  assert.equal(saved.main_session_id, value.main_session_id);
  assert.throws(() => new Store(path).save(value), /interrupted/i, 'a late writer cannot revive the checkpoint');
  assert.equal(tick.waitingNative, false);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  assert.equal(reconcileRecoveryTick(path, 999_999).changed, false);
  const events = readFileSync(resolve(value.task.workspace, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'recovery_interrupted').length, 1);
  const resumed = JSON.parse(readFileSync(path, 'utf8'));
  resumed.task_version++;
  resumed.status = 'ACTIVE';
  resetRecoveryWindow(resumed);
  new Store(path).save(resumed);
  assert.throws(() => new Store(path).save(saved), /Stale checkpoint/, 'the old controller cannot overwrite a later explicit resume');
});

test('installed detached coordinator exits after interrupting an expired recovery', () => {
  const value = state('installed-timeout');
  value.phase = 'RECOVERING';
  value.binding = { ...value.binding, status: 'PENDING_NATIVE_HOOK', operation: 'rebind', armed_at: new Date(Date.now() - 121_000).toISOString() };
  value.recovery_plan = createRecoveryPlan(value, { kind: 'native_rebind', message: 'no receipt', resume_when: 'receipt' }, true);
  const path = resolve(value.task.workspace, 'state.json');
  writeFileSync(path, JSON.stringify(value));
  const child = spawnSync(process.execPath, [resolve('plugins/needs-forever/scripts/recovery-coordinator.mjs'), path, '100'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.status, 'INTERRUPTED');
  assert.equal(saved.recovery_prompt, undefined);
});

test('retries and process reconstruction cannot renew the recovery deadline', () => {
  let value = state('recovery-deadline');
  value.phase = 'RECOVERING';
  value.binding = { ...value.binding, status: 'PENDING_NATIVE_HOOK', operation: 'rebind', armed_at: new Date(0).toISOString() };
  waitForNativeReceipt(value, { kind: 'native_rebind', message: 'missing', resume_when: 'receipt' });
  value = JSON.parse(JSON.stringify(value));
  value.run_generation = 'retry-generation';
  value.binding.armed_at = new Date(90_000).toISOString();
  armRecovery(value, { kind: 'network', message: 'retry', resume_when: 'receipt' }, 90_000);
  const path = resolve(value.task.workspace, 'state.json');
  writeFileSync(path, JSON.stringify(value));
  reconcileRecoveryTick(path, 120_000);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'INTERRUPTED');
});

test('healthy work and manual pause are not recovery timeouts', () => {
  for (const status of ['ACTIVE', 'PAUSED', 'DONE'] as const) {
    const value = state('no-timeout-' + status);
    value.status = status;
    value.recovery_plan = createRecoveryPlan(value, { kind: 'none', message: '', resume_when: '' });
    value.recovery_plan.status = 'running';
    const path = resolve(value.task.workspace, 'state.json');
    writeFileSync(path, JSON.stringify(value));
    reconcileRecoveryTick(path, 999_999);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, status);
  }
});

test('a fresh failure after healthy work does not inherit an old completed native recovery deadline', () => {
  const value = state('fresh-after-healthy');
  value.binding = { ...value.binding, status: 'BOUND', operation: 'rebind', armed_at: new Date(0).toISOString(), bound_at: new Date(2_000).toISOString() };
  value.recovery_plan = createRecoveryPlan(value, { kind: 'old_rebind', message: 'old', resume_when: 'receipt' });
  value.recovery_plan.status = 'running';
  // Exactly the live Stop failure call site: WORKER/JUDGE was healthy, its
  // recovery window was cleared, then recover() enters RECOVERING first.
  value.phase = 'RECOVERING';
  armRecovery(value, { kind: 'stop_transport', message: 'new failure', resume_when: 'retry' }, 3_600_000);
  assert.equal(value.recovery_window?.started_at, new Date(3_600_000).toISOString());
  assert.equal(value.recovery_window?.deadline_at, new Date(3_720_000).toISOString());
});

test('late native lifecycle events cannot resume interrupted supervision', () => {
  const value = state('late-native-timeout');
  value.status = 'INTERRUPTED'; value.phase = 'IDLE';
  value.binding.status = 'RELEASED';
  value.recovery_plan = createRecoveryPlan(value, { kind: 'timeout', message: 'timeout', resume_when: 'manual' });
  cancelRecovery(value, 'interrupted');
  const path = resolve(value.task.workspace, 'state.json');
  const index = resolve(value.task.workspace, '.codex-supervisor');
  mkdirSync(index, { recursive: true });
  writeFileSync(resolve(index, 'main-session-index.json'), JSON.stringify({ states: [path] }));
  writeFileSync(path, JSON.stringify(value));
  const before = readFileSync(path, 'utf8');
  const cwd = process.cwd();
  try {
    process.chdir(value.task.workspace);
    const result = handleLifecycle({ hook_event_name: 'UserPromptSubmit', cwd: value.task.workspace, session_id: value.main_session_id }, value.host, cwd);
    assert.deepEqual(result, {});
    assert.equal(readFileSync(path, 'utf8'), before);
    armNativeRebind(value, 'late automatic attempt');
    assert.equal(value.status, 'INTERRUPTED');
    assert.equal(value.binding.status, 'RELEASED');
  } finally { process.chdir(cwd); }
});

test('an expired recovery is interrupted at the native receipt boundary before watchdog polling', () => {
  const value = state('expired-native-boundary');
  value.phase = 'RECOVERING';
  value.binding.status = 'PENDING_NATIVE_HOOK'; value.binding.operation = 'rebind';
  value.recovery_window = { started_at: new Date(0).toISOString(), deadline_at: new Date(120_000).toISOString() };
  value.recovery_plan = createRecoveryPlan(value, { kind: 'native_rebind', message: 'missing', resume_when: 'receipt' }, true);
  const path = resolve(value.task.workspace, 'state.json');
  const index = resolve(value.task.workspace, '.codex-supervisor');
  mkdirSync(index, { recursive: true });
  writeFileSync(resolve(index, 'main-session-index.json'), JSON.stringify({ states: [path] }));
  writeFileSync(path, JSON.stringify(value));
  const cwd = process.cwd();
  try {
    process.chdir(value.task.workspace);
    assert.deepEqual(handleLifecycle({ hook_event_name: 'UserPromptSubmit', cwd: value.task.workspace, session_id: value.main_session_id }, value.host, cwd), {});
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'INTERRUPTED');
  } finally { process.chdir(cwd); }
});
