import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { NFDaemon, startLoopbackApi } from '../src/daemon.js';
import { adapterEnvelope } from '../src/adapter-protocol.js';
import type { State } from '../src/types.js';

function fixture(workspace: string, status: State['status'] = 'PAUSED'): string {
  const taskId = 'daemon-fixture';
  const directory = resolve(workspace, '.codex-supervisor', taskId);
  const task = {
    schema_version: 1 as const, task_id: taskId, workspace,
    goal: 'daemon fixture', acceptance: [{ id: 'A1', text: 'state is discoverable' }],
    authorization: 'test', limits: { max_worker_turns: null, max_minutes: null },
  };
  const state: State = {
    schema_version: 1, task_id: taskId, task_version: 1, task, worker_thread_id: null,
    status, phase: status === 'PAUSED' ? 'IDLE' : 'WORKER', active_worker_turn_id: null,
    reviewing_turn_id: null, handled_turn_ids: [], pending_action: null,
    retry: { kind: null, attempt: 0, next_at: null }, last_decision: null,
    worker_turn_count: 0, elapsed_active_seconds: 0, updated_at: new Date().toISOString(),
    codex_version: null, mode: 'live',
  };
  const path = resolve(directory, 'state.json');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return path;
}

test('NF daemon discovers tasks, persists its manifest, and keeps audit after delete', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-daemon-'));
  fixture(root);
  const daemon = new NFDaemon({ workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 0 });
  const tick = await daemon.tick();
  assert.equal(tick.discovered, 1);
  assert.equal(daemon.tasks()[0]?.taskId, 'daemon-fixture');
  daemon.control('daemon-fixture', 'delete');
  assert.equal(daemon.tasks().length, 0);
  assert.equal(daemon.auditEvents().some((event) => event.type === 'task_deleted'), true);
  assert.equal(JSON.parse(readFileSync(resolve(root, 'daemon.json'), 'utf8')).tasks['daemon-fixture'].deleted, true);
});

test('NF daemon loopback API requires its token and exposes task control', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-daemon-api-'));
  fixture(root);
  const daemon = new NFDaemon({ workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 0 });
  await daemon.tick();
  const api = await startLoopbackApi({ daemon, port: 0 });
  try {
    const unauthorized = await fetch(`${api.url}/api/tasks`);
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: `Bearer ${api.token}` };
    const tasks = await fetch(`${api.url}/api/tasks`, { headers });
    assert.equal(tasks.status, 200);
    assert.equal((await tasks.json()).tasks[0].taskId, 'daemon-fixture');
    const paused = await fetch(`${api.url}/api/tasks/daemon-fixture/control`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
    assert.equal(paused.status, 200);
  } finally {
    await api.close();
  }
});

test('provider-neutral adapter events are authenticated, durable, and deduplicated', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-daemon-events-'));
  fixture(root);
  const daemon = new NFDaemon({ workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 0 });
  await daemon.tick();
  const event = adapterEnvelope({ provider: 'claude', host_instance_id: 'host-1', session_id: 'session-1', task_id: 'daemon-fixture', workspace: root, event_type: 'stop', turn_id: 'turn-1', bundle_sha256: null, payload: { stop_reason: 'done' } });
  assert.deepEqual(daemon.ingest(event), { accepted: true, duplicate: false, occurrence_id: event.occurrence_id });
  assert.deepEqual(daemon.ingest(event), { accepted: false, duplicate: true, occurrence_id: event.occurrence_id });
  assert.equal(daemon.auditEvents().some((entry) => entry.type === 'adapter_event' && entry.details?.provider === 'claude'), true);
});

