import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildC2Context, captureRouteOutcome, confirmRouteExecution, discoverLocalRoutes, plannerFailureFallback, prepareRouteExecution, routeInventoryDecision, validateDecision } from '../src/index.js';
import type { Snapshot, State } from '../src/index.js';

function runtimeState(name: string): State {
  const workspace = resolve('runs/ticket52', `${name}-${Date.now()}`, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return { schema_version: 1, task_id: name, task_version: 1, task: { schema_version: 1, task_id: name, workspace, goal: 'Read the authorized local result.', acceptance: [{ id: 'A1', text: 'Result independently checked.' }], authorization: 'Local workspace inspection.', limits: { max_worker_turns: null, max_minutes: null } }, worker_thread_id: 'worker', status: 'ACTIVE', phase: 'WORKER', active_worker_turn_id: null, reviewing_turn_id: null, handled_turn_ids: [], pending_action: null, retry: { kind: null, attempt: 0, next_at: null }, last_decision: null, worker_turn_count: 0, elapsed_active_seconds: 0, updated_at: new Date().toISOString(), codex_version: null, mode: 'simulated' };
}
function context(state: State, evidence: Snapshot['evidence'] = [], complete = true): Snapshot {
  return buildC2Context({ snapshot_id: 'snapshot', task_id: state.task_id, task_version: state.task_version, worker_thread_id: 'worker', worker_turn_id: 'turn', task: state.task, evidence, evidence_complete: complete, omissions: complete ? [] : ['Current proof truncated.'] }, state);
}

test('inventory fallback passes active validation with two observed alternatives and incomplete proof', () => {
  const state = runtimeState('fallback-catalog');
  writeFileSync(resolve(state.task.workspace, 'a.json'), '{"source":"a"}');
  writeFileSync(resolve(state.task.workspace, 'b.json'), '{"source":"b"}');
  discoverLocalRoutes(state);
  assert.equal(state.route_catalog?.entries.length, 2);
  const snapshot = context(state, [], false);
  snapshot.c2!.context_complete = false;
  const fallback = plannerFailureFallback(snapshot, 'Three invalid C outputs.');
  assert.equal(validateDecision(JSON.stringify(fallback), snapshot).route_plan?.selected_route_id, 'route-inventory');
  assert.equal(fallback.route_plan?.candidates[0]?.resource.kind, 'diagnostic');
});

test('completed generic file inventory does not claim relevant unfinished work or prevent an evidenced external wait', () => {
  const state = runtimeState('inventory-scope');
  writeFileSync(resolve(state.task.workspace, 'readme.txt'), 'Unrelated project notes.');
  discoverLocalRoutes(state);
  const result = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify({required_input_exists:require('node:fs').existsSync('required-input.key')}))"], { cwd: state.task.workspace, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const snapshot = context(state, [{ id: 'E1', type: 'commandExecution', value: { command: 'check required input', exitCode: 0, aggregatedOutput: result.stdout }, source: { event_id: 'input-check', observed_at: new Date().toISOString() } }]);
  const routeId = state.route_catalog!.entries[0]!.route_id;
  const decision = { action: 'WAIT_EXTERNAL', reason: 'The required user input has not arrived.', evidence_ids: ['E1'], next_message: '', external: { missing: 'required-input.key', attempted: [`${routeId}: B completed a bounded read-only inventory; it proves file readability only and supplies no required input.`], why_no_other_work: 'The remaining acceptance requires the absent user input.', resume_when: 'The user supplies required-input.key.' } };
  assert.equal(validateDecision(JSON.stringify(decision), snapshot).action, 'WAIT_EXTERNAL');
});

