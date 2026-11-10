import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeInventoryDecision, buildC2Context, RouteCatalog, RouteLedger, routeEvidenceDigest, readHistoricalDecision, buildSnapshot, buildMainSessionSnapshot } from '../src/index.js';
import { validateDecision } from '../src/judge.js';
import { validateTask, type MainSessionState, type StopRequest } from '../src/main-session.js';
import type { Decision, Snapshot, State, Task } from '../src/types.js';
import type { RouteCatalogEntry, RouteEvidence } from '../src/route-contract.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const task: Task = { schema_version: 1, task_id: 'planning', workspace: process.cwd(), goal: 'Repair the accepted local dataset.', acceptance: [{ id: 'A1', text: 'Independent coverage check passes.' }], authorization: 'Inspect and repair local files; use only authorized providers.', limits: { max_worker_turns: null, max_minutes: null } };
function snapshot(): Snapshot { return { snapshot_id: 'snapshot', task_id: task.task_id, task_version: 1, worker_thread_id: 'worker', worker_turn_id: 'stop', task: structuredClone(task), evidence: [], evidence_complete: true, omissions: [] }; }
function context(input = snapshot(), state: Partial<State> = {}): Snapshot { return buildC2Context(input, { task_id: task.task_id, task_version: 1, task: input.task, mode: 'live', ...state }); }

test('missing route facts produce a concrete inventory CONTINUE without changing the task contract', () => {
  const input = context();
  assert.equal(input.task.c2, undefined);
  assert.equal(input.c2?.mode, 'enforce');
  const decision = routeInventoryDecision(input);
  assert.equal(validateDecision(JSON.stringify(decision), input).action, 'CONTINUE');
  assert.equal(decision.route_plan?.candidates[0]?.resource.kind, 'diagnostic');
  assert.match(decision.next_message, /inventory|catalog/i);
  assert.ok(decision.route_plan?.single_route_reason);
  assert.throws(() => validateDecision(JSON.stringify({ action: 'CONTINUE', reason: 'Keep working', evidence_ids: [], next_message: 'Audit again', external: null }), input), /route_plan|C2/i);
});

const scope = { task_id: task.task_id, task_version: 1 };
function observation(id: string, content: unknown): RouteEvidence { return { id, source: 'probe', reference: `probe:${id}`, observed_at: '2026-11-10T00:00:00.000Z', task_version: 1, content_sha256: routeEvidenceDigest(content) }; }
function catalogEntry(id: string, kind: RouteCatalogEntry['resource']['kind'] = 'artifact'): RouteCatalogEntry {
  const evidence = observation(`facts:${id}`, { resource: id, authorized: true, authentication: 'not_required', network_required: false, rate_limit: 'clear' });
  return { route_id: id, resource: { kind, id }, operation: 'inspect-and-verify-coverage', status: 'observed', authorization: { status: 'authorized', evidence_ids: [evidence.id] }, network: { required: false, available: null, evidence_ids: [evidence.id] }, authentication: { status: 'not_required', evidence_ids: [evidence.id] }, rate_limit: { status: 'clear', retry_at: null, evidence_ids: [evidence.id] }, last_success: null, capabilities: ['read coverage'], evidence: [evidence] };
}
function withRoutes(entries: RouteCatalogEntry[], input = snapshot(), ledger?: RouteLedger): Snapshot {
  const catalog = new RouteCatalog(scope); entries.forEach((entry) => catalog.upsert(entry));
  return context(input, { route_catalog: catalog.toJSON(), ...(ledger ? { route_ledger: ledger.toJSON() } : {}) });
}
function localPlan(input: Snapshot, entry: RouteCatalogEntry): Decision {
  const result = routeInventoryDecision(input);
  const candidate = { ...structuredClone(result.route_plan!.candidates[0]!), route_id: entry.route_id, resource: entry.resource, operation: entry.operation, hypothesis_id: 'local-coverage', hypothesis: 'The local artifact may contain the required coverage.', status: entry.status, evidence_ids: entry.evidence.map((evidence) => evidence.id), actions: ['Inspect the authorized local artifact and run an independent coverage check.'], expected_evidence: ['Independent artifact coverage report'], expected_signal: 'Missing dates and coverage counts are recorded.' };
  result.route_plan!.candidates.unshift(candidate);
  result.route_plan!.selected_route_id = candidate.route_id;
  result.route_plan!.single_route_reason = null;
  result.route_plan!.selection_reason = 'Local inspection is authorized and avoids the observed provider limit.';
  result.next_message = candidate.actions.join('\n');
  return result;
}

