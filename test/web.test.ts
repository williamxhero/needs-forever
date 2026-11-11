import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskCatalog, startWebServer } from '../src/web.js';
import type { Decision } from '../src/types.js';
import { openWebClient } from './fixtures/web-client.js';

function routeDecision(): Decision {
  return {
    action: 'CONTINUE', reason: '限频后检查本地产物。', evidence_ids: ['E1'], next_message: '核对本地覆盖率。', external: null,
    diagnosis: { class: 'provider_limit', statement: 'Tushare 触发限频。', evidence_ids: ['E1'] },
    route_plan: {
      plan_id: 'plan-local-001', selected_route_id: 'local-bars', selection_reason: '本地文件有独立观测。', single_route_reason: null,
      candidates: [
        {
          route_id: 'local-bars', resource: { kind: 'artifact', id: 'daily.parquet' }, operation: '检查本地产物覆盖率',
          hypothesis_id: 'local-history', hypothesis: '本地产物可能覆盖所需交易日。', expected_evidence: ['覆盖率报告'],
          status: 'observed', evidence_ids: ['E2'], actions: ['核对本地覆盖率。'], expected_signal: '列出缺失交易日。', risk: '历史范围可能不足。',
          fallback: { route_id: 'alternate-api', when: '覆盖率不足。' }, discriminating_check: null,
        },
        {
          route_id: 'alternate-api', resource: { kind: 'provider', id: 'unprobed-provider' }, operation: '探测备用来源',
          hypothesis_id: 'alternate-source', hypothesis: '备用来源可能支持所需历史。', expected_evidence: ['只读探测结果'],
          status: 'candidate', evidence_ids: [], actions: ['读取授权范围内的能力信息。'], expected_signal: '记录支持范围与认证要求。', risk: '认证与限额未知。',
          fallback: { route_id: null, when: '无独立证据时重新规划。' }, discriminating_check: null,
        },
      ],
      success_condition: '独立覆盖率报告可以复核。', stop_condition: '文件不可读时停止本路线。',
    },
  };
}

