import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
function fixture(name: string, options: Record<string, unknown>) {
  const directory = resolve('runs/ticket29', `${name}-${Date.now()}`);
  const workspace = resolve(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const task = resolve(directory, 'task.json');
  const state = resolve(directory, 'state.json');
  const config = resolve(directory, 'scenario.json');
  const fixtureFile = resolve(directory, 'fixture.json');
  const trace = resolve(directory, 'protocol.jsonl');
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, goal: 'Complete the accepted result.', acceptance: [{ id: 'A1', text: 'The result is checked.' }], authorization: 'Local workspace only.', limits: { max_worker_turns: null, max_minutes: null } }));
  writeFileSync(config, JSON.stringify({ trace, state_file: state, ...options }));
  writeFileSync(fixtureFile, JSON.stringify({ app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), config], judge: { action: 'DONE', reason: 'Accepted fixture result.', evidence_ids: ['E1'], next_message: '', external: null }, recovery_enabled: true, recovery_delays_ms: [0, 0, 0], ...options }));
  return { task, state, fixtureFile, trace, directory, run() { return spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'start', '--task', task, '--state', state, '--test-fixture', fixtureFile], { encoding: 'utf8', timeout: 5000 }); } };
}

test('recoverable judge failures retry forever with visible classification and no attempt limit', () => {
  const run = fixture('retry-sequence', { judge_failures: ['Judge timeout.', 'Unexpected token } in JSON'] });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  const state = json(run.state);
  assert.equal(state.status, 'DONE');
  assert.equal(state.retry.next_at, null);
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /judge_timeout/);
  assert.match(events, /invalid_judge_output/);
  assert.match(result.stdout, /RECOVERING:/);
});

test('quota-shaped failure enters WAIT_EXTERNAL while ordinary 429 remains retryable', () => {
  const quota = fixture('quota-wait', { judge_failures: ['429 insufficient quota credits'] });
  const quotaResult = quota.run();
  assert.equal(quotaResult.status, 0, quotaResult.stderr);
  assert.equal(json(quota.state).status, 'WAIT_EXTERNAL');
  const rate = fixture('rate-limit-retry', { judge_failures: ['HTTP 429 Too Many Requests'] });
  const rateResult = rate.run();
  assert.equal(rateResult.status, 0, rateResult.stderr);
  assert.equal(json(rate.state).status, 'DONE');
  assert.match(rateResult.stdout, /rate_limit/);
});

test('real judge invalid JSON is archived before a fresh judge retries the same snapshot', () => {
  const run = fixture('real-invalid-json', {
    real_judge: true,
    tool_items: [{ type: 'commandExecution', id: 'check', command: 'check', status: 'completed', exitCode: 0, aggregatedOutput: 'A1 passes.' }],
    judge_outputs: ['{"action":"DONE"}', JSON.stringify({ action: 'DONE', reason: 'Accepted fixture result.', evidence_ids: ['E1'], next_message: '', external: null })],
  });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(run.state).status, 'DONE');
  const protocol = readFileSync(run.trace, 'utf8');
  assert.equal((protocol.match(/"method":"thread\/start"/g) ?? []).length, 3);
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /invalid_judge_output/);
});

test('worker disconnect keeps the sent delivery, reconnects the same worker and resends only after history is absent', () => {
  const run = fixture('worker-disconnect', { disconnect_on_send_once: true });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(run.state).status, 'DONE');
  assert.equal(json(run.state).worker_thread_id, 'worker-from-server');
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /connection_reconnected/);
  assert.match(events, /send_reconciled_absent/);
  assert.equal((events.match(/"type":"send_confirmed"/g) ?? []).length, 1);
});

test('live worker failed terminal recovers through history and a fresh continuation', () => {
  const run = fixture('live-worker-failed-terminal', {
    terminal_statuses: ['failed', 'completed'],
    resume_turns: [{ id: 'first-turn-from-server', status: 'failed', error: { message: 'Worker command exited with code 17.' }, items: [] }],
  });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(run.state).status, 'DONE');
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /worker_terminal_recovery_required/);
  assert.match(events, /worker_history_failed_continuation/);
  assert.equal((events.match(/"type":"send_confirmed"/g) ?? []).length, 2);
  const sends = readFileSync(run.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'worker-from-server');
  assert.equal(sends.length, 2);
  assert.notEqual(sends[0].message.params.clientUserMessageId, sends[1].message.params.clientUserMessageId);
});

test('live worker interrupted terminal confirms history before a fresh continuation', () => {
  const run = fixture('live-worker-interrupted-terminal', {
    terminal_statuses: ['interrupted', 'completed'],
    resume_turns: [{ id: 'first-turn-from-server', status: 'interrupted', items: [] }],
  });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(run.state).status, 'DONE');
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /worker_terminal_recovery_required/);
  assert.match(events, /worker_history_interrupted/);
  assert.equal((events.match(/"type":"send_confirmed"/g) ?? []).length, 2);
  const sends = readFileSync(run.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'worker-from-server');
  assert.equal(sends.length, 2);
  assert.notEqual(sends[0].message.params.clientUserMessageId, sends[1].message.params.clientUserMessageId);
});