test('Tushare limit evidence selects a real local artifact route and rejects a blind provider retry', () => {
  const local = catalogEntry('data/cache.parquet');
  const provider = catalogEntry('Tushare', 'provider');
  provider.status = 'blocked'; provider.rate_limit = { status: 'limited', retry_at: null, evidence_ids: provider.evidence.map((entry) => entry.id) };
  provider.evidence[0] = observation(provider.evidence[0]!.id, { provider: 'Tushare', response_status: 429, message: 'Daily quota exhausted.' });
  const input = withRoutes([provider, local]);
  const decision = localPlan(input, local);
  decision.diagnosis = { class: 'provider_limit', statement: 'The provider probe returned a rate-limit failure.', evidence_ids: provider.evidence.map((entry) => entry.id) };
  assert.equal(validateDecision(JSON.stringify(decision), input).route_plan!.selected_route_id, 'data/cache.parquet');
  const blind = structuredClone(decision);
  const selected = blind.route_plan!.candidates[0]!;
  Object.assign(selected, { route_id: provider.route_id, resource: provider.resource, operation: provider.operation, status: 'observed', evidence_ids: provider.evidence.map((entry) => entry.id) });
  blind.route_plan!.selected_route_id = provider.route_id;
  assert.throws(() => validateDecision(JSON.stringify(blind), input), /Ungrounded|not executable/i);
});

test('route plans reject invented evidence, identities, availability, fallback and next-message drift', () => {
  const local = catalogEntry('cache.parquet'), input = withRoutes([local]), valid = localPlan(input, local);
  for (const [expected, change] of [
    [/unknown evidence/, (value: Decision) => { value.route_plan!.candidates[0]!.evidence_ids = ['invented']; }],
    [/absent/, (value: Decision) => { value.route_plan!.selected_route_id = 'missing'; }],
    [/identity/, (value: Decision) => { value.route_plan!.candidates[0]!.resource.id = 'other-provider'; }],
    [/fallback/, (value: Decision) => { value.route_plan!.candidates[0]!.fallback.route_id = 'missing'; }],
    [/derived/, (value: Decision) => { value.next_message = 'Tushare is available. Retry it.'; }],
    [/Ungrounded/, (value: Decision) => { value.route_plan!.candidates[1]!.hypothesis = 'The provider is available'; }],
    [/materially different/, (value: Decision) => { value.route_plan!.candidates = [value.route_plan!.candidates[0]!]; }],
  ] as const) {
    const invalid = structuredClone(valid); change(invalid);
    assert.throws(() => validateDecision(JSON.stringify(invalid), input), expected);
  }
});