function writeRouteRound(directory: string, value: Decision = routeDecision(), delivered = true): void {
  const events = [
    { at: '2026-11-01T08:00:00.000Z', type: 'main_session_stop_observed', turn_id: 'turn-001', stop_attempt_id: 'stop-001', stop_reason: 'provider 429' },
    { at: '2026-11-01T08:00:01.000Z', type: 'decision', role: 'judge', stop_attempt_id: 'stop-001', decision: value },
    { at: '2026-11-01T08:00:02.000Z', type: 'stop_hook_direction_returned', stop_attempt_id: 'stop-001', ...(delivered ? { delivery_id: 'delivery-001' } : {}) },
    ...(delivered ? [
      { at: '2026-11-01T08:00:02.100Z', type: 'send_prepared', role: 'worker', source_stop_attempt_id: 'stop-001', source_turn_id: 'turn-001', delivery_id: 'delivery-001', message: value.next_message },
      { at: '2026-11-01T08:00:03.000Z', type: 'send_confirmed', role: 'worker', source_stop_attempt_id: 'stop-001', turn_id: 'turn-002', delivery_id: 'delivery-001' },
    ] : []),
  ];
  writeFileSync(resolve(directory, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

function fixture() {
  mkdirSync(resolve('runs'), { recursive: true });
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
    last_error: '需要重新验证原始会话。',
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
  writeFileSync(resolve(directory, 'display.json'), `${JSON.stringify({ title: '演示任务标题' })}\n`);
  writeFileSync(resolve(directory, 'snapshots', 'snap-001.json'), '{}\n');
  return { workspace, directory, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

test('TaskCatalog presents persisted state and groups events into worker rounds', () => {
  const data = fixture();
  try {
    const catalog = new TaskCatalog({ workspace: data.workspace });
    assert.deepEqual(catalog.list().map((item) => item.taskId), ['demo-001']);
    const record = catalog.read('demo-001');
    assert.equal(record.title, '演示任务标题');
    assert.match(record.sessionId, /^[0-9A-Z]{4}$/);
    assert.equal(record.state.title, '演示任务标题');
    assert.equal(record.state.sessionId, record.sessionId);
    assert.equal(record.state.status, 'ACTIVE');
    assert.equal(record.state.workerThreadId, 'worker-001');
    assert.equal(record.state.lastError, '需要重新验证原始会话。');
    assert.deepEqual(record.state.recovery, {
      phase: 'WORKER',
      source: 'none',
      reason: '需要重新验证原始会话。',
      kind: null,
      attempt: 0,
      nextRetryAt: null,
      nativeReceipt: 'not_required',
      cancellationBoundary: 'none',
    });
    assert.equal(record.eventCount, 6);
    assert.deepEqual(record.snapshotIds, ['snap-001']);
    assert.equal(record.rounds.length, 1);
    assert.equal(record.rounds[0]?.worker?.eventType, 'worker_started');
    assert.equal(record.rounds[0]?.result?.eventType, 'decision');
    assert.equal(record.rounds[0]?.result?.result, 'CONTINUE');
  } finally {
    data.cleanup();
  }
});

test('NFG renders interrupted supervision with its reason and a manual resume control', async () => {
  const data = fixture();
  const path = resolve(data.directory, 'state.json');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  value.status = 'INTERRUPTED'; value.phase = 'IDLE';
  value.last_error = '自动恢复超过 2 分钟仍未成功，监督已中断。';
  value.recovery_condition = { kind: 'recovery_timeout', message: value.last_error, resume_when: 'manual resume' };
  writeFileSync(path, JSON.stringify(value));
  const web = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const record = await (await fetch(new URL('api/tasks/demo-001', web.url))).json();
    assert.equal(record.state.recovery.source, 'interrupted');
    assert.equal(record.state.nativeReceipt, 'not_required');
    const client = await openWebClient(new URL('tasks/demo-001', web.url).href);
    assert.match(client.document.querySelector('#task-status')!.textContent, /^已中断 /);
    assert.match(client.document.querySelector('#task-meta')!.innerHTML, /自动恢复超过 2 分钟/);
    assert.ok(client.document.querySelector('#task-actions')!.querySelector('[data-action="resume"]'));
    assert.equal(client.document.querySelector('#task-actions')!.querySelector('[data-action="pause"]'), null);
    await client.refresh();
    assert.match(client.document.querySelector('#task-status')!.textContent, /^已中断 /);
  } finally { await web.close(); data.cleanup(); }
});

test('NFG API projects the complete selected route audit without rewriting historical decisions', async () => {
  const data = fixture();
  writeRouteRound(data.directory);
  const eventsPath = resolve(data.directory, 'events.jsonl');
  const savedEvents = readFileSync(eventsPath, 'utf8');
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const response = await fetch(`${running.url}api/tasks/demo-001`);
    assert.equal(response.status, 200);
    const record = await response.json();
    const audit = record.rounds[0].routeAudit;
    assert.equal(audit.kind, 'c2');
    assert.equal(audit.planId, 'plan-local-001');
    assert.equal(audit.selectedRouteId, 'local-bars');
    assert.equal(audit.diagnosis.statement, 'Tushare 触发限频。');
    assert.equal(audit.selectionReason, '本地文件有独立观测。');
    assert.equal(audit.candidates[0].title, '检查本地产物覆盖率');
    assert.equal(audit.candidates[0].status, 'observed');
    assert.deepEqual(audit.candidates[0].evidenceIds, ['E2']);
    assert.equal(audit.candidates[0].risk, '历史范围可能不足。');
    assert.deepEqual(audit.candidates[0].fallback, { routeId: 'alternate-api', when: '覆盖率不足。' });
    assert.equal(audit.candidates[1].status, 'candidate');
    assert.equal(audit.successCondition, '独立覆盖率报告可以复核。');
    assert.equal(audit.stopCondition, '文件不可读时停止本路线。');
    assert.equal(readFileSync(eventsPath, 'utf8'), savedEvents);
  } finally { await running.close(); data.cleanup(); }
});

test('served NFG client shows compact routes and expands candidate evidence without claiming availability', async () => {
  const data = fixture();
  writeRouteRound(data.directory);
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const client = await openWebClient(`${running.url}tasks/demo-001`);
    const timeline = client.document.querySelector('#timeline')!.innerHTML;
    assert.equal((timeline.match(/class="flow-line"/g) ?? []).length, 3);
    assert.match(timeline, /WORKER 发出：[\s\S]*SUPERVISOR 判断：[\s\S]*WORKER 收到：/);
    const route = client.document.querySelector('.route-block');
    assert.ok(route, 'selected route is rendered beneath SUPERVISOR');
    assert.match(route.textContent.split('\n')[0]!, /local-bars.*检查本地产物覆盖率.*Tushare 触发限频/);
    assert.equal(route.getAttribute('aria-expanded'), 'false');
    assert.equal(route.classList.contains('expanded'), false);
    route.click();
    assert.equal(route.classList.contains('expanded'), true);
    assert.equal(route.getAttribute('aria-expanded'), 'true');
    assert.match(route.textContent, /alternate-api.*候选（未验证）/);
    assert.match(route.textContent, /证据：E2/);
    assert.match(route.textContent, /风险：历史范围可能不足/);
    assert.match(route.textContent, /fallback：alternate-api.*覆盖率不足/);
    assert.match(route.textContent, /成功条件：独立覆盖率报告可以复核/);
    assert.match(route.textContent, /停止条件：文件不可读时停止本路线/);
    assert.doesNotMatch(route.textContent, /可用 provider|provider 可用/);
    assert.equal(client.document.querySelectorAll('[data-action]').length, 4);
    client.document.querySelector('[data-action="copy"]')!.click();
    assert.match(client.copied[0]!, /^NF:\/\/[0-9A-Z]{4}$/);
    assert.equal(client.document.querySelector('#task-title')!.textContent, '演示任务标题');
    assert.match(client.document.querySelector('#task-status')!.textContent, /^正在推进 /);
  } finally { await running.close(); data.cleanup(); }
});

test('legacy HTTP history displays a virtual unverified single route and keeps its stored decision intact', async () => {
  const data = fixture();
  const legacy: Decision = { action: 'CONTINUE', reason: '还有一个阶段。', evidence_ids: ['E1'], next_message: '继续第二阶段。', external: null };
  writeRouteRound(data.directory, legacy, false);
  const eventsPath = resolve(data.directory, 'events.jsonl');
  const before = readFileSync(eventsPath, 'utf8');
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const record = await (await fetch(`${running.url}api/tasks/demo-001`)).json();
    assert.equal(record.rounds[0].routeAudit.kind, 'legacy');
    assert.equal(record.rounds[0].routeAudit.candidates.length, 1);
    assert.equal(record.rounds[0].routeAudit.candidates[0].status, 'unknown');
    assert.deepEqual(record.rounds[0].result.details.decision, legacy);
    const client = await openWebClient(`${running.url}tasks/demo-001`);
    const route = client.document.querySelector('.route-block')!;
    assert.ok(route);
    assert.match(route.textContent, /旧版虚拟单路线/);
    assert.match(route.textContent, /未知（未验证）/);
    assert.match(route.textContent, /动作：继续第二阶段/);
    assert.match(client.document.querySelector('#timeline')!.innerHTML, /继续第二阶段/);
    assert.doesNotMatch(client.document.querySelector('#timeline')!.innerHTML, /undefined|\[object Object\]/);
    await client.refresh();
    assert.equal(readFileSync(eventsPath, 'utf8'), before);
  } finally { await running.close(); data.cleanup(); }
});

test('NFG timer refresh preserves expansion by task, Stop and plan after round insertion and isolates a replacement plan', async () => {
  const data = fixture();
  writeRouteRound(data.directory);
  const eventsPath = resolve(data.directory, 'events.jsonl');
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const client = await openWebClient(`${running.url}tasks/demo-001`);
    const route = client.document.querySelector('.route-block')!;
    const oldKey = route.dataset.collapsibleKey!;
    const prompt = client.document.querySelector('.prompt-block')!;
    const stop = client.document.querySelector('.stop-reason-block')!;
    route.click(); prompt.click(); stop.click();
    const prior = [
      { at: '2026-11-01T07:00:00.000Z', type: 'main_session_stop_observed', stop_attempt_id: 'stop-earlier' },
      { at: '2026-11-01T07:00:01.000Z', type: 'decision', role: 'judge', stop_attempt_id: 'stop-earlier', decision: routeDecision() },
    ];
    const history = prior.map((event) => JSON.stringify(event)).join('\n') + '\n' + readFileSync(eventsPath, 'utf8');
    writeFileSync(eventsPath, history);
    await client.refresh();
    const routes = client.document.querySelectorAll('.route-block');
    assert.equal(routes.length, 2);
    assert.equal(routes[0]!.classList.contains('expanded'), false, 'same plan on another Stop stays collapsed');
    assert.equal(routes[1]!.dataset.collapsibleKey, oldKey);
    assert.equal(routes[1]!.classList.contains('expanded'), true, 'original route remains expanded after index changes');
    assert.equal(routes[1]!.getAttribute('aria-expanded'), 'true');
    for (const key of [prompt.dataset.collapsibleKey, stop.dataset.collapsibleKey]) {
      assert.equal(client.document.querySelectorAll('[data-collapsible]').find((node) => node.dataset.collapsibleKey === key)?.classList.contains('expanded'), true);
    }

    client.document.querySelector('[data-action="refresh"]')!.click();
    const before = client.document.querySelector('#timeline')!.innerHTML;
    writeFileSync(eventsPath, history.replaceAll('plan-local-001', 'plan-local-002'));
    await client.refresh();
    assert.equal(client.document.querySelector('#timeline')!.innerHTML, before, 'disabled auto refresh keeps current view');
    client.document.querySelector('[data-action="refresh"]')!.click();
    await client.refresh();
    assert.ok(client.document.querySelectorAll('.route-block').every((node) => !node.classList.contains('expanded')), 'replacement plans start collapsed');
    assert.equal(client.document.querySelectorAll('.prompt-block').find((node) => node.dataset.collapsibleKey === prompt.dataset.collapsibleKey)?.classList.contains('expanded'), true);
  } finally { await running.close(); data.cleanup(); }
});