test('interrupted recovery survives daemon restart and only manual resume opens a new window', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-interrupted-'));
  const path = fixture(root, 'INTERRUPTED');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  value.phase = 'IDLE';
  value.recovery_window = { started_at: new Date(0).toISOString(), deadline_at: new Date(120_000).toISOString() };
  value.recovery_interruption = { at: new Date(120_000).toISOString(), reason: 'timeout' };
  value.recovery_plan = { owner: null, generation: 'old', task_version: 1, attempt: 3, next_retry_at: null, status: 'cancelled', reason: { kind: 'timeout', message: 'timeout', resume_when: 'manual' }, cancellation_boundary: { kind: 'interrupted', at: new Date(120_000).toISOString(), generation: 'old' } };
  writeFileSync(path, JSON.stringify(value));
  const daemon = new NFDaemon({ workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 0, now: () => 900_000 });
  await daemon.tick();
  assert.equal(daemon.task('daemon-fixture')?.status, 'INTERRUPTED');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).recovery_interruption.reason, 'timeout');
  daemon.control('daemon-fixture', 'resume');
  const resumed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(resumed.task_version, 2);
  assert.equal(resumed.recovery_interruption, undefined);
  assert.equal(resumed.recovery_plan.cancellation_boundary, null);
  assert.equal(resumed.recovery_window.deadline_at, new Date(1_020_000).toISOString());
});

test('manual resume of an interrupted original A renews the native binding fences', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-main-interrupted-'));
  const path = fixture(root, 'INTERRUPTED');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(value, {
    phase: 'IDLE', control_mode: 'main-session', main_session_id: 'original-A', contract_sha256: 'immutable', run_generation: 'old',
    host: { hook_effective: false }, binding: { status: 'RELEASED', operation: 'rebind', expected_task_version: 1, armed_at: new Date(0).toISOString() },
    recovery_plan: { owner: null, generation: 'old', task_version: 1, attempt: 3, status: 'cancelled', cancellation_boundary: { kind: 'interrupted' } },
  });
  writeFileSync(path, JSON.stringify(value));
  const daemon = new NFDaemon({ workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 0 });
  await daemon.tick();
  daemon.control('daemon-fixture', 'resume');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.status, 'ACTIVE');
  assert.equal(saved.phase, 'RECOVERING');
  assert.equal(saved.main_session_id, 'original-A');
  assert.equal(saved.contract_sha256, 'immutable');
  assert.notEqual(saved.run_generation, 'old');
  assert.equal(saved.binding.expected_task_version, saved.task_version);
  assert.equal(saved.binding.expected_run_generation, saved.run_generation);
  assert.equal(saved.recovery_plan.cancellation_boundary, null);
});

test('daemon honors the recovery deadline between slow discovery polls', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-deadline-timer-'));
  const path = fixture(root, 'ACTIVE');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  value.phase = 'RECOVERING';
  value.recovery_window = { started_at: new Date(Date.now() - 119_500).toISOString(), deadline_at: new Date(Date.now() + 500).toISOString() };
  value.recovery_plan = { owner: null, generation: 'timer', task_version: 1, attempt: 1, status: 'waiting_native', reason: { kind: 'native', message: 'missing', resume_when: 'receipt' }, next_retry_at: null, cancellation_boundary: null };
  writeFileSync(path, JSON.stringify(value));
  const daemon = new NFDaemon({ workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 30_000 });
  daemon.start();
  try {
    const until = Date.now() + 5_000;
    while (JSON.parse(readFileSync(path, 'utf8')).status !== 'INTERRUPTED' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'INTERRUPTED');
    assert.ok(daemon.status().tickCount >= 2);
  } finally { daemon.stop(); }
});

test('daemon resume dispatches recovery immediately and ticks retry it without a Codex hook', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-resume-dispatch-'));
  const path = fixture(root, 'INTERRUPTED');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(value, { control_mode: 'main-session', main_session_id: 'original-A', run_generation: 'old', host: {}, binding: { status: 'RELEASED' } });
  writeFileSync(path, JSON.stringify(value));
  const dispatched: string[] = [];
  const options = { workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 0, recoverTask: (statePath: string) => { dispatched.push(statePath); } };
  const daemon = new NFDaemon(options);
  await daemon.tick();
  assert.equal(dispatched.length, 0, 'Interrupted tasks must remain stopped.');
  daemon.control('daemon-fixture', 'resume');
  assert.deepEqual(dispatched, [path], 'A successful resume must dispatch execution, not just arm a state.');
  await daemon.tick();
  assert.equal(dispatched.length, 2, 'The global host must drive recovery without another hook.');
  daemon.control('daemon-fixture', 'pause');
  await daemon.tick();
  assert.equal(dispatched.length, 2, 'Manual pause must stop the driver.');
});

