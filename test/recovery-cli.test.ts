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
