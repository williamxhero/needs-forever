import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteCatalog, RouteLedger, fingerprintRoute, routeEvidenceDigest, type RouteCatalogEntry, type RouteIdentity } from '../src/index.js';

const scope = { task_id: 'c2-task', task_version: 1 };
const at = '2026-11-10T00:00:00.000Z';
function observation(id: string, value: unknown) {
  return { id, source: 'probe' as const, reference: `checks/${id}`, observed_at: at, task_version: 1, content_sha256: routeEvidenceDigest(value) };
}
function capability(status: RouteCatalogEntry['status']): RouteCatalogEntry {
  return {
    route_id: `quotes-${status}`, resource: { kind: 'provider', id: 'tushare' }, operation: 'daily-quotes',
    status, authorization: { status: 'authorized', evidence_ids: ['probe-1'] },
    network: { required: true, available: true, evidence_ids: ['probe-1'] },
    authentication: { status: 'present', evidence_ids: ['probe-1'] },
    rate_limit: { status: 'clear', retry_at: null, evidence_ids: ['probe-1'] },
    last_success: { at, evidence_ids: ['probe-1'] }, capabilities: ['stock.daily'],
    evidence: [{ id: 'probe-1', source: 'probe', reference: 'events/probe-1', observed_at: at, task_version: 1, content_sha256: 'a'.repeat(64) }],
  };
}

test('Route Catalog preserves all capability states and independently observed facts after restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nf-catalog-')), 'catalog.json');
  const catalog = new RouteCatalog(scope, { path });
  for (const status of ['observed', 'candidate', 'blocked', 'exhausted', 'forbidden', 'unknown'] as const) catalog.upsert(capability(status));
  const restored = new RouteCatalog(scope, { path });
  assert.deepEqual(restored.list().map((route) => route.status), ['observed', 'candidate', 'blocked', 'exhausted', 'forbidden', 'unknown']);
  assert.deepEqual(restored.get('quotes-observed'), capability('observed'));
  assert.deepEqual(new RouteCatalog(scope, { data: restored.toJSON() }).list(), restored.list());
});

const route: RouteIdentity = {
  route_id: 'tushare-daily', resource: { kind: 'provider', id: 'tushare' }, operation: 'daily-quotes',
  hypothesis_id: 'transient-throttle', hypothesis: 'The daily endpoint has a temporary rate limit.',
  expected_evidence: ['a complete daily quote response'],
};

test('Route Ledger persists outcomes and evidence deltas while semantic identity ignores prompt wording', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nf-ledger-')), 'ledger.json');
  const ledger = new RouteLedger(scope, { path, now: () => Date.parse(at) });
  const first = ledger.recordAttempt({ route, outcome: 'failure', failure_class: 'rate_limit', evidence_ids: ['stop-1'] });
  assert.equal(first.attempt_number, 1);
  assert.deepEqual(first.new_evidence_ids, ['stop-1']);
  assert.equal(fingerprintRoute({ ...route, route_id: 'renamed', hypothesis: 'Reworded prompt about temporary throttling.' }), first.fingerprint);
  assert.notEqual(fingerprintRoute({ ...route, resource: { kind: 'artifact', id: 'local-quotes.parquet' } }), first.fingerprint);
  assert.notEqual(fingerprintRoute({ ...route, operation: 'minute-quotes' }), first.fingerprint);
  assert.notEqual(fingerprintRoute({ ...route, hypothesis_id: 'missing-permission' }), first.fingerprint);
  assert.notEqual(fingerprintRoute({ ...route, expected_evidence: ['an explicit permission response'] }), first.fingerprint);
  assert.deepEqual(new RouteLedger(scope, { path }).list(), ledger.list());
  assert.deepEqual(new RouteLedger(scope, { data: ledger.toJSON() }).list(), ledger.list());
});

