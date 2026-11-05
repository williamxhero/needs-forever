import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskCatalog, startWebServer } from '../src/web.js';

function fixture() {
  const workspace = mkdtempSync(resolve('runs', 'web-test-'));
  const directory = resolve(workspace, '.codex-supervisor', 'demo-001');
  mkdirSync(resolve(directory, 'snapshots'), { recursive: true });
  const state = {
    schema_version: 1,
    task_id: 'demo-001',
    task_version: 1,
    task: {
      schema_version: 1,
      task_id: 'demo-001',
      workspace,
      goal: '完成本地演示任务。',
      acceptance: [{ id: 'A1', text: '页面能够显示记录。' }],
      authorization: '仅允许修改本地演示工作区。',
      limits: { max_worker_turns: null, max_minutes: null },
    },
    worker_thread_id: 'worker-001',
    status: 'ACTIVE',
    phase: 'WORKER',
    active_worker_turn_id: 'turn-002',
    reviewing_turn_id: null,
    handled_turn_ids: ['turn-001'],
    pending_action: null,
    retry: { kind: null, attempt: 0, next_at: null },
    last_decision: { action: 'CONTINUE', reason: '还有一个阶段。', evidence_ids: ['E1'], next_message: '继续第二阶段。', external: null },
    worker_turn_count: 2,
    elapsed_active_seconds: 1,
    updated_at: '2026-11-01T08:00:00.000Z',
    codex_version: 'codex-cli 0.166.0',
    mode: 'simulated',
  };
  const events = [
    { at: '2026-11-01T07:59:00.000Z', type: 'worker_started', role: 'worker', thread_id: 'worker-001', turn_id: 'turn-001', status: 'inProgress' },
    { at: '2026-11-01T07:59:03.000Z', type: 'worker_completed', role: 'worker', thread_id: 'worker-001', turn_id: 'turn-001', status: 'completed' },
    { at: '2026-11-01T07:59:03.100Z', type: 'worker_output', role: 'worker', thread_id: 'worker-001', turn_id: 'turn-001', text: '第一阶段完成。' },
    { at: '2026-11-01T07:59:04.000Z', type: 'decision', role: 'judge', thread_id: 'judge-001', worker_thread_id: 'worker-001', worker_turn_id: 'turn-001', snapshot_id: 'snap-001', decision: { action: 'CONTINUE', reason: '还有一个阶段。', evidence_ids: ['E1'], next_message: '继续第二阶段。', external: null } },
    { at: '2026-11-01T07:59:05.000Z', type: 'send_confirmed', role: 'worker', thread_id: 'worker-001', turn_id: 'turn-002', delivery_id: 'delivery-001' },
    { at: '2026-11-01T07:59:05.100Z', type: 'worker_started', role: 'worker', thread_id: 'worker-001', turn_id: 'turn-002', status: 'inProgress' },
  ];
  writeFileSync(resolve(directory, 'state.json'), `${JSON.stringify(state)}\n`);
  writeFileSync(resolve(directory, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  writeFileSync(resolve(directory, 'summary.md'), '# demo-001\n\n演示任务。\n');
  writeFileSync(resolve(directory, 'snapshots', 'snap-001.json'), '{}\n');
  return { workspace, directory, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

test('TaskCatalog presents persisted state and groups events into worker rounds', () => {
  const data = fixture();
  try {
    const catalog = new TaskCatalog({ workspace: data.workspace });
    assert.deepEqual(catalog.list().map((item) => item.taskId), ['demo-001']);
    const record = catalog.read('demo-001');
    assert.equal(record.state.status, 'ACTIVE');
    assert.equal(record.state.workerThreadId, 'worker-001');
    assert.equal(record.eventCount, 6);
    assert.deepEqual(record.snapshotIds, ['snap-001']);
    assert.equal(record.rounds.length, 2);
    assert.equal(record.rounds[0]?.worker?.eventType, 'worker_started');
    assert.equal(record.rounds[0]?.result?.eventType, 'decision');
    assert.equal(record.rounds[0]?.result?.result, 'CONTINUE');
    assert.equal(record.rounds[1]?.worker?.eventType, 'send_confirmed');
  } finally {
    data.cleanup();
  }
});

test('web server is read-only and exposes task and record endpoints', async () => {
  const data = fixture();
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const tasksResponse = await fetch(`${running.url}api/tasks`);
    assert.equal(tasksResponse.status, 200);
    assert.deepEqual((await tasksResponse.json()).tasks.map((item: { taskId: string }) => item.taskId), ['demo-001']);

    const recordResponse = await fetch(`${running.url}api/tasks/demo-001`);
    assert.equal(recordResponse.status, 200);
    const record = await recordResponse.json();
    assert.equal(record.state.lastDecision.action, 'CONTINUE');
    assert.equal(record.rounds[0].result.result, 'CONTINUE');

    const pageResponse = await fetch(`${running.url}tasks/demo-001`);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /Needs Forever/);

    const mutation = await fetch(`${running.url}api/tasks/demo-001`, { method: 'POST' });
    assert.equal(mutation.status, 405);
    const missing = await fetch(`${running.url}api/tasks/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    await running.close();
    data.cleanup();
  }
});
