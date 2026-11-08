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
