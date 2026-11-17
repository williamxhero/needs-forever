import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskCatalog, startWebServer } from '../src/NFG/index.js';
import { openWebClient } from './fixtures/web-client.js';

function routePlan() {
  return {
    plan_id: 'plan-local-001',
    selected_route_id: 'local-bars',
    selection_reason: '本地文件有独立观测。',
    single_route_reason: null,
    candidates: [
      {
        route_id: 'local-bars',
        resource: { kind: 'artifact', id: 'daily.parquet' },
        operation: '检查本地产物覆盖率',
        hypothesis_id: 'local-history',
        hypothesis: '本地产物可能覆盖所需交易日。',
        expected_evidence: ['覆盖率报告'],
        status: 'observed',
        evidence_ids: ['E2'],
        actions: ['核对本地覆盖率。'],
        expected_signal: '列出缺失交易日。',
        risk: '历史范围可能不足。',
        fallback: { route_id: 'alternate-api', when: '覆盖率不足。' },
        discriminating_check: null,
      },
      {
        route_id: 'alternate-api',
        resource: { kind: 'provider', id: 'unprobed-provider' },
        operation: '探测备用来源',
        hypothesis_id: 'alternate-source',
        hypothesis: '备用来源可能支持所需历史。',
        expected_evidence: ['只读探测结果'],
        status: 'candidate',
        evidence_ids: [],
        actions: ['读取授权范围内的能力信息。'],
        expected_signal: '记录支持范围与认证要求。',
        risk: '认证与限额未知。',
        fallback: { route_id: null, when: '无独立证据时重新规划。' },
        discriminating_check: null,
      },
    ],
    success_condition: '独立覆盖率报告可以复核。',
    stop_condition: '文件不可读时停止本路线。',
  };
}

function auditFixture(timestamp: string) {
  return {
    schema_version: 1,
    engine: 'pi-nf',
    generated_at: timestamp,
    task_id: 'pi-task',
    task_version: 1,
    contract: {
      task_id: 'pi-task',
      workspace: 'C:/workspaces/pi-task',
      goal: '用 pi-nf 完成受监督任务。',
      acceptance: [{ id: 'A1', text: '验收项一' }],
    },
    control: {
      status: 'PAUSED',
      phase: 'IDLE',
      worker_turns: 2,
      last_round_id: 'round-002',
      last_decision: { action: 'CONTINUE', reason: '限频后检查本地产物。' },
      last_error: null,
      pause_reason: 'user_limit',
      limit_reason: 'worker turn limit reached',
      updated_at: '2026-11-16T08:00:03.000Z',
    },
    verification: { configured: false, baseline_count: 0, state: 'not_configured', last_result: null },
    rounds: [
      {
        round_id: 'round-001',
        started_at: '2026-11-16T08:00:00.000Z',
        updated_at: '2026-11-16T08:00:02.000Z',
        status: 'decided',
        snapshot_id: 'snap-001',
        evidence_count: 2,
        decision: {
          action: 'CONTINUE',
          reason: '限频后检查本地产物。',
          evidence_ids: ['E1'],
          next_message: '核对本地覆盖率。',
          external: null,
          diagnosis: { class: 'provider_limit', statement: 'Tushare 触发限频。', evidence_ids: ['E1'] },
          route_plan: routePlan(),
        },
        delivery: {
          stage: 'submitted',
          submission_id: '18',
          submission_status: 'done',
          delivered: true,
          submitted_at: '2026-11-16T08:00:01.500Z',
          message: '核对本地覆盖率。',
          route_id: 'local-bars',
          plan_id: 'plan-local-001',
        },
        verification: null,
        errors: [],
      },
      {
        round_id: 'round-002',
        started_at: '2026-11-16T08:00:02.500Z',
        updated_at: '2026-11-16T08:00:03.000Z',
        status: 'decided',
        snapshot_id: null,
        evidence_count: 0,
        decision: { action: 'DONE', reason: '验证通过。', evidence_ids: [], next_message: '', external: null },
        delivery: null,
        verification: null,
        errors: [],
      },
    ],
    events: [
      { type: 'nf.start', at: '2026-11-16T08:00:00.000Z', details: { task_id: 'pi-task' } },
      { type: 'nf.judge_started', at: '2026-11-16T08:00:00.500Z', details: { round_id: 'round-001' } },
      { type: 'nf.decision', at: '2026-11-16T08:00:01.000Z', details: { round_id: 'round-001' } },
      { type: 'nf.judge_started', at: '2026-11-16T08:00:02.500Z', details: { round_id: 'round-002' } },
      { type: 'nf.decision', at: '2026-11-16T08:00:03.000Z', details: { round_id: 'round-002' } },
    ],
  };
}