test('new event IDs do not manufacture evidence progress and reused IDs can carry new substantive evidence', () => {
  const ledger = new RouteLedger(scope);
  const observation = (id: string, value: unknown) => ({ id, source: 'probe' as const, reference: `snapshots/${id}`, observed_at: at, task_version: 1, content_sha256: routeEvidenceDigest(value) });
  ledger.recordAttempt({ route, outcome: 'success', evidence_ids: ['E1'], evidence: [observation('E1', { code: 429, provider: 'tushare' })] });
  const duplicate = ledger.recordAttempt({ route, outcome: 'success', evidence_ids: ['new-uuid'], evidence: [observation('new-uuid', { provider: 'tushare', code: 429 })] });
  assert.deepEqual(duplicate.new_evidence_ids, []);
  const changed = ledger.recordAttempt({ route, outcome: 'success', evidence_ids: ['E1'], evidence: [observation('E1', { code: 200, rows: 250 })] });
  assert.deepEqual(changed.new_evidence_ids, ['E1']);
});

test('only a meaningful transient retry is allowed before a third no-progress family attempt is rejected', () => {
  let now = Date.parse(at);
  const ledger = new RouteLedger(scope, { now: () => now });
  const failure = { route, outcome: 'transient_failure' as const, failure_class: 'rate_limit', evidence_ids: ['stop-1'], evidence: [observation('stop-1', { retry_after: 60, code: 429 })], retry_condition: { kind: 'not_before' as const, not_before: '2026-11-10T00:01:00.000Z', description: 'The observed response says retry after sixty seconds.', evidence_ids: ['stop-1'] } };
  const first = ledger.recordAttempt(failure);
  assert.equal(first.next_attempt.allowed, false);
  assert.equal(ledger.evaluateAttempt(route).reason, 'retry_not_ready');
  now += 60_000;
  assert.equal(ledger.evaluateAttempt(route).allowed, true);
  assert.equal(ledger.evaluateAttempt(route).reason, 'retry_condition_met');
  const second = ledger.recordAttempt(failure);
  assert.equal(second.attempt_number, 2);
  assert.deepEqual(second.new_evidence_ids, []);
  assert.equal(second.next_attempt.allowed, false);
  assert.equal(ledger.evaluateAttempt(route).reason, 'no_progress_limit');
  const renamed = { ...route, route_id: 'new-id', hypothesis_id: 'renamed-hypothesis', hypothesis: 'Try phrasing it another way.', expected_evidence: ['same response described differently'] };
  assert.equal(ledger.evaluateAttempt(renamed).allowed, false);
  assert.throws(() => ledger.recordAttempt({ ...failure, route: renamed }), /no_progress_limit/);
  assert.equal(new RouteLedger(scope, { data: ledger.toJSON() }).evaluateAttempt(route).allowed, false);
  assert.equal(ledger.list().length, 2, 'A rejected third attempt cannot enter the durable ledger.');
});

test('same-class failure with genuinely new evidence requires a discriminating check or changed hypothesis', () => {
  const ledger = new RouteLedger(scope);
  const observation = (id: string, code: number) => ({ id, source: 'verification' as const, reference: `checks/${id}`, observed_at: at, task_version: 1, content_sha256: routeEvidenceDigest({ code }) });
  const failure = { route, outcome: 'transient_failure' as const, failure_class: 'rate_limit', evidence_ids: ['first'], evidence: [observation('first', 429)], retry_condition: { kind: 'not_before' as const, not_before: at, description: 'Provider reset time has elapsed.', evidence_ids: ['first'] } };
  ledger.recordAttempt(failure);
  ledger.recordAttempt({ ...failure, evidence_ids: ['second'], evidence: [observation('second', 503)], retry_condition: { ...failure.retry_condition, evidence_ids: ['second'] } });
  assert.equal(ledger.evaluateAttempt(route).reason, 'change_hypothesis');
  assert.equal(ledger.evaluateAttempt({ ...route, hypothesis_id: 'endpoint-scope', hypothesis: 'The endpoint scope is incorrect.' }).reason, 'new_hypothesis');
  const proof = observation('check', 200);
  const context = { evidence_ids: ['check'], evidence: [proof], discriminating_check: { description: 'A bounded endpoint check distinguished the failure.', evidence_ids: ['check'] } };
  assert.equal(ledger.evaluateAttempt(route, context).reason, 'discriminating_check');
  assert.equal(ledger.recordAttempt({ route, outcome: 'success', ...context }).outcome, 'success');
});

