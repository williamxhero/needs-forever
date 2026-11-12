import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildC2Context, captureRouteOutcome, confirmRouteExecution, discoverLocalRoutes, ingestRouteObservations, plannerFailureFallback, prepareRouteExecution, routeInventoryDecision, validateDecision } from '../src/index.js';
import type { Snapshot, State } from '../src/index.js';
import { RouteLedger, canonicalExecutionRoute } from '../src/route-ledger.js';

function runtimeState(name: string): State {
  const workspace = resolve('runs/ticket52', `${name}-${Date.now()}`, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return { schema_version: 1, task_id: name, task_version: 1, task: { schema_version: 1, task_id: name, workspace, goal: 'Read the authorized local result.', acceptance: [{ id: 'A1', text: 'Result independently checked.' }], authorization: 'Local workspace inspection.', limits: { max_worker_turns: null, max_minutes: null } }, worker_thread_id: 'worker', status: 'ACTIVE', phase: 'WORKER', active_worker_turn_id: null, reviewing_turn_id: null, handled_turn_ids: [], pending_action: null, retry: { kind: null, attempt: 0, next_at: null }, last_decision: null, worker_turn_count: 0, elapsed_active_seconds: 0, updated_at: new Date().toISOString(), codex_version: null, mode: 'simulated' };
}
function context(state: State, evidence: Snapshot['evidence'] = [], complete = true): Snapshot {
  return buildC2Context({ snapshot_id: 'snapshot', task_id: state.task_id, task_version: state.task_version, worker_thread_id: 'worker', worker_turn_id: 'turn', task: state.task, evidence, evidence_complete: complete, omissions: complete ? [] : ['Current proof truncated.'] }, state);
}

test('a complete inventory beside truncated output is independently probed and counts as real route progress', () => {
  const state = runtimeState('mixed-result-inventory');
  mkdirSync(resolve(state.task.workspace, 'cache'));
  writeFileSync(resolve(state.task.workspace, 'cache/result.json'), '{"rows":17}');
  const before = context(state);
  prepareRouteExecution(state, routeInventoryDecision(before), before, 'delivery', 'stop-one');
  confirmRouteExecution(state, 'delivery');
  const inventory = { nf_route_inventory: { schema_version: 1, task_id: state.task_id, task_version: 1, routes: [{ route_id: 'actual-result', resource: { kind: 'artifact', id: 'cache/result.json' }, operation: 'read-local-artifact' }] } };
  const next = context(state, [
    Object.assign({ id: 'good', type: 'commandExecution', value: { exitCode: 0, aggregatedOutput: JSON.stringify(inventory) }, source: { event_id: 'real-inventory', observed_at: new Date().toISOString(), thread_id: 'worker', turn_id: 'turn' } }, { complete: true }),
    Object.assign({ id: 'partial', type: 'commandExecution', value: { exitCode: 1, aggregatedOutput: 'Partial failed unrelated output' }, source: { event_id: 'partial-result', observed_at: new Date().toISOString(), thread_id: 'worker', turn_id: 'turn' } }, { complete: false }),
  ], false);
  const outcome = captureRouteOutcome(state, next, 'stop-two');
  assert.equal(state.route_catalog?.entries.find(e => e.route_id === 'actual-result')?.status, 'observed');
  assert.equal(outcome?.outcome, 'diagnostic', 'Only complete independent output may establish progress or failure.');
  assert.equal(next.evidence_complete, false, 'A valid sibling cannot authorize terminal completion.');
});

test('planner fallback uses the full persisted retry ledger and requires fresh discriminating proof', () => {
  const state = runtimeState('full-ledger-fallback');
  const initial = context(state), route = routeInventoryDecision(initial).route_plan!.candidates[0]!;
  const ledger = new RouteLedger({ task_id: state.task_id, task_version: 1 });
  for (let i = 0; i < 2; i++) ledger.recordObservedAttempt({ route: canonicalExecutionRoute(route, []), outcome: 'failure', failure_class: 'no_independent_progress', evidence_ids: [], evidence: [] });
  state.route_ledger = ledger.toJSON();
  const hidden = context(state); hidden.c2!.ledger.attempts = [];
  assert.throws(() => plannerFailureFallback(hidden, 'Three C timeouts.', state), /no_progress_limit/);
  const observed = context(state, [Object.assign({ id: 'new-proof', type: 'commandExecution', value: { exitCode: 0, aggregatedOutput: 'Actual new inventory result.' }, source: { event_id: 'fresh', observed_at: new Date().toISOString(), thread_id: 'worker' } }, { complete: true })], false);
  observed.c2!.ledger.attempts = [];
  const fallback = plannerFailureFallback(observed, 'Three C timeouts.', state);
  assert.doesNotThrow(() => prepareRouteExecution(state, fallback, observed, 'new-delivery', 'stop'));
  assert.deepEqual(state.route_ledger, ledger.toJSON(), 'Proposal/admission cannot count a new attempt.');
});

test('bounded C-output fallback can admit one diagnostic recovery after the route guard rejects a planner proposal', () => {
  const state = runtimeState('planner-fallback-override');
  const initial = context(state);
  const route = routeInventoryDecision(initial).route_plan!.candidates[0]!;
  const ledger = new RouteLedger({ task_id: state.task_id, task_version: 1 });
  ledger.recordObservedAttempt({ route: canonicalExecutionRoute(route, []), outcome: 'diagnostic', evidence_ids: [], evidence: [] });
  state.route_ledger = ledger.toJSON();
  assert.throws(() => plannerFailureFallback(initial, 'Three C outputs were rejected.', state), /change_hypothesis/);
  assert.doesNotThrow(() => plannerFailureFallback(initial, 'Three C outputs were rejected.', state, { allowRecoveryOverride: true }));
});

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

test('a diagnostic with omitted observation digests records an honest failed attempt at the next native Stop', () => {
  const state = runtimeState('missing-diagnostic-digests');
  const first = context(state, [{ id: 'E1', type: 'commandExecution', value: { exitCode: 0, stdout: 'Truncated current proof.' }, source: { event_id: 'source', observed_at: new Date().toISOString() } }], false);
  const decision = routeInventoryDecision(first);
  decision.route_plan!.candidates[0]!.evidence_ids = ['E1'];
  decision.route_plan!.candidates[0]!.discriminating_check = { description: 'Read the authorized inventory to discriminate missing facts.', evidence_ids: ['E1'] };
  prepareRouteExecution(state, decision, first, 'delivery', 'source-stop');
  const next = context(state);
  assert.doesNotThrow(() => captureRouteOutcome(state, next, 'next-native-stop', true));
  assert.equal(state.route_ledger?.attempts.length, 1);
  assert.equal(state.route_ledger!.attempts[0]!.outcome, 'failure');
  assert.equal(state.route_ledger!.attempts[0]!.discriminating_check, null, 'Missing independent digests must not become a claimed factual check.');
  assert.deepEqual(state.route_ledger!.attempts[0]!.evidence, []);
  assert.equal(captureRouteOutcome(state, next, 'repeated-stop', true), null);
});

test('a reused evidence label at the next Stop cannot satisfy an omitted original diagnostic reference', () => {
  const state = runtimeState('reused-diagnostic-label');
  const proof = (event: string, value: string): Snapshot['evidence'] => [{ id: 'E1', type: 'commandExecution', value: { exitCode: 0, stdout: value }, source: { event_id: event, observed_at: new Date().toISOString() } }];
  const first = context(state, proof('original-source', 'Original incomplete proof'), false);
  const decision = routeInventoryDecision(first);
  decision.route_plan!.candidates[0]!.evidence_ids = ['E1'];
  decision.route_plan!.candidates[0]!.discriminating_check = { description: 'Original proposed check.', evidence_ids: ['E1'] };
  prepareRouteExecution(state, decision, first, 'delivery', 'source-stop');
  captureRouteOutcome(state, context(state, proof('different-source', 'Independent later observation')), 'next-stop', true);
  const attempt = state.route_ledger!.attempts[0]!;
  assert.equal(attempt.outcome, 'diagnostic', 'Real new observations may still establish progress.');
  assert.equal(attempt.discriminating_check, null, 'A reused label must not substitute a different source for the original check.');
  assert.equal(state.route_execution!.discriminating_check!.description, 'Original proposed check.');
});

test('public inventory execution ingests independently probed nested artifacts across restart and selects a correlated alternate', () => {
  const state = runtimeState('source-linked-inventory');
  mkdirSync(resolve(state.task.workspace, 'cache'), { recursive: true });
  writeFileSync(resolve(state.task.workspace, 'cache', 'prices.csv'), 'date,close\n2026-11-09,17\n');
  const first = context(state);
  prepareRouteExecution(state, routeInventoryDecision(first), first, 'inventory-delivery', 'initial-stop');
  confirmRouteExecution(state, 'inventory-delivery');
  const inventory = { nf_route_inventory: { schema_version: 1, task_id: state.task_id, task_version: state.task_version, routes: [
    { route_id: 'nested-price-cache', resource: { kind: 'artifact', id: 'cache/prices.csv' }, operation: 'read-local-artifact' },
    { route_id: 'unverified-provider', resource: { kind: 'provider', id: 'configured-provider' }, operation: 'query-prices' },
  ] } };
  const result = spawnSync(process.execPath, ['-e', 'console.log(process.argv[1])', JSON.stringify(inventory)], { cwd: state.task.workspace, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const stopped = context(state, [{ id: 'E1', type: 'commandExecution', value: { command: 'bounded inventory descriptor', exitCode: 0, aggregatedOutput: result.stdout }, source: { event_id: 'actual-inventory-result', observed_at: new Date().toISOString(), thread_id: 'worker', turn_id: 'turn' } }]);
  captureRouteOutcome(state, stopped, 'inventory-stop');
  const restarted = JSON.parse(JSON.stringify(state)) as State;
  discoverLocalRoutes(restarted);
  const snapshot = context(restarted);
  const artifact = snapshot.c2!.catalog.entries.find((entry) => entry.route_id === 'nested-price-cache');
  assert.equal(artifact?.status, 'observed', 'B must independently read the nested file, not just record an observation digest.');
  assert.equal(artifact?.inventory_only, undefined);
  assert.ok(artifact!.evidence.some((proof) => proof.reference === 'actual-inventory-result'));
  assert.ok(artifact!.evidence.some((proof) => proof.source === 'probe' && proof.reference === 'workspace-file:cache/prices.csv'));
  const provider = snapshot.c2!.catalog.entries.find((entry) => entry.route_id === 'unverified-provider');
  assert.equal(provider?.status, 'candidate');
  assert.equal(provider?.authentication.status, 'unknown');
  assert.equal(provider?.network.available, null);
  assert.equal(provider?.rate_limit.status, 'unknown');
  const selected = routeInventoryDecision(snapshot);
  const route = selected.route_plan!.candidates[0]!;
  Object.assign(route, { route_id: artifact!.route_id, resource: artifact!.resource, operation: artifact!.operation, status: 'observed', evidence_ids: artifact!.evidence.map((proof) => proof.id), actions: ['Read cache/prices.csv and verify the accepted date.'] });
  selected.route_plan!.selected_route_id = artifact!.route_id;
  selected.next_message = route.actions.join('\n');
  const correlation = prepareRouteExecution(restarted, selected, snapshot, 'cache-delivery', 'inventory-stop');
  confirmRouteExecution(restarted, 'cache-delivery');
  assert.equal(correlation.route_id, 'nested-price-cache');
  assert.equal(correlation.plan_id, selected.route_plan!.plan_id);
  assert.equal(correlation.source_stop_attempt_id, 'inventory-stop');
  assert.equal(restarted.route_execution?.confirmed, true);
});

test('inventory hints cannot forge facts, reuse historical/model evidence, expand scope or traverse symlink parents', () => {
  const state = runtimeState('unsafe-inventory');
  const outside = resolve(state.task.workspace, '..', 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(resolve(outside, 'data.csv'), 'outside scope');
  symlinkSync(outside, resolve(state.task.workspace, 'linked-parent'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(resolve(state.task.workspace, 'data.csv'), 'actual local proof');
  const hint = { route_id: 'hint', resource: { kind: 'artifact', id: 'data.csv' }, operation: 'read-local-artifact' };
  const fixture = (route: unknown = hint): Snapshot => context(state, [{ id: 'E1', type: 'commandExecution', value: { command: 'descriptor only', exitCode: 0, aggregatedOutput: JSON.stringify({ nf_route_inventory: { schema_version: 1, task_id: state.task_id, task_version: state.task_version, routes: [route] } }) }, source: { event_id: 'source', observed_at: new Date().toISOString(), thread_id: 'worker', turn_id: 'turn' } }]);
  for (const invalid of [
    { ...hint, status: 'observed', authentication: { status: 'present' } },
    { ...hint, resource: { kind: 'artifact', id: '../outside/data.csv' } },
    { ...hint, resource: { kind: 'artifact', id: resolve(outside, 'data.csv') } },
    { ...hint, resource: { kind: 'artifact', id: 'linked-parent/data.csv' } },
    { ...hint, resource: { kind: 'artifact', id: 'credentials.json' } },
    { ...hint, route_id: 'sk-abcdefghijklmnop' },
  ]) assert.equal(ingestRouteObservations(state, fixture(invalid)), 0);
  const assistant = fixture(); assistant.evidence[0]!.type = 'agentMessage';
  const historic = fixture(); historic.evidence[0]!.source!.observed_at = '2000-01-01T00:00:00.000Z';
  const foreignTurn = fixture(); foreignTurn.evidence[0]!.source!.turn_id = 'previous-turn';
  const foreignTask = fixture(); foreignTask.task_id = 'other-task';
  const obsolete = fixture(); obsolete.task_version++;
  const changedContract = fixture(); changedContract.task = { ...changedContract.task, authorization: 'Injected permission grant' };
  const truncated = fixture(); truncated.evidence_complete = false;
  const forgedInput = fixture(); forgedInput.evidence[0]!.type = 'functionCallOutput'; forgedInput.evidence[0]!.value = { hook_event_name: 'PostToolUse', tool_input: { nf_route_inventory: hint }, tool_response: 'No observation descriptor was returned.' };
  for (const invalid of [assistant, historic, foreignTurn, foreignTask, obsolete, changedContract, truncated, forgedInput]) assert.equal(ingestRouteObservations(state, invalid), 0);
  assert.equal(state.route_catalog, undefined);
  assert.equal(ingestRouteObservations(state, fixture()), 1);
  const rebinding = fixture({ ...hint, resource: { kind: 'provider', id: 'unverified' } });
  assert.equal(ingestRouteObservations(state, rebinding), 0, 'An existing route ID cannot be rebound to a different resource.');
  const unsupported = fixture({ route_id: 'candidate-provider', resource: { kind: 'provider', id: 'configured' }, operation: 'query' });
  assert.equal(ingestRouteObservations(state, unsupported), 1);
  assert.equal(state.route_catalog!.entries.find((entry) => entry.route_id === 'candidate-provider')!.status, 'candidate');
});

test('workspace inventory honors original protected-data access exclusions and keeps ambiguous authorization unverified', () => {
  const state = runtimeState('contract-exclusions');
  mkdirSync(resolve(state.task.workspace, 'forward-holdout'), { recursive: true });
  mkdirSync(resolve(state.task.workspace, 'reports'), { recursive: true });
  mkdirSync(resolve(state.task.workspace, '.scratch'), { recursive: true });
  writeFileSync(resolve(state.task.workspace, 'forward-holdout', 'prices.csv'), 'unreleased holdout data');
  writeFileSync(resolve(state.task.workspace, 'reports', 'manifest.json'), '{"holdout_registered":true}');
  writeFileSync(resolve(state.task.workspace, 'restricted.csv'), 'restricted data');
  writeFileSync(resolve(state.task.workspace, '.scratch', 'route-audit.json'), '{"local_cache_present":true}');
  writeFileSync(resolve(state.task.workspace, '.scratch', 'sensitive-audit.json'), '{"forbidden":true}');
  state.task.authorization += ' Do not read restricted.csv.';
  state.task.acceptance.push({ id: 'S5', text: '登记时间门 holdout；不提前读取或执行 holdout。' });
  discoverLocalRoutes(state);
  assert.equal(state.route_catalog!.entries.some((entry) => entry.resource.id === 'restricted.csv'), false, 'Generic root discovery must use the same authorization/probe boundary.');
  const observe = (id: string, path: string) => {
    const payload = { nf_route_inventory: { schema_version: 1, task_id: state.task_id, task_version: state.task_version, routes: [{ route_id: id, resource: { kind: 'artifact', id: path }, operation: 'read-local-artifact' }] } };
    return ingestRouteObservations(state, context(state, [{ id: 'E1', type: 'commandExecution', value: { aggregatedOutput: JSON.stringify(payload) }, source: { event_id: `source-${id}`, observed_at: new Date().toISOString(), thread_id: 'worker', turn_id: 'turn' } }]));
  };
  assert.equal(observe('holdout', 'forward-holdout/prices.csv'), 1);
  assert.equal(observe('restricted', 'restricted.csv'), 1);
  for (const id of ['holdout', 'restricted']) {
    const entry = state.route_catalog!.entries.find((item) => item.route_id === id)!;
    assert.notEqual(entry.status, 'observed');
    assert.notEqual(entry.authorization.status, 'authorized');
    assert.equal(entry.evidence.some((proof) => proof.source === 'probe'), false);
    assert.equal(entry.last_success, null);
  }
  assert.equal(observe('metadata', 'reports/manifest.json'), 1);
  assert.equal(state.route_catalog!.entries.find((item) => item.route_id === 'metadata')!.status, 'observed');
  assert.equal(observe('scratch-audit', '.scratch/route-audit.json'), 1);
  assert.equal(state.route_catalog!.entries.find((item) => item.route_id === 'scratch-audit')!.status, 'observed');
  state.task.authorization += ' Do not read .scratch/sensitive-audit.json.';
  assert.equal(observe('forbidden-scratch', '.scratch/sensitive-audit.json'), 1);
  assert.equal(state.route_catalog!.entries.find((item) => item.route_id === 'forbidden-scratch')!.status, 'candidate');
  state.task.authorization += ' Never read any restricted material.';
  assert.equal(observe('ambiguous', 'reports/manifest.json'), 1);
  assert.equal(state.route_catalog!.entries.find((item) => item.route_id === 'ambiguous')!.status, 'candidate');
});

test('current contract/version revalidation fences inherited Catalog facts at context and delivery admission', () => {
  const state = runtimeState('catalog-authorization-fence');
  writeFileSync(resolve(state.task.workspace, 'restricted.csv'), 'task data');
  discoverLocalRoutes(state);
  const before = context(state), entry = before.c2!.catalog.entries[0]!;
  const selected = routeInventoryDecision(before);
  Object.assign(selected.route_plan!.candidates[0]!, { route_id: entry.route_id, resource: entry.resource, operation: entry.operation, status: 'observed', evidence_ids: entry.evidence.map((proof) => proof.id) });
  selected.route_plan!.selected_route_id = entry.route_id;
  state.task = { ...state.task, authorization: 'Local workspace inspection. Do not read restricted.csv.' }; state.task_version++;
  discoverLocalRoutes(state);
  const after = context(state);
  assert.notEqual(after.c2!.catalog.entries[0]!.status, 'observed');
  assert.notEqual(state.route_catalog!.entries[0]!.authorization.status, 'authorized');
  assert.ok(after.c2!.catalog.entries[0]!.evidence.some((proof) => proof.task_version === 1), 'Old observations stay available for audit.');
  assert.throws(() => validateDecision(JSON.stringify(selected), after), /Ungrounded|not executable|unknown evidence/);
  assert.throws(() => prepareRouteExecution(state, selected, before, 'stale-delivery', 'new-stop'), /scope|contract|version/i);
});

test('an observed artifact may be explicitly excluded after a correlated current failure without editing Catalog status', () => {
  const state = runtimeState('observed-exclusion');
  writeFileSync(resolve(state.task.workspace, 'cache.csv'), 'date,close\n');
  const hint = { nf_route_inventory: { schema_version: 1, task_id: state.task_id, task_version: 1, routes: [{ route_id: 'cache', resource: { kind: 'artifact', id: 'cache.csv' }, operation: 'read-local-artifact' }] } };
  const before = context(state, [{ id: 'E1', type: 'commandExecution', value: { aggregatedOutput: JSON.stringify(hint) }, source: { event_id: 'inventory', observed_at: new Date().toISOString(), thread_id: 'worker', turn_id: 'turn' } }]);
  ingestRouteObservations(state, before);
  const selected = routeInventoryDecision(context(state)), entry = state.route_catalog!.entries[0]!;
  Object.assign(selected.route_plan!.candidates[0]!, { route_id: 'cache', resource: entry.resource, operation: entry.operation, status: 'observed', evidence_ids: entry.evidence.map((proof) => proof.id), actions: ['Check cache.csv for the required input date.'] });
  selected.route_plan!.selected_route_id = 'cache'; selected.next_message = selected.route_plan!.candidates[0]!.actions.join('\n');
  prepareRouteExecution(state, selected, context(state), 'cache-send', 'inventory-stop'); confirmRouteExecution(state, 'cache-send');
  const result = spawnSync(process.execPath, ['-e', 'const fs=require("node:fs");if(!fs.readFileSync("cache.csv","utf8").includes("2026-11-09")){console.error("Required user-supplied date absent from the only authorized cache");process.exit(2)}'], { cwd: state.task.workspace, encoding: 'utf8' });
  assert.equal(result.status, 2);
  const failure = context(state, [{ id: 'E1', type: 'commandExecution', value: { command: 'check exact required cache date', exitCode: result.status, aggregatedOutput: result.stderr }, source: { event_id: 'actual-missing-date', observed_at: new Date().toISOString(), thread_id: 'worker', turn_id: 'turn' } }]);
  captureRouteOutcome(state, failure, 'cache-failure-stop');
  const stopped = context(state, failure.evidence);
  assert.equal(state.route_catalog!.entries[0]!.status, 'observed', 'A failed check must not automatically exhaust every use of this readable artifact.');
  const wait = { action: 'WAIT_EXTERNAL', reason: 'The necessary user-supplied date is absent.', evidence_ids: ['E1'], next_message: '', external: { missing: 'The required user input date.', attempted: ['cache: E1 independently checked the sole authorized artifact; the required date is absent.'], why_no_other_work: 'This task authorizes only this cache and cannot manufacture the user input.', resume_when: 'User supplies the required date in cache.csv.' }, diagnosis: null, route_plan: null };
  assert.equal(validateDecision(JSON.stringify(wait), stopped).action, 'WAIT_EXTERNAL');
  const uncorrelated = structuredClone(wait); uncorrelated.external.attempted = ['cache: worker says unavailable'];
  assert.throws(() => validateDecision(JSON.stringify(uncorrelated), stopped), /attempted\/excluded/);
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

test('ordinary CLI ingests actual tool inventory before C selects and B delivers the executable alternate once', () => {
  const directory = resolve('runs/spec49-review', `production-inventory-${Date.now()}`), workspace = resolve(directory, 'workspace');
  mkdirSync(resolve(workspace, 'data'), { recursive: true });
  writeFileSync(resolve(workspace, 'data', 'prices.csv'), 'date,close\n2026-11-09,17\n');
  const taskId = 'production-inventory';
  const hint = { nf_route_inventory: { schema_version: 1, task_id: taskId, task_version: 1, routes: [{ route_id: 'price-cache', resource: { kind: 'artifact', id: 'data/prices.csv' }, operation: 'read-local-artifact' }] } };
  const trace = resolve(directory, 'protocol.jsonl'), scenario = resolve(directory, 'server.json'), statePath = resolve(directory, 'state.json');
  writeFileSync(scenario, JSON.stringify({ trace, state_file: statePath, real_judge: true, judge_actions: ['CONTINUE', 'CONTINUE', 'DONE'], judge_select_observed_artifact: true, worker_commands: [
    [[process.execPath, '-e', 'console.log("Synthetic provider limit; alternate inventory required.");process.exit(1)']],
    [[process.execPath, '-e', 'console.log(process.argv[1])', JSON.stringify(hint)]],
    [[process.execPath, '-e', 'console.log(require("node:fs").readFileSync("data/prices.csv","utf8"))']],
  ] }));
  const fixture = resolve(directory, 'fixture.json'), task = resolve(directory, 'task.json');
  writeFileSync(fixture, JSON.stringify({ real_judge: true, app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), scenario] }));
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: taskId, workspace, goal: 'Use the local cache after provider limit.', acceptance: [{ id: 'A1', text: 'Read and check cached prices.' }], authorization: 'Local workspace inspection.' }));
  const result = spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'start', '--task', task, '--state', statePath, '--test-fixture', fixture], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.status, 'DONE');
  assert.equal(state.route_catalog.entries.find((entry: any) => entry.route_id === 'price-cache')?.status, 'observed');
  const events = readFileSync(resolve(directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const selected = events.find((event) => event.type === 'send_prepared' && event.route_id === 'price-cache');
  assert.ok(selected, 'Production Stop capture must ingest before the next judge snapshot.');
  for (const type of ['send_prepared', 'send_attempted', 'send_confirmed', 'route_outcome']) {
    const matches = events.filter((event) => event.type === type && event.delivery_id === selected.delivery_id);
    assert.equal(matches.length, 1, type);
    assert.equal(matches[0].plan_id, selected.plan_id);
    assert.equal(matches[0].route_id, 'price-cache');
    assert.equal(matches[0].source_stop_attempt_id, selected.source_stop_attempt_id);
  }
  const sends = readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'worker-from-server' && entry.message.params.input[0]?.text.includes('Read data/prices.csv'));
  assert.equal(sends.length, 1);
});

for (const failure of ['invalid', 'empty', 'timeout', 'authentication-prose']) test(`ordinary ${failure} C outputs produce one bounded factual inventory fallback`, () => {
  const directory = resolve('runs/ticket52', `fallback-${failure}-${Date.now()}`), workspace = resolve(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(resolve(workspace, 'result.txt'), 'Source artifact exists.');
  const trace = resolve(directory, 'protocol.jsonl'), scenario = resolve(directory, 'server.json'), statePath = resolve(directory, 'state.json');
  const check = [process.execPath, '-e', "console.log(require('node:fs').readFileSync('result.txt','utf8'))"];
  const invalidClaim = routeInventoryDecision(context(runtimeState('invalid-auth-claim')));
  invalidClaim.route_plan!.candidates[0]!.hypothesis = 'The provider is authenticated';
  const output = failure === 'authentication-prose' ? JSON.stringify(invalidClaim) : failure === 'invalid' ? '{broken' : '';
  writeFileSync(scenario, JSON.stringify({ trace, state_file: statePath, real_judge: true, worker_commands: [[check], [check]], ...(failure === 'timeout' ? { hold_judge_until: 3 } : { judge_outputs: [output, output, output] }) }));
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
  assert.equal(events.some((entry) => entry.type === 'external_wait_required'), false);
});