test('worker quota failure waits externally and explicit resume reconciles the failed turn', () => {
  const run = fixture('live-worker-quota-resume', {
    terminal_statuses: ['failed', 'completed'],
    terminal_errors: [{ message: 'Account quota exceeded; restore credits before continuing.' }],
  });
  const first = run.run();
  assert.equal(first.status, 0, first.stderr);
  const waiting = json(run.state);
  assert.equal(waiting.status, 'WAIT_EXTERNAL');
  assert.equal(waiting.phase, 'IDLE');
  assert.equal(waiting.active_worker_turn_id, 'first-turn-from-server');
  const scenario = json(resolve(run.directory, 'scenario.json'));
  scenario.resume_turns = [{ id: 'first-turn-from-server', status: 'failed', error: { message: 'Account quota exceeded; restore credits before continuing.' }, items: [] }];
  writeFileSync(resolve(run.directory, 'scenario.json'), JSON.stringify(scenario));
  const resumed = spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'resume', '--state', run.state, '--test-fixture', run.fixtureFile], { encoding: 'utf8', timeout: 5000 });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(json(run.state).status, 'DONE');
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /external_wait_required/);
  assert.match(events, /worker_history_failed_continuation/);
});

test('periodic reconcile hydrates paginated history and compensates a missed completion once', () => {
  const run = fixture('periodic-paginated-reconcile', {
    hold_worker: true,
    reconcile_interval_ms: 20,
    reconcile_turns: [{ id: 'newer-unrelated-turn', status: 'completed', items: [] }],
    turns_backwards_cursor: '0',
    turn_pages: [{ data: [{ id: 'first-turn-from-server', status: 'completed', items: [] }], nextCursor: null }],
  });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(run.state).status, 'DONE');
  const protocol = readFileSync(run.trace, 'utf8');
  assert.match(protocol, /"method":"thread\/turns\/list"/);
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.equal((events.match(/"type":"decision"/g) ?? []).length, 1);
  assert.equal((events.match(/"type":"send_confirmed"/g) ?? []).length, 1);
});

test('thread closed notification reconnects the saved worker and follows recovered history', () => {
  const run = fixture('thread-closed-recovery', {
    hold_worker: true,
    thread_closed_after_ms: 10,
    resume_turns: [{ id: 'first-turn-from-server', status: 'completed', items: [] }],
  });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  const state = json(run.state);
  assert.equal(state.status, 'DONE');
  assert.equal(state.worker_thread_id, 'worker-from-server');
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /worker_thread_unavailable/);
  assert.match(events, /connection_reconnected/);
});

test('real judge timeout closes the old app-server, reconnects the worker and retries with a fresh judge', () => {
  const run = fixture('real-judge-timeout-recovery', {
    real_judge: true,
    judge_timeout_ms: 50,
    hold_judge_once: true,
    tool_items: [{ type: 'commandExecution', id: 'check', command: 'check', status: 'completed', exitCode: 0, aggregatedOutput: 'A1 passes.' }],
    judge_outputs: [JSON.stringify({ action: 'DONE', reason: 'Accepted after timeout recovery.', evidence_ids: ['E1'], next_message: '', external: null })],
  });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(run.state).status, 'DONE');
  const state = json(run.state);
  assert.ok(state.judge_thread_ids.length >= 2);
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /judge_timeout/);
  assert.match(events, /connection_reconnected/);
});

test('three identical judge failures appear in the next judge snapshot as an investigation instruction', () => {
  const invalid = '{"action":"DONE"}';
  const run = fixture('repeated-judge-failures', {
    real_judge: true,
    tool_items: [{ type: 'commandExecution', id: 'check', command: 'check', status: 'completed', exitCode: 0, aggregatedOutput: 'A1 passes.' }],
    judge_outputs: [invalid, invalid, invalid, JSON.stringify({ action: 'DONE', reason: 'Accepted after investigation.', evidence_ids: ['E1'], next_message: '', external: null })],
  });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  const judgeInputs = readFileSync(run.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId.startsWith('judge-'))
    .map((entry) => JSON.parse(entry.message.params.input[0].text));
  const investigated = judgeInputs.find((input) => input.repeated_failure?.investigate === true);
  assert.ok(investigated, 'No judge snapshot carried the repeated-failure gate.');
  assert.match(investigated.repeated_failure.instruction, /different hypothesis|distinguishing check|different route/i);
});

test('transient initial app-server startup failure uses the same recovery backoff before creating the worker', () => {
  const run = fixture('initial-connect-recovery', { fail_startup_once: true });
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(run.state).status, 'DONE');
  const events = readFileSync(resolve(run.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"recovery_retry_scheduled"/);
  assert.match(events, /service_unavailable/);
});

test('pausing during recovery cancels the backoff timer immediately', () => {
  const run = fixture('pause-recovery', { judge_failures: ['Judge timeout.'], pause_after_ms: 50, recovery_delays_ms: [5000] });
  const started = Date.now();
  const result = run.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 2000, 'Pause should cancel the recovery backoff instead of waiting five seconds.');
  const state = json(run.state);
  assert.equal(state.status, 'PAUSED');
  assert.equal(state.retry.next_at, null);
});