test('served NFG escapes model text and route keys while its complete inline script executes', async () => {
  const data = fixture();
  const attack = '\"><img src=x onerror="globalThis.pwned=true"></span><script>globalThis.pwned=true</script>&\'`\\\n\u2028';
  const value = routeDecision();
  const plan = value.route_plan!;
  value.reason = 'reason' + attack;
  value.next_message = 'prompt' + attack;
  value.diagnosis!.statement = 'diagnosis' + attack;
  value.diagnosis!.evidence_ids = ['diagnosis-proof' + attack];
  plan.plan_id = 'plan' + attack;
  plan.selected_route_id = plan.candidates[0]!.route_id = 'route' + attack;
  plan.selection_reason = 'selection' + attack;
  plan.single_route_reason = 'single' + attack;
  plan.success_condition = 'success' + attack;
  plan.stop_condition = 'stop' + attack;
  const candidate = plan.candidates[0]!;
  candidate.operation = 'title' + attack;
  candidate.resource.id = 'resource' + attack;
  candidate.hypothesis = 'hypothesis' + attack;
  candidate.evidence_ids = ['proof' + attack];
  candidate.actions = ['action' + attack];
  candidate.expected_evidence = ['expected-proof' + attack];
  candidate.expected_signal = 'signal' + attack;
  candidate.risk = 'risk' + attack;
  candidate.fallback = { route_id: 'fallback-route' + attack, when: 'fallback-when' + attack };
  candidate.discriminating_check = { description: 'check' + attack, evidence_ids: [] };
  writeRouteRound(data.directory, value);
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const client = await openWebClient(`${running.url}tasks/demo-001`);
    const markup = client.document.querySelector('#timeline')!.innerHTML;
    assert.doesNotMatch(markup, /<img\b|<script\b/);
    assert.match(markup, /&lt;img src=x onerror=&quot;/);
    const route = client.document.querySelector('.route-block')!;
    for (const prefix of ['diagnosis', 'diagnosis-proof', 'route', 'title', 'resource', 'hypothesis', 'selection', 'single', 'proof', 'action', 'expected-proof', 'signal', 'risk', 'fallback-route', 'fallback-when', 'check', 'success', 'stop']) {
      assert.ok(route.textContent.includes(prefix + attack), `${prefix} remains readable as escaped text`);
    }
    assert.ok(route.dataset.collapsibleKey!.includes('plan' + attack));
    route.click();
    await client.refresh();
    assert.equal(client.document.querySelector('.route-block')!.getAttribute('aria-expanded'), 'true');
    assert.ok(client.document.querySelector('.prompt-block')!.textContent.includes('prompt' + attack));
  } finally { await running.close(); data.cleanup(); }
});