test('a third equivalent route without substantive new evidence is rejected despite renamed event IDs', () => {
  const local = catalogEntry('cache.parquet');
  const initial = withRoutes([local]);
  const decision = localPlan(initial, local), route = decision.route_plan!.candidates[0]!;
  const ledger = new RouteLedger(scope, { now: () => Date.parse('2026-11-10T00:00:00.000Z') });
  const evidence = observation('attempt-1', { type: 'commandExecution', value: { output: 'same missing dates', exit_code: 1 } });
  ledger.recordAttempt({ route, outcome: 'transient_failure', failure_class: 'missing_dates', evidence_ids: [evidence.id], evidence: [evidence], retry_condition: { kind: 'not_before', not_before: '2026-11-09T00:00:00.000Z', description: 'Retry window was independently observed.', evidence_ids: [evidence.id] } });
  ledger.recordAttempt({ route, outcome: 'failure', failure_class: 'missing_dates', evidence_ids: ['attempt-2'], evidence: [{ ...evidence, id: 'attempt-2', reference: 'new-event-id' }] });
  const current = snapshot();
  current.evidence.push({ id: 'E99', type: 'commandExecution', value: { output: 'same missing dates', exit_code: 1 }, source: { event_id: 'event-99', observed_at: evidence.observed_at } });
  const input = withRoutes([local], current, ledger);
  const repeated = localPlan(input, local);
  repeated.route_plan!.candidates[0]!.evidence_ids.push('E99');
  assert.throws(() => validateDecision(JSON.stringify(repeated), input), /no_progress_limit/);
  assert.equal(validateDecision(JSON.stringify(routeInventoryDecision(input)), input).action, 'CONTINUE');
});

test('terminal gates retain independent proof and require explicit route exhaustion for external wait', () => {
  const input = withRoutes([catalogEntry('cache.parquet')]);
  const done: Decision = { action: 'DONE', reason: 'All acceptance covered.', evidence_ids: ['claim'], next_message: '', external: null };
  input.evidence.push({ id: 'claim', type: 'agentMessage', value: 'All complete' });
  assert.throws(() => validateDecision(JSON.stringify(done), input), /independent evidence/);
  input.evidence.push({ id: 'check', type: 'commandExecution', value: { exitCode: 0 }, source: { event_id: 'checked', observed_at: '2026-11-10T00:00:00.000Z' } });
  done.evidence_ids = ['check'];
  assert.equal(validateDecision(JSON.stringify(done), input).action, 'DONE');
  const wait: Decision = { ...done, action: 'WAIT_EXTERNAL', external: { missing: 'Credential', attempted: ['cache.parquet: inspected'], why_no_other_work: 'Credential required', resume_when: 'Credential supplied' } };
  assert.throws(() => validateDecision(JSON.stringify(wait), input), /attempted\/excluded/);
  assert.throws(() => validateDecision(JSON.stringify(wait), context(input)), /Missing route context/);
});

test('historical legacy CONTINUE remains readable while live default and explicit fixture modes are distinct', () => {
  const legacy = { action: 'CONTINUE', reason: 'Old direction', evidence_ids: [], next_message: 'Inspect result', external: null };
  assert.equal(readHistoricalDecision(JSON.stringify(legacy)).next_message, 'Inspect result');
  assert.throws(() => validateDecision(JSON.stringify(legacy), context()), /C2/);
  const fixture = snapshot(); fixture.task.c2 = { mode: 'legacy' };
  assert.throws(() => context(fixture), /restricted/);
  assert.equal(validateDecision(JSON.stringify(legacy), context(fixture, { mode: 'simulated' })).action, 'CONTINUE');
  assert.deepEqual(validateTask(fixture.task).c2, { mode: 'legacy' });
  assert.equal(validateTask(task).c2, undefined);
});

function baseState(): State { return { schema_version: 1, ...scope, task: structuredClone(task), worker_thread_id: 'worker', status: 'ACTIVE', phase: 'JUDGE', active_worker_turn_id: null, reviewing_turn_id: 'stop', handled_turn_ids: [], pending_action: null, retry: { kind: null, attempt: 0, next_at: null }, last_decision: null, worker_turn_count: 1, elapsed_active_seconds: 0, updated_at: '2026-11-10T00:00:00.000Z', codex_version: null, mode: 'live' }; }
function nativeState(state: State): MainSessionState { return { ...state, control_mode: 'main-session', main_session_id: 'worker', run_generation: 'generation', contract_sha256: 'contract', binding: { status: 'BOUND', tool_use_id: 'bind', bound_at: state.updated_at, challenge: 'challenge', task_path: '/task' }, host: { desktop_version: null, cli_version: null, hook_effective: true, source: 'native-desktop', reason: 'Native hook observed.' } }; }
const stop: StopRequest = { schema_version: 1, ...scope, contract_sha256: 'contract', run_generation: 'generation', session_id: 'worker', turn_id: 'stop', stop_attempt_id: 'stop-1', stop_hook_active: true, created_at: '2026-11-10T00:00:00.000Z', deadline_at: '2026-11-10T00:02:00.000Z', mode: 'live', last_assistant_message: 'Check the current proof.' };