test('global daemon dispatches a due ordinary recovery prompt when its coordinator is absent', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-prompt-watchdog-'));
  const path = fixture(root, 'ACTIVE');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  const generation = 'ordinary-prompt-generation';
  Object.assign(value, {
    control_mode: 'main-session', main_session_id: 'original-A', run_generation: generation,
    contract_sha256: 'contract',
    binding: { status: 'BOUND', operation: 'resume', tool_use_id: 'native-tool', bound_at: new Date().toISOString(), challenge: 'challenge', task_path: path },
    host: { desktop_version: null, cli_version: null, hook_effective: true, source: 'simulated', reason: '' },
    recovery_window: { started_at: new Date(Date.now() - 1_000).toISOString(), deadline_at: new Date(Date.now() + 120_000).toISOString() },
    recovery_plan: { owner: null, generation, task_version: 1, attempt: 0, next_retry_at: null, status: 'armed', reason: { kind: 'ordinary', message: 'A is idle.', resume_when: 'prompt delivery' }, cancellation_boundary: null },
    pending_action: { plan_id: 'plan-1', route_id: null, source_stop_attempt_id: 'stop-1', delivery_id: 'delivery-1', message: 'continue', stage: 'sent' },
    recovery_prompt: { kind: 'continuation', plugin_root: root, delivery_id: 'delivery-1', source_turn_id: 'turn-1', task_version: 1, run_generation: generation, message: 'continue', due_at: new Date(Date.now() - 1).toISOString(), plan_id: 'plan-1', source_stop_attempt_id: 'stop-1' },
  });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const dispatched: string[] = [];
  const daemon = new NFDaemon({ workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 0, recoverTask: statePath => { dispatched.push(statePath); } });
  const result = await daemon.tick();
  assert.equal(result.waitingNative, 0, 'An ordinary prompt does not need a native waiting plan.');
  assert.deepEqual(dispatched, [path], 'The global watchdog must drive a due prompt even without the B coordinator.');
});

test('global daemon contains detached tick failures and keeps its watchdog alive', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-daemon-tick-failure-'));
  fixture(root);
  const daemon = new NFDaemon({ workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 5 });
  const originalTick = daemon.tick.bind(daemon);
  let calls = 0;
  (daemon as unknown as { tick: () => Promise<unknown> }).tick = async () => {
    calls++;
    throw new Error('transient tick failure');
  };
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  daemon.start();
  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    assert.ok(calls >= 2, 'the interval should continue scheduling ticks after one failure');
    assert.equal(unhandled, 0, 'detached tick failures must not become unhandled rejections');
    assert.equal(daemon.auditEvents().some((event) => event.type === 'daemon_tick_failed'), true);
  } finally {
    daemon.stop();
    process.off('unhandledRejection', onUnhandled);
    (daemon as unknown as { tick: typeof originalTick }).tick = originalTick;
  }
});

test('global daemon isolates callback failures and keeps ticking without leaking callback secrets', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nf-daemon-callback-failure-'));
  fixture(root);
  const daemon = new NFDaemon({ workspaces: [root], dataPath: resolve(root, 'daemon.json'), intervalMs: 5 });
  let callbackCalls = 0;
  const secret = 'sk-callback-secret-1234567890';
  daemon.onTick(() => {
    callbackCalls++;
    throw new Error(`callback failed: ${secret}`);
  });
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  daemon.start();
  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    assert.ok(callbackCalls >= 2, 'the interval should continue scheduling ticks after a callback failure');
    assert.ok(daemon.status().tickCount >= 2, 'ticks should complete even when an observer throws');
    assert.equal(unhandled, 0, 'callback failures must not become unhandled rejections');
    const audit = readFileSync(daemon.auditPath, 'utf8');
    assert.match(audit, /daemon_tick_callback_failed/);
    assert.equal(audit.includes(secret), false, 'callback secrets must not be written to audit');
  } finally {
    daemon.stop();
    process.off('unhandledRejection', onUnhandled);
  }
});
