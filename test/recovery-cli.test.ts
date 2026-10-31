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
  writeFileSync(config, JSON.stringify({ trace, state_file: state }));
  writeFileSync(fixtureFile, JSON.stringify({ app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), config], judge: { action: 'DONE', reason: 'Accepted fixture result.', evidence_ids: ['E1'], next_message: '', external: null }, recovery_enabled: true, recovery_delays_ms: [0, 0, 0], ...options }));
  return { task, state, fixtureFile, directory, run() { return spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'start', '--task', task, '--state', state, '--test-fixture', fixtureFile], { encoding: 'utf8', timeout: 5000 }); } };
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