test('ordinary and native snapshots share source-linked route context, current plans and the 24k budget', () => {
  const state = baseState(), catalog = new RouteCatalog(scope), ledger = new RouteLedger(scope);
  for (let index = 0; index < 30; index++) {
    const entry = catalogEntry(`cache-${index}.parquet`); entry.capabilities.push('coverage metadata '.repeat(40)); catalog.upsert(entry);
    const route = routeInventoryDecision(snapshot()).route_plan!.candidates[0]!;
    route.resource.id = `inventory-${index}`; route.route_id = `inventory-${index}`;
    ledger.recordAttempt({ route, outcome: 'diagnostic', evidence_ids: entry.evidence.map((item) => item.id), evidence: entry.evidence });
  }
  state.route_catalog = catalog.toJSON(); state.route_ledger = ledger.toJSON(); state.last_decision = routeInventoryDecision(snapshot());
  const ordinary = buildSnapshot(state, 'stop', [
    { event_id: 'proof', at: state.updated_at, type: 'worker_evidence', thread_id: 'worker', method: 'item/completed', params: { turnId: 'stop', item: { id: 'check', type: 'commandExecution', command: 'check-coverage', exitCode: 1, aggregatedOutput: 'Missing 2026-11-09' } } },
    { event_id: 'worker-plan', type: 'worker_evidence', thread_id: 'worker', method: 'turn/plan/updated', params: { turnId: 'stop', plan: [{ step: 'Repair missing day', status: 'in_progress' }] } },
    { event_id: 'verify', at: state.updated_at, type: 'verification_result', passed: false },
  ]);
  const native = buildMainSessionSnapshot(nativeState(state), stop, [
    { event_id: 'native-plan', at: state.updated_at, ...scope, type: 'main_tool_result', session_id: 'worker', run_generation: 'generation', input_epoch: 0, contract_sha256: 'contract', tool_use_id: 'plan', value: { tool_name: 'functions.update_plan', tool_input: { plan: [{ step: 'Repair missing day', status: 'in_progress' }] } } },
    { event_id: 'native-proof', at: state.updated_at, ...scope, type: 'main_tool_result', session_id: 'worker', run_generation: 'generation', input_epoch: 0, contract_sha256: 'contract', tool_use_id: 'check', complete: true, value: { tool_input: { cmd: 'check-coverage' }, tool_response: 'Missing 2026-11-09' } },
    { event_id: 'verify', at: state.updated_at, ...scope, type: 'verification_result', passed: false },
    { event_id: 'stop-observed', ...scope, type: 'main_session_stop_observed' },
  ]);
  for (const input of [ordinary, native]) {
    assert.ok(JSON.stringify(input).length <= 24_000);
    assert.deepEqual(input.task, task);
    assert.match(JSON.stringify(input.evidence), /Missing 2026-11-09/);
    assert.match(JSON.stringify(input.plan), /Repair missing day/);
    assert.equal(input.c2!.current_plan!.plan_id, state.last_decision.route_plan!.plan_id);
    assert.ok(input.c2!.catalog.entries.length > 0, 'Keep a bounded catalog summary.');
    assert.ok(input.c2!.ledger.attempts.length > 0, 'Keep a bounded ledger summary.');
    assert.ok(input.c2!.observations.every((item) => item.reference && /^[a-f0-9]{64}$/.test(item.content_sha256) && item.observed_at === state.updated_at));
    assert.equal(input.c2!.context_complete, false);
    assert.match(input.omissions!.join(' '), /C2 budget omissions/);
    assert.match(JSON.stringify(input.recent_verification), /false/);
  }
});

