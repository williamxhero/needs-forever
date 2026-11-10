import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Deterministic planner/host evidence, actual local subprocesses. No provider call.
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--runtime', '--directory'].includes(process.argv[i]) || flags[process.argv[i]] || !process.argv[i + 1]) throw new Error('Expected unique --runtime/--directory values.');
  flags[process.argv[i]] = process.argv[i + 1];
}
const runtime = resolve(flags['--runtime'] ?? 'plugins/needs-forever/runtime');
const directory = resolve(flags['--directory'] ?? `runs/ticket54/acceptance-${Date.now()}`);
if (existsSync(directory)) throw new Error('Acceptance directory must be fresh.');
const workspace = resolve(directory, 'workspace');
mkdirSync(workspace, { recursive: true });
const api = await import(pathToFileURL(resolve(runtime, 'src/index.js')).href);
const scope = { task_id: 'B0QI-historical-pattern-fixture', task_version: 1 };
const task = { schema_version: 1, task_id: scope.task_id, workspace, goal: 'Produce the two-row fixture coverage result despite a Tushare quota blocker.', acceptance: [{ id: 'A1', text: 'The independently checked local result contains exactly the required two dates.' }], authorization: 'Use only this generated local fixture workspace; no network/provider access.', limits: { max_worker_turns: null, max_minutes: null } };
const state = { ...scope, task, mode: 'simulated' };
const catalog = new api.RouteCatalog(scope), ledger = new api.RouteLedger(scope);
let sequence = 0;
const receipts = [];
function probe(code) {
  const argv = [process.execPath, '-e', code];
  const result = spawnSync(argv[0], argv.slice(1), { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  if (result.error || result.status === null) throw result.error ?? new Error('Probe terminated without an exit status.');
  const id = `local-probe-${++sequence}`, observed_at = new Date().toISOString();
  const value = { command: JSON.stringify(argv), exitCode: result.status, aggregatedOutput: result.stdout + result.stderr };
  const event = { event_id: id, at: observed_at, type: 'commandExecution', value };
  appendFileSync(resolve(directory, 'events.jsonl'), JSON.stringify(event) + '\n');
  receipts.push(event);
  return { id, type: event.type, value, source: { event_id: id, observed_at } };
}
function fact(entry) { return api.snapshotRouteEvidence({ task_version: 1, evidence: [entry], evidence_complete: true })[0]; }
function routeEntry(id, kind, resourceId, status, proof) {
  const evidence = [fact(proof)], refs = evidence.map((item) => item.id);
  return { route_id: id, resource: { kind, id: resourceId }, operation: 'verify-fixture-coverage', status,
    authorization: { status: 'authorized', evidence_ids: refs }, network: { required: false, available: null, evidence_ids: refs }, authentication: { status: 'not_required', evidence_ids: refs }, rate_limit: { status: status === 'blocked' ? 'limited' : 'clear', retry_at: null, evidence_ids: refs }, last_success: null, capabilities: ['fixture coverage'], evidence };
}
function context(proof, sourceLedger = ledger) {
  return api.buildC2Context({ snapshot_id: `snapshot-${sequence}`, ...scope, worker_thread_id: 'simulated-A', worker_turn_id: 'simulated-stop', task, evidence: proof, evidence_complete: true, omissions: [] }, { ...state, route_catalog: catalog.toJSON(), route_ledger: sourceLedger.toJSON() });
}
function candidate(entry, actions) {
  return { route_id: entry.route_id, resource: entry.resource, operation: entry.operation, hypothesis_id: 'fixture-coverage', hypothesis: entry.status === 'observed' ? 'The authorized local CSV can supply the two fixture dates.' : 'The synthetic quota blocker excludes this fixture route.', expected_evidence: ['Independently checked two-date fixture coverage'], status: entry.status, evidence_ids: entry.evidence.map((item) => item.id), actions, expected_signal: 'A checked two-row result or a concrete missing-file failure.', risk: 'Fixture data proves only the acceptance exercise, not historical market coverage.', fallback: { route_id: null, when: 'If the local artifact fails, collect its exact failure and replan; do not blindly retry Tushare.' }, discriminating_check: null };
}
function plan(input, local, provider) {
  const result = api.routeInventoryDecision(input);
  result.reason = 'The Tushare-pattern fixture is quota blocked; a real local artifact is readable.';
  result.diagnosis = { class: 'provider_limit', statement: 'The synthetic provider command returned a quota failure.', evidence_ids: provider.evidence.map((item) => item.id) };
  const chosen = candidate(local, ['Read local-b0qi.csv, write result.json, and independently check that coverage contains exactly 2026-11-05 and 2026-11-06.']);
  result.route_plan = { plan_id: 'b0qi-local-alternate', candidates: [chosen, candidate(provider, ['Do not retry the quota-blocked fixture provider.'])], selected_route_id: local.route_id, selection_reason: 'Use the authorized local artifact with observed readability and no network requirement.', single_route_reason: null, success_condition: 'Independent Node verifier reports exactly two expected dates.', stop_condition: 'Stop after the verification report or exact local failure; never loop through equivalent G0/G1 audits.' };
  result.next_message = chosen.actions.join('\n');
  return result;
}
// This is a deliberate synthetic provider failure, never a live Tushare probe.
const providerProof = probe("console.error(JSON.stringify({fixture_provider:'Tushare',status:429,error:'synthetic daily quota exhausted'}));process.exit(29)");
writeFileSync(resolve(workspace, 'local-b0qi.csv'), 'date,value\n2026-11-05,17\n2026-11-06,19\n');
const localProof = probe("const fs=require('node:fs');console.log(JSON.stringify({readable:fs.statSync('local-b0qi.csv').isFile(),bytes:fs.readFileSync('local-b0qi.csv').length}))");
const provider = routeEntry('tushare-quota-fixture', 'provider', 'synthetic:Tushare', 'blocked', providerProof);
const local = routeEntry('local-b0qi-artifact', 'artifact', 'local-b0qi.csv', 'observed', localProof);
catalog.upsert(provider); catalog.upsert(local);
ledger.recordAttempt({ route: candidate(provider, ['Inspect quota failure.']), outcome: 'blocked', evidence_ids: [providerProof.id], evidence: [fact(providerProof)], failure_class: 'provider_limit' });
const input = context([providerProof, localProof]), selected = plan(input, local, provider);
api.validateDecision(JSON.stringify(selected), input);
writeFileSync(resolve(directory, 'selected-decision.json'), JSON.stringify(selected, null, 2) + '\n');
writeFileSync(resolve(directory, 'selected-input.json'), JSON.stringify(input, null, 2) + '\n');
const blind = structuredClone(selected);
blind.route_plan.selected_route_id = provider.route_id;
blind.next_message = blind.route_plan.candidates[1].actions.join('\n');
assert.throws(() => api.validateDecision(JSON.stringify(blind), input), /not executable/);
const admission = { ...state, route_catalog: catalog.toJSON(), route_ledger: ledger.toJSON() };
api.prepareRouteExecution(admission, selected, input, 'fixture-delivery', 'fixture-stop');
api.confirmRouteExecution(admission, 'fixture-delivery');
const execution = probe("const fs=require('node:fs');const rows=fs.readFileSync('local-b0qi.csv','utf8').trim().split(/\\r?\\n/).slice(1).map(x=>x.split(',')[0]);fs.writeFileSync('result.json',JSON.stringify({dates:rows}));console.log(JSON.stringify({wrote:'result.json',rows:rows.length}))");
assert.equal(execution.value.exitCode, 0);
const verification = probe("const assert=require('node:assert/strict'),fs=require('node:fs');const value=JSON.parse(fs.readFileSync('result.json','utf8'));assert.deepEqual(value.dates,['2026-11-05','2026-11-06']);console.log(JSON.stringify({passed:true,rows:value.dates.length,dates:value.dates}))");
assert.equal(verification.value.exitCode, 0);
const doneSnapshot = context([execution, verification]);
api.captureRouteOutcome(admission, doneSnapshot, 'fixture-success-stop');
const done = { action: 'DONE', reason: 'The actual local verifier checked every generated fixture acceptance item.', evidence_ids: [verification.id], next_message: '', external: null, diagnosis: null, route_plan: null };
api.validateDecision(JSON.stringify(done), doneSnapshot);
const wait = { action: 'WAIT_EXTERNAL', reason: 'The remaining required fixture data has no authorized executable source.', evidence_ids: [providerProof.id], next_message: '', external: { missing: 'Required local fixture input or an explicitly authorized replacement.', attempted: [`${provider.route_id}: synthetic quota command failed.`, `${local.route_id}: exact local input is absent.`], why_no_other_work: 'This exercise authorizes only the generated local artifact and synthetic provider; both are explicitly excluded.', resume_when: 'Supply the required local fixture input or authorize a replacement.' }, diagnosis: null, route_plan: null };
assert.throws(() => api.validateDecision(JSON.stringify(wait), input), /attempted\/excluded/);
// Controlled fault injection affects only the CSV created by this exercise.
const failure = probe("const fs=require('node:fs');fs.unlinkSync('local-b0qi.csv');try{fs.readFileSync('local-b0qi.csv')}catch(e){console.error(JSON.stringify({path:'local-b0qi.csv',code:e.code,fault_injection:'generated fixture input removed'}));process.exit(2)}");
assert.equal(failure.value.exitCode, 2);
const exhaustedLocal = { ...local, status: 'exhausted', evidence: [fact(failure)] };
for (const key of ['authorization', 'network', 'authentication', 'rate_limit']) exhaustedLocal[key] = { ...local[key], evidence_ids: [failure.id] };
catalog.upsert(exhaustedLocal);
ledger.recordAttempt({ route: candidate(local, ['Read the required local input.']), outcome: 'exhausted', evidence_ids: [failure.id], evidence: [fact(failure)], failure_class: 'missing_local_input' });
const waitSnapshot = context([providerProof, failure]); wait.evidence_ids = [providerProof.id, failure.id];
api.validateDecision(JSON.stringify(wait), waitSnapshot);
// Equivalent audits cannot become fresh routes by renaming their prose/IDs.
const repeatedLedger = new api.RouteLedger(scope);
const identity = candidate(local, ['Inspect the same missing local input.']);
repeatedLedger.recordAttempt({ route: identity, outcome: 'transient_failure', evidence_ids: [failure.id], evidence: [fact(failure)], failure_class: 'missing_local_input', retry_condition: { kind: 'not_before', not_before: '2020-01-01T00:00:00.000Z', description: 'Synthetic elapsed retry window.', evidence_ids: [failure.id] } });
repeatedLedger.recordAttempt({ route: { ...identity, route_id: 'renamed-g0' }, outcome: 'failure', evidence_ids: [failure.id], evidence: [fact(failure)], failure_class: 'missing_local_input' });
assert.equal(repeatedLedger.evaluateAttempt({ ...identity, route_id: 'renamed-g1', hypothesis: 'Audit using equivalent words.' }).reason, 'no_progress_limit');
catalog.upsert(local);
const repeatSnapshot = context([failure], repeatedLedger);
assert.throws(() => api.prepareRouteExecution({ ...state, route_catalog: catalog.toJSON(), route_ledger: repeatedLedger.toJSON() }, plan(repeatSnapshot, local, provider), repeatSnapshot, 'forbidden-third', 'third-stop'), /repeated route/);
const report = { mode: 'simulated-planner-actual-local-execution', runtime, directory, runtime_index_sha256: createHash('sha256').update(readFileSync(resolve(runtime, 'src/index.js'))).digest('hex'),
  historical_pattern: 'NF://B0QI repeated Tushare/G0/G1 failure; generated CSV and quota responses are synthetic fixtures, not real market data/provider observations.',
  success: { selected_route: local.route_id, decisions: [selected.action, done.action], verified_rows: 2, route_outcome: admission.route_ledger.attempts.at(-1).outcome, note: 'B conservatively records diagnostic; DONE is independently verified, not inferred from a shell exit.' },
  exhausted: { before_exclusions_rejected: true, final_action: wait.action, excluded_routes: catalog.list().map((item) => item.route_id), actual_failed_local_probe: failure.id }, repetition: { equivalent_third_attempt_rejected: true }, blind_tushare_retry_rejected: true,
  actual_local_commands: receipts.length, live_model: 'not_run', live_provider: 'not_run', limitations: 'Deterministic fixed decisions exercise installed public C2 boundaries. The replacement planner is simulated; this is not native live Stop effectiveness or production B0QI completion.' };
for (const [name, value] of Object.entries({ 'report.json': report, 'done-decision.json': done, 'done-input.json': doneSnapshot, 'wait-decision.json': wait, 'wait-input.json': waitSnapshot, 'route-ledger.json': ledger.toJSON(), 'repeated-ledger.json': repeatedLedger.toJSON() })) writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