function liveAuditFixture(timestamp: string) {
  return {
    ...auditFixture(timestamp),
    schema_version: 2,
    transcript: {
      items: [
        { id: '1:text:0', at: '2026-11-16T08:00:00.100Z', round_id: null, kind: 'assistant', text: 'A 完成第一步。' },
        { id: '2:thinking:0', at: '2026-11-16T08:00:00.200Z', round_id: null, kind: 'thinking', text: '先检查本地产物。' },
        { id: '3:tool:call-1', at: '2026-11-16T08:00:00.300Z', round_id: null, kind: 'tool_call', text: '{"command":"pytest"}', tool_name: 'bash', tool_call_id: 'call-1' },
        { id: '4:tool_result', at: '2026-11-16T08:00:00.400Z', round_id: null, kind: 'tool_result', text: 'tests passed', tool_name: 'bash', tool_call_id: 'call-1', truncated: true },
        { id: '5:decision', at: '2026-11-16T08:00:01.000Z', round_id: 'round-001', kind: 'decision', text: 'CONTINUE: 继续检查' },
        { id: 'bad', at: '2026-11-16T08:00:01.100Z', round_id: null, kind: 'not-a-kind', text: 'drop me' },
      ],
      window: { limit: 200, oldest_id: '1:text:0', has_more: false },
      stale_after_ms: 5000,
    },
  };
}