test('confirmed route result survives restart, ignores relabeled identical proof and prevents another equivalent send', () => {
  const state = runtimeState('no-progress');
  const artifact = resolve(state.task.workspace, 'result.json');
  writeFileSync(artifact, '{"rows":17}');
  const result = spawnSync(process.execPath, ['-e', "console.log(require('node:fs').readFileSync('result.json','utf8'))"], { cwd: state.task.workspace, encoding: 'utf8' });
  assert.equal(result.status, 0);
  discoverLocalRoutes(state);
  const proof = (eventId: string): Snapshot['evidence'] => [{ id: 'E1', type: 'commandExecution', value: { id: eventId, command: 'read result.json', exitCode: result.status, aggregatedOutput: result.stdout }, source: { event_id: eventId, observed_at: new Date().toISOString() } }];
  const first = context(state, proof('event-one'));
  prepareRouteExecution(state, routeInventoryDecision(first), first, 'delivery', 'source-stop');
  assert.equal(captureRouteOutcome(state, first, 'unknown-send'), null, 'Unknown sends cannot count as attempts.');
  confirmRouteExecution(state, 'delivery');
  const restarted = JSON.parse(JSON.stringify(state)) as State;
  assert.ok(captureRouteOutcome(restarted, context(restarted, proof('event-two')), 'next-stop'));
  assert.equal(restarted.route_ledger?.attempts.length, 1);
  assert.equal(restarted.route_ledger?.attempts[0]?.outcome, 'failure');
  assert.equal(captureRouteOutcome(restarted, context(restarted, proof('event-three')), 'another-stop'), null);
  const next = context(restarted, proof('event-four'));
  assert.throws(() => prepareRouteExecution(restarted, routeInventoryDecision(next), next, 'repeated-delivery', 'next-stop'), /repeated route/);
  assert.throws(() => plannerFailureFallback(next, 'C failed again.'), /repeated route/);
  const renamed = routeInventoryDecision(next);
  renamed.route_plan!.candidates[0]!.resource.id = 'model-renamed-inventory';
  renamed.route_plan!.candidates[0]!.operation = 'review-g0-instead-of-audit-g0';
  assert.throws(() => prepareRouteExecution(restarted, renamed, next, 'renamed-delivery', 'next-stop'), /repeated route/);
});

test('a newer human epoch cannot attribute its admitted native Stop to an older route', () => {
  const state = Object.assign(runtimeState('epoch-fence'), { run_generation: 'generation', input_epoch: 1, contract_sha256: 'immutable-contract' });
  const snapshot = context(state);
  prepareRouteExecution(state, routeInventoryDecision(snapshot), snapshot, 'delivery', 'source-stop');
  state.input_epoch++;
  assert.equal(captureRouteOutcome(state, context(state), 'user-steered-stop', true), null);
  assert.equal(state.route_ledger?.attempts.length ?? 0, 0);
});

test('an independently observed reset time permits one evidenced transient route retry', () => {
  const state = runtimeState('observed-retry');
  const first = context(state);
  prepareRouteExecution(state, routeInventoryDecision(first), first, 'first-delivery', 'first-stop');
  confirmRouteExecution(state, 'first-delivery');
  const result = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify({retry_at:'2001-01-01T00:00:00.000Z'}));process.exit(1)"], { cwd: state.task.workspace, encoding: 'utf8' });
  assert.equal(result.status, 1);
  const stopped = context(state, [{ id: 'E1', type: 'commandExecution', value: { command: 'bounded transient check', exitCode: result.status, aggregatedOutput: result.stdout }, source: { event_id: 'reset-proof', observed_at: new Date().toISOString() } }]);
  captureRouteOutcome(state, stopped, 'second-stop');
  assert.equal(state.route_ledger?.attempts[0]?.outcome, 'transient_failure');
  const retry = context(state, stopped.evidence);
  assert.doesNotThrow(() => prepareRouteExecution(state, routeInventoryDecision(retry), retry, 'retry-delivery', 'second-stop'));
});