test('TaskCatalog exposes durable recovery metadata and distinguishes native waiting from user cancellation and DONE', () => {
  const data = fixture();
  try {
    const statePath = resolve(data.directory, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.status = 'ACTIVE';
    state.phase = 'RECOVERING';
    state.retry = { kind: 'controller_startup', attempt: 3, next_at: '2026-11-01T08:05:00.000Z' };
    state.last_error = 'controller exited unexpectedly';
    state.recovery_condition = { kind: 'controller_startup', message: 'controller exited unexpectedly', resume_when: 'retry automatically' };
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    let view = new TaskCatalog({ workspace: data.workspace }).read('demo-001').state;
    assert.equal(view.recovery.source, 'automatic');
    assert.equal(view.recovery.phase, 'RECOVERING');
    assert.equal(view.recovery.reason, 'controller exited unexpectedly');
    assert.equal(view.recovery.kind, 'controller_startup');
    assert.equal(view.recovery.attempt, 3);
    assert.equal(view.recovery.nextRetryAt, '2026-11-01T08:05:00.000Z');
    assert.equal(view.recovery.nativeReceipt, 'not_required');
    assert.equal(view.recovery.cancellationBoundary, 'none');

    state.recovery = {
      source: 'automatic', kind: 'controller_crash', reason: 'controller process exited',
      attempt: 4, next_retry_at: '2026-11-01T08:06:00.000Z', nativeReceipt: 'waiting',
    };
    state.phase = 'RECOVERING';
    state.retry = { kind: null, attempt: 0, next_at: null };
    state.recovery_condition = undefined;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    view = new TaskCatalog({ workspace: data.workspace }).read('demo-001').state;
    assert.equal(view.recovery.kind, 'controller_crash');
    assert.equal(view.recovery.reason, 'controller process exited');
    assert.equal(view.recovery.attempt, 4);
    assert.equal(view.recovery.nextRetryAt, '2026-11-01T08:06:00.000Z');
    assert.equal(view.recovery.nativeReceipt, 'waiting');

    state.status = 'PAUSED';
    state.phase = 'RECOVERING';
    state.recovery = undefined;
    state.pause_reason = undefined;
    state.retry = { kind: null, attempt: 0, next_at: null };
    state.recovery_condition = { kind: 'resume_native_receipt', message: '等待原始 A 的 native receipt。', resume_when: '收到新的 receipt' };
    state.binding = { status: 'PENDING_NATIVE_HOOK' };
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    view = new TaskCatalog({ workspace: data.workspace }).read('demo-001').state;
    assert.equal(view.recovery.source, 'automatic');
    assert.equal(view.recovery.nativeReceipt, 'waiting');
    assert.equal(view.recovery.kind, 'resume_native_receipt');

    state.status = 'PAUSED';
    state.phase = 'IDLE';
    state.pause_reason = 'user';
    state.recovery_condition = undefined;
    state.binding = undefined;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    view = new TaskCatalog({ workspace: data.workspace }).read('demo-001').state;
    assert.equal(view.recovery.source, 'user_pause');
    assert.equal(view.recovery.cancellationBoundary, 'user_pause');
    assert.equal(view.recovery.nativeReceipt, 'not_required');

    state.status = 'DONE';
    state.pause_reason = undefined;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    view = new TaskCatalog({ workspace: data.workspace }).read('demo-001').state;
    assert.equal(view.recovery.source, 'done');
    assert.equal(view.recovery.cancellationBoundary, 'done');
  } finally {
    data.cleanup();
  }
});

test('TaskCatalog keeps active session IDs unique and reuses a completed ID', () => {
  const data = fixture();
  try {
    const secondDirectory = resolve(data.workspace, '.codex-supervisor', 'demo-002');
    cpSync(data.directory, secondDirectory, { recursive: true });
    const secondStatePath = resolve(secondDirectory, 'state.json');
    const secondState = JSON.parse(readFileSync(secondStatePath, 'utf8'));
    secondState.task_id = 'demo-002';
    writeFileSync(secondStatePath, `${JSON.stringify(secondState)}\n`);
    const catalog = new TaskCatalog({ workspace: data.workspace });
    const firstId = catalog.read('demo-001').sessionId;
    const secondId = catalog.read('demo-002').sessionId;
    assert.match(firstId, /^[0-9A-Z]{4}$/);
    assert.match(secondId, /^[0-9A-Z]{4}$/);
    assert.notEqual(firstId, secondId);

    secondState.status = 'DONE';
    writeFileSync(secondStatePath, `${JSON.stringify(secondState)}\n`);
    catalog.read('demo-002');
    const thirdDirectory = resolve(data.workspace, '.codex-supervisor', 'demo-003');
    cpSync(data.directory, thirdDirectory, { recursive: true });
    const thirdStatePath = resolve(thirdDirectory, 'state.json');
    const thirdState = JSON.parse(readFileSync(thirdStatePath, 'utf8'));
    thirdState.task_id = 'demo-003';
    writeFileSync(thirdStatePath, `${JSON.stringify(thirdState)}\n`);
    assert.equal(catalog.read('demo-003').sessionId, secondId);
  } finally {
    data.cleanup();
  }
});

test('TaskCatalog hides rounds until a real supervisor event completes A→B→C', () => {
  const data = fixture();
  try {
    writeFileSync(resolve(data.directory, 'events.jsonl'), [
      { at: '2026-11-01T07:59:00.000Z', type: 'main_session_controller_started', session_id: 'session-001' },
      { at: '2026-11-01T07:59:03.000Z', type: 'main_tool_result', turn_id: 'turn-001', tool_use_id: 'exec-001' },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    const record = new TaskCatalog({ workspace: data.workspace }).read('demo-001');
    assert.equal(record.eventCount, 2);
    assert.deepEqual(record.rounds, []);
  } finally {
    data.cleanup();
  }
});

test('TaskCatalog treats a main-session tool result as the A worker leg', () => {
  const data = fixture();
  try {
    writeFileSync(resolve(data.directory, 'events.jsonl'), [
      { at: '2026-11-01T07:59:00.000Z', type: 'main_tool_result', turn_id: 'turn-001', tool_use_id: 'exec-001' },
      { at: '2026-11-01T07:59:03.000Z', type: 'main_session_stop_observed', turn_id: 'turn-001', stop_attempt_id: 'stop-001', stop_reason: 'Tushare 返回 HTTP 429。' },
      { at: '2026-11-01T07:59:04.000Z', type: 'judge_created', stop_attempt_id: 'stop-001', snapshot_id: 'snap-001' },
      { at: '2026-11-01T07:59:05.000Z', type: 'decision', role: 'judge', stop_attempt_id: 'stop-001', decision: { action: 'CONTINUE', reason: '继续。', evidence_ids: ['E1'], next_message: '继续。', external: null } },
      { at: '2026-11-01T07:59:06.000Z', type: 'main_session_recovery_prompt_sent', role: 'worker', stop_attempt_id: 'stop-001', delivery_id: 'delivery-001' },
      { at: '2026-11-01T07:59:07.000Z', type: 'main_session_recovery_prompt_acknowledged', role: 'worker', stop_attempt_id: 'stop-001', delivery_id: 'delivery-001' },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    const record = new TaskCatalog({ workspace: data.workspace }).read('demo-001');
    assert.equal(record.rounds.length, 1);
    assert.equal(record.rounds[0]?.worker?.eventType, 'main_tool_result');
    assert.equal(record.rounds[0]?.supervisor.length, 2);
    assert.equal(record.rounds[0]?.stop?.details.stop_reason, 'Tushare 返回 HTTP 429。');
    assert.deepEqual(record.rounds[0]?.continuation.map((event) => event.eventType), ['main_session_recovery_prompt_sent', 'main_session_recovery_prompt_acknowledged']);
  } finally {
    data.cleanup();
  }
});

test('TaskCatalog maps a native rebind prompt back to its parent Stop round and exposes the real prompt', async () => {
  const data = fixture();
  try {
    const recoveryPrompt = '请继续执行当前任务。Needs Forever 正在等待原始 A 的真实生命周期回执，以完成当前监督绑定；收到后继续按现有任务合同推进。';
    writeFileSync(resolve(data.directory, 'events.jsonl'), [
      { at: '2026-11-01T08:00:00.000Z', type: 'main_session_stop_observed', turn_id: 'turn-parent', stop_attempt_id: 'stop-parent', stop_reason: '工具执行完成。' },
      { at: '2026-11-01T08:00:01.000Z', type: 'decision', role: 'judge', stop_attempt_id: 'stop-parent', decision: { action: 'CONTINUE', reason: '需要重新建立监督绑定。', evidence_ids: [], next_message: '旧方向。', external: null } },
      { at: '2026-11-01T08:00:02.000Z', type: 'main_session_recovery_prompt_sent', role: 'worker', stop_attempt_id: 'stop-parent', turn_id: 'turn-parent', delivery_id: 'delivery-parent', message: recoveryPrompt },
      { at: '2026-11-01T08:00:03.000Z', type: 'main_session_recovery_prompt_acknowledged', role: 'worker', stop_attempt_id: 'stop-parent', turn_id: 'turn-parent', delivery_id: 'delivery-parent', message: recoveryPrompt },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    const record = new TaskCatalog({ workspace: data.workspace }).read('demo-001');
    assert.equal(record.rounds.length, 1);
    assert.deepEqual(record.rounds[0]?.continuation.map((event) => event.eventType), ['main_session_recovery_prompt_sent', 'main_session_recovery_prompt_acknowledged']);
    assert.equal(record.rounds[0]?.continuation.find((event) => event.eventType === 'main_session_recovery_prompt_sent')?.details.message, recoveryPrompt);
    const running = await startWebServer({ workspace: data.workspace, port: 0 });
    try {
      const api = await (await fetch(`${running.url}api/tasks/demo-001`)).json() as { rounds: Array<{ continuation: Array<{ details: Record<string, unknown> }> }> };
      assert.equal(api.rounds[0]?.continuation.find((event) => event.details.type === 'main_session_recovery_prompt_sent')?.details.message, recoveryPrompt);
    } finally { await running.close(); }
  } finally { data.cleanup(); }
});

test('TaskCatalog preserves an externally observed worker prompt without claiming NF sent it', () => {
  const data = fixture();
  try {
    const prompt = '请继续执行当前任务。Needs Forever 正在等待原始 A 的真实生命周期回执，以完成当前监督绑定；收到后继续按现有任务合同推进。';
    writeFileSync(resolve(data.directory, 'events.jsonl'), [
      { at: '2026-11-01T08:00:00.000Z', type: 'main_session_stop_observed', turn_id: 'turn-parent', stop_attempt_id: 'stop-parent' },
      { at: '2026-11-01T08:00:01.000Z', type: 'judge_created', role: 'supervisor', stop_attempt_id: 'stop-parent' },
      { at: '2026-11-01T08:00:02.000Z', type: 'main_session_worker_prompt_observed', role: 'worker', source: 'codex-app-tools', stop_attempt_id: 'stop-parent', turn_id: 'turn-parent', message: prompt },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    const record = new TaskCatalog({ workspace: data.workspace }).read('demo-001');
    assert.equal(record.rounds.length, 1);
    assert.equal(record.rounds[0]?.continuation[0]?.eventType, 'main_session_worker_prompt_observed');
    assert.equal(record.rounds[0]?.continuation[0]?.details.message, prompt);
  } finally { data.cleanup(); }
});

test('TaskCatalog assigns repeated main-session work to the next matching Stop/C round', () => {
  const data = fixture();
  try {
    writeFileSync(resolve(data.directory, 'events.jsonl'), [
      { at: '2026-11-01T07:59:00.000Z', type: 'main_tool_result', turn_id: 'turn-001', tool_use_id: 'exec-001' },
      { at: '2026-11-01T08:00:00.000Z', type: 'main_session_stop_observed', turn_id: 'turn-001', stop_attempt_id: 'stop-001' },
      { at: '2026-11-01T08:00:01.000Z', type: 'judge_created', stop_attempt_id: 'stop-001' },
      { at: '2026-11-01T08:00:02.000Z', type: 'decision', role: 'judge', stop_attempt_id: 'stop-001', decision: { action: 'CONTINUE', reason: '继续。', evidence_ids: ['E1'], next_message: '继续。', external: null } },
      { at: '2026-11-01T08:01:00.000Z', type: 'main_tool_result', turn_id: 'turn-001', tool_use_id: 'exec-002' },
      { at: '2026-11-01T08:02:00.000Z', type: 'main_session_stop_observed', turn_id: 'turn-001', stop_attempt_id: 'stop-002' },
      { at: '2026-11-01T08:02:01.000Z', type: 'judge_created', stop_attempt_id: 'stop-002' },
      { at: '2026-11-01T08:02:02.000Z', type: 'decision', role: 'judge', stop_attempt_id: 'stop-002', decision: { action: 'WAIT_EXTERNAL', reason: '等待外部条件。', evidence_ids: ['E2'], next_message: '', external: { condition: 'provider' } } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    const record = new TaskCatalog({ workspace: data.workspace }).read('demo-001');
    assert.equal(record.rounds.length, 2);
    assert.deepEqual(record.rounds.map((round) => round.worker?.details.tool_use_id), ['exec-001', 'exec-002']);
  } finally {
    data.cleanup();
  }
});

test('independent worker keeps its confirmed direction in the source round and hides an unconfirmed proposal', async () => {
  const data = fixture();
  writeFileSync(resolve(data.directory, 'events.jsonl'), [
    { at: '2026-11-10T16:21:00Z', type: 'worker_completed', turn_id: 'turn-one', status: 'completed' },
    { at: '2026-11-10T16:21:01Z', type: 'decision', turn_id: 'turn-one', decision: routeDecision() },
    { at: '2026-11-10T16:21:02Z', type: 'send_prepared', source_stop_attempt_id: 'turn-one', source_turn_id: 'turn-one', delivery_id: 'ordinary-delivery', message: 'Actually delivered ordinary direction.' },
    { at: '2026-11-10T16:21:03Z', type: 'send_attempted', source_stop_attempt_id: 'turn-one', delivery_id: 'ordinary-delivery' },
    { at: '2026-11-10T16:21:04Z', type: 'send_confirmed', source_stop_attempt_id: 'turn-one', turn_id: 'turn-two', delivery_id: 'ordinary-delivery' },
    { at: '2026-11-10T16:21:05Z', type: 'send_prepared', source_turn_id: 'turn-one', delivery_id: 'not-sent', message: 'Never delivered proposal.' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const record = new TaskCatalog({ workspace: data.workspace }).read('demo-001');
    assert.equal(record.rounds.length, 1);
    assert.ok(record.rounds[0]!.technicalEvents.some(e => e.eventType === 'send_confirmed'));
    const client = await openWebClient(`${running.url}tasks/demo-001`);
    const html = client.document.querySelector('#timeline')!.innerHTML;
    assert.match(html, /Actually delivered ordinary direction/);
    assert.match(html, /prompt-block/);
    assert.doesNotMatch(html, /未交付|Never delivered proposal/);
  } finally { await running.close(); data.cleanup(); }
});

test('native rounds correlate delivery confirmations to their source Stop and show a timeout without a fictional prompt', async () => {
  const data = fixture();
  const statePath = resolve(data.directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')); state.mode = 'live'; writeFileSync(statePath, JSON.stringify(state));
  const events = [
    { at: '2026-11-10T16:21:00Z', type: 'main_session_stop_observed', turn_id: 'same-turn', stop_attempt_id: 'stop-one' },
    { at: '2026-11-10T16:27:00Z', type: 'decision', stop_attempt_id: 'stop-one', decision: routeDecision() },
    { at: '2026-11-10T16:27:01Z', type: 'send_prepared', source_stop_attempt_id: 'stop-one', source_turn_id: 'same-turn', delivery_id: 'delivery-one', message: 'Actual first direction.' },
    { at: '2026-11-10T16:27:02Z', type: 'stop_hook_direction_returned', stop_attempt_id: 'stop-one', delivery_id: 'delivery-one' },
    { at: '2026-11-10T16:28:00Z', type: 'main_session_recovery_prompt_scheduled', turn_id: 'same-turn', delivery_id: 'delivery-one' },
    { at: '2026-11-10T16:28:31Z', type: 'send_confirmed', source_stop_attempt_id: 'stop-one', turn_id: 'same-turn', delivery_id: 'delivery-one' },
    { at: '2026-11-10T16:38:00Z', type: 'main_session_stop_observed', turn_id: 'same-turn', stop_attempt_id: 'stop-two', source_stop_attempt_id: 'stop-one' },
    { at: '2026-11-10T16:38:01Z', type: 'judge_created', stop_attempt_id: 'stop-two' },
    { at: '2026-11-10T16:45:00Z', type: 'judge_terminated', stop_attempt_id: 'stop-two', reason: 'Judge timeout.' },
  ];
  writeFileSync(resolve(data.directory, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const record = new TaskCatalog({ workspace: data.workspace }).read('demo-001');
    assert.equal(record.rounds.length, 2);
    assert.equal(record.rounds[0]!.result?.eventType, 'send_confirmed');
    assert.ok(record.rounds[1]!.technicalEvents.every(e => e.at >= '2026-11-10T16:38:00Z'));
    const client = await openWebClient(`${running.url}tasks/demo-001`);
    const latest = client.document.querySelector('#timeline')!.innerHTML.split('data-round="stop:stop-two"')[1]!;
    assert.doesNotMatch(latest, /CONFIRMED|下一轮已确认开始/);
    assert.match(latest, /超时/);
    assert.match(latest, /未交付/);
    assert.doesNotMatch(latest, /prompt-block/);
  } finally { await running.close(); data.cleanup(); }
});

test('NFG never renders a received prompt for an active-writer recovery failure', async () => {
  const data = fixture();
  const statePath = resolve(data.directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')); state.mode = 'live'; writeFileSync(statePath, JSON.stringify(state));
  const events = [
    { at: '2026-11-11T00:38:00Z', type: 'main_session_stop_observed', turn_id: 'turn-seventeen', stop_attempt_id: 'stop-seventeen', stop_reason: '本轮本地上下文恢复已完成。' },
    { at: '2026-11-11T00:38:01Z', type: 'decision', role: 'judge', stop_attempt_id: 'stop-seventeen', decision: { action: 'CONFIRMED', reason: '下一轮已确认开始。', next_message: '请继续执行当前任务。' } },
    { at: '2026-11-11T00:38:02Z', type: 'stop_hook_direction_returned', stop_attempt_id: 'stop-seventeen', delivery_id: 'delivery-seventeen', execution_confirmed: false },
    { at: '2026-11-11T00:38:03Z', type: 'main_session_recovery_prompt_failed', delivery_id: 'delivery-seventeen', error: '-32600: already has an active writer' },
  ];
  writeFileSync(resolve(data.directory, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const client = await openWebClient(`${running.url}tasks/demo-001`);
    const html = client.document.querySelector('#timeline')!.innerHTML;
    assert.match(html, /NF 推动 A：<\/strong> <span class="event-result result-error">发送失败：-32600: already has an active writer/);
    assert.match(html, /WORKER 收到：<\/strong> <span class="event-result">未交付<\/span>/);
    assert.doesNotMatch(html, /prompt-block/);
    assert.doesNotMatch(html, /请继续执行当前任务。/);
    assert.doesNotMatch(html, /00:38<\/span> <strong>WORKER 收到/);
  } finally { await running.close(); data.cleanup(); }
});

test('web server exposes task, record and validated control endpoints', async () => {
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
    const page = await pageResponse.text();
    assert.match(page, /Needs Forever/);
    assert.match(page, /WORKER 发出[：:]/);
    assert.match(page, /SUPERVISOR 判断[：:]/);
    assert.match(page, /WORKER 收到[：:]/);
    assert.match(page, /data-collapsible/);
    assert.match(page, /data-collapsible-key/);
    assert.match(page, /task-actions/);
    assert.match(page, /actionButtonHtml\('delete'/);
    assert.match(page, /系统级日志不会删除/);
    assert.match(page, /data-action/);
    assert.match(page, /function refresh\(\)/);
    assert.doesNotMatch(page, /location\.reload/);
    assert.match(page, /collapse-marker/);
    assert.match(page, /class="title-row"/);
    assert.doesNotMatch(page, /id="task-session-id"/);
    assert.match(page, /data-session-copy/);
    assert.match(page, /navigator\.clipboard/);
    assert.match(page, /refresh-icon/);
    assert.doesNotMatch(page, /id="refresh"/);
    assert.doesNotMatch(page, /class="project"/);
    assert.doesNotMatch(page, />needs-forever</);
    assert.doesNotMatch(page, /data-filter/);
    assert.doesNotMatch(page, /id="toolbar"/);
    assert.doesNotMatch(page, /supervisor 怎么处理/);
    assert.doesNotMatch(page, /当前回合结束，交由 supervisor 判断下一步/);
    assert.match(page, /status-time/);
    assert.match(page, /status-reason/);
    assert.match(page, /statusText\(s,p\)/);
    assert.match(page, /s==='ACTIVE'&&p==='RECOVERING'\?'恢复中'/);
    assert.doesNotMatch(page, /阶段 \+esc\(r\.state\.phase\)/);

    const mutation = await fetch(`${running.url}api/tasks/demo-001`, { method: 'POST' });
    assert.equal(mutation.status, 405);
    const invalidControl = await fetch(`${running.url}api/tasks/demo-001/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'unknown' }) });
    assert.equal(invalidControl.status, 400);
    const missing = await fetch(`${running.url}api/tasks/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    await running.close();
    data.cleanup();
  }
});

test('NFG catalogs sessions from every daemon workspace', async () => {
  const first = fixture();
  const second = fixture();
  const secondDirectory = resolve(second.workspace, '.codex-supervisor', 'demo-002');
  renameSync(second.directory, secondDirectory);
  const secondStatePath = resolve(secondDirectory, 'state.json');
  const secondState = JSON.parse(readFileSync(secondStatePath, 'utf8'));
  secondState.task_id = 'demo-002';
  secondState.task.task_id = 'demo-002';
  writeFileSync(secondStatePath, `${JSON.stringify(secondState)}\n`);
  const running = await startWebServer({ workspace: first.workspace, workspaces: [second.workspace], port: 0 });
  try {
    const response = await fetch(`${running.url}api/tasks`);
    assert.equal(response.status, 200);
    const ids = (await response.json()).tasks.map((item: { taskId: string }) => item.taskId);
    assert.deepEqual(ids.sort(), ['demo-001', 'demo-002']);
    const record = await fetch(`${running.url}api/tasks/demo-002`);
    assert.equal(record.status, 200);
  } finally {
    await running.close();
    first.cleanup();
    second.cleanup();
  }
});

test('web delete removes the task directory while preserving a system audit record and root system events', async () => {
  const data = fixture();
  const systemEvents = resolve(data.workspace, '.codex-supervisor', 'system-events.jsonl');
  writeFileSync(systemEvents, '{"type":"system_health","scope":"workspace"}\n');
  const statePath = resolve(data.directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.status = 'PAUSED'; state.pause_reason = 'user';
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  const running = await startWebServer({ workspace: data.workspace, port: 0 });
  try {
    const response = await fetch(`${running.url}api/tasks/demo-001/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete' }) });
    assert.equal(response.status, 200);
    assert.equal(existsSync(data.directory), false);
    assert.equal(readFileSync(systemEvents, 'utf8'), '{"type":"system_health","scope":"workspace"}\n');
    const audit = readFileSync(resolve(data.workspace, '.codex-supervisor', 'system-audit', 'events.jsonl'), 'utf8');
    assert.match(audit, /"type":"task_deleted"/);
    assert.match(audit, /"task_id":"demo-001"/);
    assert.match(audit, /"type":"worker_started"/);
  } finally {
    await running.close();
    data.cleanup();
  }
});