function fixture(live = false): { workspace: string; cleanup: () => void } {
  const workspace = mkdtempSync(resolve(process.cwd(), 'runs', 'pi-nf-web-'));
  const directory = resolve(workspace, '.pi-nf', 'pi-task');
  mkdirSync(directory, { recursive: true });
  const timestamp = '2026-11-16T08:00:03.000Z';
  writeFileSync(resolve(directory, 'audit.json'), JSON.stringify(live ? liveAuditFixture(timestamp) : auditFixture(timestamp)));
  return { workspace, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

test('TaskCatalog projects the pi-nf audit without adding its own fields', () => {
  const data = fixture();
  try {
    const catalog = new TaskCatalog({ workspace: data.workspace });
    assert.deepEqual(catalog.list().map((item) => item.taskId), ['pi-task']);
    assert.equal(catalog.sourceOf('pi-task'), 'pi-nf');
    const record = catalog.read('pi-task');
    assert.equal(record.title, 'pi-task');
    assert.match(record.sessionId, /^[0-9A-Z]{4}$/);
    assert.equal(record.state.status, 'PAUSED');
    assert.equal(record.state.phase, 'IDLE');
    assert.equal(record.state.goal, '用 pi-nf 完成受监督任务。');
    assert.equal(record.state.workerTurnCount, 2);
    assert.equal(record.state.pauseReason, 'user_limit');
    assert.equal(record.state.lastDecision?.action, 'CONTINUE');
    assert.equal(record.state.recovery.source, 'user_limit');
    assert.equal(record.eventCount, 5);
    assert.deepEqual(record.snapshotIds, ['snap-001']);
    assert.equal(record.rounds.length, 2);

    const first = record.rounds[0]!;
    assert.equal(first.worker?.eventType, 'nf.judge_started');
    assert.equal(first.supervisor.find((event) => event.eventType === 'decision')?.result, 'CONTINUE');
    assert.equal(first.continuation[0]?.eventType, 'send_prepared');
    assert.equal(first.continuation[0]?.details.message, '核对本地覆盖率。');
    assert.equal(first.continuation[1]?.eventType, 'send_confirmed');
    assert.equal(first.routeAudit?.kind, 'c2');
    assert.equal(first.routeAudit?.selectedRouteId, 'local-bars');
    assert.equal(first.result?.result, 'CONTINUE');

    const second = record.rounds[1]!;
    assert.equal(second.result?.result, 'DONE');
    assert.equal(second.continuation.length, 0);
  } finally {
    data.cleanup();
  }
});

test('pi-nf tasks are read-only in NFG and never invent a delivery', async () => {
  const data = fixture();
  const server = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const list = await (await fetch(new URL('api/tasks', server.url))).json() as { tasks: { taskId: string }[] };
    assert.deepEqual(list.tasks.map((task) => task.taskId), ['pi-task']);
    const detail = await fetch(new URL('api/tasks/pi-task', server.url));
    assert.equal(detail.status, 200);
    const record = await detail.json() as { readOnly?: boolean; rounds: { continuation: unknown[] }[] };
    assert.equal(record.readOnly, true);
    assert.equal(record.rounds[1]?.continuation.length, 0);
    const control = await fetch(new URL('api/tasks/pi-task/control', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(control.status, 409);
    assert.match((await control.json() as { error: string }).error, /read-only/);
  } finally {
    await server.close();
    data.cleanup();
  }
});

test('served NFG renders pi-nf rounds with its existing round layout and no controls', async () => {
  const data = fixture();
  const server = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const client = await openWebClient(new URL('tasks/pi-task', server.url).toString());
    const timeline = client.document.querySelector('#timeline')!.innerHTML;
    assert.match(timeline, /WORKER 完成一轮/);
    assert.doesNotMatch(timeline, /WORKER 发出/);
    assert.match(timeline, /核对本地覆盖率。/);
    assert.match(timeline, /CONTINUE/);
    assert.match(timeline, /第 2 轮/);
    const actions = client.document.querySelector('#task-actions')!;
    assert.equal(actions.hidden, true);
    assert.equal(actions.innerHTML, '');
    assert.equal(client.document.querySelectorAll('[data-action]').length, 0);
    assert.equal(client.document.querySelector('#live')!.hidden, true);
    assert.equal(client.document.querySelector('#live-tabs')!.hidden, true);
    assert.equal(client.document.querySelector('#content')!.classList.contains('live-view'), false);
  } finally {
    await server.close();
    data.cleanup();
  }
});

test('malformed or missing pi-nf projections are not discoverable', () => {
  const workspace = mkdtempSync(resolve(process.cwd(), 'runs', 'pi-nf-broken-'));
  try {
    const directory = resolve(workspace, '.pi-nf', 'broken');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'audit.json'), '{ not json');
    const catalog = new TaskCatalog({ workspace });
    assert.deepEqual(catalog.list(), []);
    assert.throws(() => catalog.read('broken'), /Task not found/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});


test('pi-nf v2 exposes one normalized live transcript and v1 stays single-column', () => {
  const v1 = fixture(false);
  const v2 = fixture(true);
  try {
    const oldRecord = new TaskCatalog({ workspace: v1.workspace }).read('pi-task');
    assert.equal(oldRecord.live, undefined);

    const catalog = new TaskCatalog({ workspace: v2.workspace });
    const record = catalog.read('pi-task');
    assert.ok(record.live);
    assert.equal(record.live?.window.limit, 200);
    assert.equal(record.live?.window.oldestId, '1:text:0');
    assert.equal(record.live?.window.hasMore, false);
    assert.equal(record.live?.generatedAt, '2026-11-16T08:00:03.000Z');
    assert.equal(record.live?.staleAfterMs, 5000);
    assert.deepEqual(record.live?.transcript.map((item) => item.kind), [
      'assistant', 'thinking', 'tool_call', 'tool_result', 'decision',
    ]);
    const call = record.live?.transcript.find((item) => item.kind === 'tool_call');
    const result = record.live?.transcript.find((item) => item.kind === 'tool_result');
    assert.equal(call?.toolCallId, 'call-1');
    assert.equal(result?.toolCallId, call?.toolCallId);
    assert.equal(result?.truncated, true);
    assert.equal(record.rounds.length, 2, 'the existing NFG round view is preserved');
  } finally {
    v1.cleanup();
    v2.cleanup();
  }
});


test('served NFG renders a pi-nf v2 live transcript beside the existing stage rounds', async () => {
  const data = fixture(true);
  const server = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const detail = await (await fetch(new URL('api/tasks/pi-task', server.url))).json() as {
      readOnly?: boolean;
      live?: { transcript: { kind: string }[] };
    };
    assert.equal(detail.readOnly, true);
    assert.ok(detail.live);
    assert.deepEqual(detail.live?.transcript.map((item) => item.kind), [
      'assistant', 'thinking', 'tool_call', 'tool_result', 'decision',
    ]);

    const client = await openWebClient(new URL('tasks/pi-task', server.url).toString());
    const content = client.document.querySelector('#content')!;
    assert.ok(content.classList.contains('live-view'));
    const live = client.document.querySelector('#live')!;
    assert.equal(live.hidden, false);
    assert.match(live.innerHTML, /实时对话/);
    assert.match(live.innerHTML, /A 完成第一步/);
    assert.match(live.innerHTML, /thinking/);
    assert.match(live.innerHTML, /工具调用/);
    assert.match(live.innerHTML, /tests passed/);
    assert.match(live.innerHTML, /truncated/);
    const timeline = client.document.querySelector('#timeline')!;
    assert.match(timeline.innerHTML, /验收/);
    assert.match(timeline.innerHTML, /第 2 轮/);
    assert.equal(client.document.querySelector('#task-actions')!.hidden, true);

    const tabs = client.document.querySelector('#live-tabs')!;
    assert.equal(tabs.hidden, false);
    const stages = tabs.querySelector('[data-live-tab="stages"]');
    assert.ok(stages);
    stages!.click();
    assert.ok(live.classList.contains('mobile-hidden'));
    assert.equal(timeline.classList.contains('mobile-hidden'), false);
    const chat = tabs.querySelector('[data-live-tab="chat"]');
    chat!.click();
    assert.equal(live.classList.contains('mobile-hidden'), false);
    assert.ok(timeline.classList.contains('mobile-hidden'));
  } finally {
    await server.close();
    data.cleanup();
  }
});


test('the live pane marks stale projections and escapes transcript content', async () => {
  const data = fixture(true);
  const auditPath = resolve(data.workspace, '.pi-nf', 'pi-task', 'audit.json');
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  audit.generated_at = '2000-01-01T00:00:00.000Z';
  audit.transcript.stale_after_ms = 1;
  audit.transcript.items[0].text = '<script>alert(1)</script> & evidence';
  writeFileSync(auditPath, JSON.stringify(audit));
  const server = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const client = await openWebClient(new URL('tasks/pi-task', server.url).toString());
    const live = client.document.querySelector('#live')!.innerHTML;
    assert.match(live, /投影已过期/);
    assert.match(live, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(live, /<script>alert/);
  } finally {
    await server.close();
    data.cleanup();
  }
});


test('viewing a pi-nf live task never writes its projection or state', async () => {
  const data = fixture(true);
  const auditPath = resolve(data.workspace, '.pi-nf', 'pi-task', 'audit.json');
  const before = readFileSync(auditPath, 'utf8');
  const server = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    await (await fetch(new URL('api/tasks', server.url))).json();
    await (await fetch(new URL('api/tasks/pi-task', server.url))).json();
    const reject = await fetch(new URL('api/tasks/pi-task/control', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });
    assert.equal(reject.status, 409);
    const client = await openWebClient(new URL('tasks/pi-task', server.url).toString());
    await client.refresh();
  } finally {
    await server.close();
  }
  try {
    assert.equal(readFileSync(auditPath, 'utf8'), before, 'viewer requests must not rewrite the projection');
    assert.deepEqual(readdirSync(resolve(data.workspace, '.pi-nf', 'pi-task')), ['audit.json']);
  } finally {
    data.cleanup();
  }
});