test('unproven availability and blind transient retries cannot be recorded as observed capability or progress', () => {
  const catalog = new RouteCatalog(scope);
  const unknown: RouteCatalogEntry = { ...capability('unknown'), authorization: { status: 'unknown', evidence_ids: [] }, network: { required: null, available: null, evidence_ids: [] }, authentication: { status: 'unknown', evidence_ids: [] }, rate_limit: { status: 'unknown', retry_at: null, evidence_ids: [] }, evidence: [], last_success: null };
  catalog.upsert(unknown);
  assert.throws(() => catalog.upsert({ ...unknown, status: 'observed' }), /Observed routes require/);
  const missingAuth = { ...capability('blocked'), authentication: { status: 'missing' as const, evidence_ids: ['probe-1'] }, rate_limit: { status: 'limited' as const, retry_at: at, evidence_ids: ['probe-1'] } };
  catalog.upsert(missingAuth);
  assert.equal(catalog.get('quotes-blocked')?.authentication.status, 'missing');
  assert.equal(catalog.get('quotes-blocked')?.rate_limit.status, 'limited');
  assert.throws(() => catalog.upsert({ ...capability('candidate'), authorization: { status: 'authorized', evidence_ids: ['invented'] } }), /Unknown evidence/);
  const ledger = new RouteLedger(scope);
  ledger.recordAttempt({ route, outcome: 'transient_failure', failure_class: 'network', evidence_ids: ['failure'] });
  assert.equal(ledger.evaluateAttempt(route).reason, 'retry_condition_required');
  assert.throws(() => ledger.recordAttempt({ route, outcome: 'transient_failure', failure_class: 'network', evidence_ids: ['new-uuid'] }), /retry_condition_required/);
  const unproven = new RouteLedger(scope);
  unproven.recordAttempt({ route, outcome: 'transient_failure', failure_class: 'rate_limit', evidence_ids: ['invented'], retry_condition: { kind: 'not_before', not_before: at, description: 'Unsupported model assertion of a reset.', evidence_ids: ['invented'] } });
  assert.equal(unproven.evaluateAttempt(route).allowed, false, 'A retry condition needs independently recorded observation provenance.');
});

test('task resume retains route history, reloads other writers, and fences older task versions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nf-resume-'));
  const catalogPath = join(directory, 'catalog.json'), ledgerPath = join(directory, 'ledger.json');
  const oldCatalog = new RouteCatalog(scope, { path: catalogPath });
  oldCatalog.upsert(capability('observed'));
  const anotherCatalog = new RouteCatalog(scope, { path: catalogPath });
  oldCatalog.upsert(capability('candidate'));
  anotherCatalog.upsert(capability('blocked'));
  assert.equal(oldCatalog.list().length, 3, 'A refreshed writer preserves changes from another instance.');
  const oldLedger = new RouteLedger(scope, { path: ledgerPath });
  oldLedger.recordAttempt({ route, outcome: 'transient_failure', failure_class: 'rate_limit', evidence_ids: ['first'], evidence: [observation('first', { retry_at: at })], retry_condition: { kind: 'not_before', not_before: at, description: 'Reset time was observed.', evidence_ids: ['first'] } });
  const resumedScope = { ...scope, task_version: 2 };
  const catalog = new RouteCatalog(resumedScope, { path: catalogPath });
  assert.equal(catalog.get('quotes-observed')?.evidence[0]?.task_version, 1);
  catalog.upsert(capability('unknown'));
  assert.throws(() => oldCatalog.upsert(capability('exhausted')), /Stale task version/);
  const ledger = new RouteLedger(resumedScope, { path: ledgerPath });
  const second = ledger.recordAttempt({ route, outcome: 'failure', failure_class: 'rate_limit', evidence_ids: ['first'] });
  assert.equal(second.attempt_number, 2);
  assert.equal(second.task_version, 2);
  assert.equal(ledger.list()[0]?.task_version, 1);
  assert.equal(ledger.evaluateAttempt(route).reason, 'no_progress_limit');
  assert.throws(() => oldLedger.recordAttempt({ route, outcome: 'failure', failure_class: 'rate_limit', evidence_ids: ['first'] }), /Stale task version/);
  assert.throws(() => new RouteCatalog({ ...scope, task_id: 'other-task' }, { path: catalogPath }), /another task/);
});