test('ordinary selected route delivery and next Stop retain one persisted execution and factual local inventory', () => {
  const directory = resolve('runs/ticket52', `ordinary-${Date.now()}`);
  const workspace = resolve(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(resolve(workspace, 'cached-result.json'), '{"rows":17}\n');
  const trace = resolve(directory, 'protocol.jsonl'), scenario = resolve(directory, 'server.json');
  const check = [process.execPath, '-e', "console.log(require('node:fs').readFileSync('cached-result.json','utf8'))"];
  writeFileSync(scenario, JSON.stringify({ trace, state_file: resolve(directory, 'state.json'), real_judge: true, judge_actions: ['CONTINUE', 'DONE'], worker_commands: [[check], [check]] }));
  const fixture = resolve(directory, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ real_judge: true, app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), scenario] }));
  const task = resolve(directory, 'task.json'), statePath = resolve(directory, 'state.json');
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: 'ordinary-route', workspace, goal: 'Complete result.', acceptance: [{ id: 'A1', text: 'Accepted result.' }], authorization: 'Local workspace inspection and changes.' }));
  const run = spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'start', '--task', task, '--state', statePath, '--test-fixture', fixture], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const events = readFileSync(resolve(directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const plan = events.find((event) => event.type === 'decision' && event.decision.action === 'CONTINUE').decision.route_plan;
  const prepared = events.find((event) => event.type === 'send_prepared' && event.source_turn_id);
  assert.equal(prepared.plan_id, plan.plan_id);
  assert.equal(prepared.route_id, plan.selected_route_id);
  for (const type of ['send_attempted', 'send_confirmed', 'route_outcome']) {
    const event = events.find((item) => item.type === type && item.delivery_id === prepared.delivery_id);
    assert.equal(event?.plan_id, plan.plan_id, type);
    assert.equal(event?.source_stop_attempt_id, prepared.source_stop_attempt_id, type);
  }
  assert.equal(state.route_ledger.attempts.length, 1);
  assert.equal(state.route_ledger.attempts[0].evidence[0].source, 'event');
  assert.equal(state.route_catalog.entries.some((entry: any) => entry.resource.id === 'cached-result.json' && entry.status === 'observed'), true);
  assert.equal(state.route_catalog.entries.some((entry: any) => entry.resource.kind === 'provider' && entry.status === 'observed'), false);
});

for (const failure of ['invalid', 'empty', 'timeout']) test(`ordinary ${failure} C outputs produce one bounded factual inventory fallback`, () => {
  const directory = resolve('runs/ticket52', `fallback-${failure}-${Date.now()}`), workspace = resolve(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(resolve(workspace, 'result.txt'), 'Source artifact exists.');
  const trace = resolve(directory, 'protocol.jsonl'), scenario = resolve(directory, 'server.json'), statePath = resolve(directory, 'state.json');
  const check = [process.execPath, '-e', "console.log(require('node:fs').readFileSync('result.txt','utf8'))"];
  writeFileSync(scenario, JSON.stringify({ trace, state_file: statePath, real_judge: true, worker_commands: [[check], [check]], ...(failure === 'timeout' ? { hold_judge_until: 3 } : { judge_outputs: [failure === 'invalid' ? '{broken' : '', failure === 'invalid' ? '{broken' : '', failure === 'invalid' ? '{broken' : ''] }) }));
  const fixture = resolve(directory, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ real_judge: true, judge_timeout_ms: failure === 'timeout' ? 100 : 1000, recovery_delays_ms: [0], app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), scenario] }));
  const task = resolve(directory, 'task.json');
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: `fallback-${failure}`, workspace, goal: 'Check the result.', acceptance: [{ id: 'A1', text: 'The source artifact was read.' }], authorization: 'Local workspace inspection.' }));
  const result = spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'start', '--task', task, '--state', statePath, '--test-fixture', fixture], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const events = readFileSync(resolve(directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const fallback = events.filter((entry) => entry.type === 'judge_inventory_fallback');
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].failures, 3);
  assert.equal(fallback[0].decision.route_plan.candidates[0].resource.kind, 'diagnostic');
  assert.equal(events.filter((entry) => entry.type === 'send_prepared' && entry.source_turn_id).length, 1);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).route_ledger.attempts.length, 1);
});