test('proof digests ignore event/item labels but detect changed substantive content across Stop snapshots', () => {
  const state = baseState();
  function input(id: string, output: string): Snapshot { return buildSnapshot(state, 'stop', [{ event_id: `event-${id}`, at: state.updated_at, type: 'worker_evidence', thread_id: 'worker', method: 'item/completed', params: { turnId: 'stop', item: { id, type: 'commandExecution', command: 'check', exitCode: 1, aggregatedOutput: output } } }]); }
  const first = input('one', 'Still missing a day').c2!.observations[0]!;
  const second = input('two', 'Still missing a day').c2!.observations[0]!;
  const third = input('two', 'Coverage now complete').c2!.observations[0]!;
  assert.notEqual(first.reference, second.reference);
  assert.equal(first.content_sha256, second.content_sha256);
  assert.notEqual(second.content_sha256, third.content_sha256);
});

test('multiple executable directions require two substantive candidates rather than a repeated inventory alternative', () => {
  const first = catalogEntry('one.parquet'), second = catalogEntry('two.parquet'), input = withRoutes([first, second]);
  const plan = localPlan(input, first);
  assert.throws(() => validateDecision(JSON.stringify(plan), input), /two substantive candidates/);
  plan.route_plan!.candidates[1] = localPlan(input, second).route_plan!.candidates[0]!;
  assert.equal(validateDecision(JSON.stringify(plan), input).route_plan!.selected_route_id, 'one.parquet');
});

test('external waiting is accepted only with complete independently evidenced exhaustion of named routes', () => {
  const entry = catalogEntry('only-authorized-cache.parquet');
  entry.status = 'exhausted';
  const route = localPlan(withRoutes([catalogEntry(entry.route_id)]), catalogEntry(entry.route_id)).route_plan!.candidates[0]!;
  const ledger = new RouteLedger(scope);
  ledger.recordAttempt({ route, outcome: 'exhausted', evidence_ids: entry.evidence.map((item) => item.id), evidence: entry.evidence });
  const input = snapshot();
  input.evidence.push({ id: 'actual-check', type: 'commandExecution', value: { command: 'check-required-input', exitCode: 1, output: 'Required data absent after all authorized route checks.' }, source: { event_id: 'check-event', observed_at: '2026-11-10T00:00:00.000Z' } });
  withRoutes([entry], input, ledger);
  const wait: Decision = { action: 'WAIT_EXTERNAL', reason: 'The independently checked missing input is necessary.', evidence_ids: ['actual-check'], next_message: '', external: { missing: 'User-supplied source data', attempted: [`${entry.route_id}: actual local coverage inspection found no required data`], why_no_other_work: 'Only the missing input remains after the authorized local check.', resume_when: 'The user supplies source data.' }, diagnosis: null, route_plan: null };
  assert.equal(validateDecision(JSON.stringify(wait), input).action, 'WAIT_EXTERNAL');
  wait.external!.attempted = ['An unnamed route was checked'];
  assert.throws(() => validateDecision(JSON.stringify(wait), input), /only-authorized-cache/);
});

test('installed runtime exposes the same enforced C2 planning and historical-reading boundary', async () => {
  const installed = await import(pathToFileURL(resolve('plugins/needs-forever/runtime/src/index.js')).href);
  const input = installed.buildC2Context(snapshot(), baseState());
  const decision = installed.routeInventoryDecision(input);
  assert.equal(installed.validateDecision(JSON.stringify(decision), input).route_plan.selected_route_id, 'route-inventory');
  const legacy = { action: 'CONTINUE', reason: 'Historical', evidence_ids: [], next_message: 'Old direction', external: null };
  assert.equal(installed.readHistoricalDecision(JSON.stringify(legacy)).next_message, 'Old direction');
  assert.throws(() => installed.validateDecision(JSON.stringify(legacy), input), /C2/);
});
