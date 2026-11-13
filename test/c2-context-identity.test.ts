import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RouteCatalog,
  RouteLedger,
  buildC2Context,
  routeEvidenceDigest,
  routeFamilyFingerprint,
  type RouteCatalogEntry,
  type RouteCatalogData,
  type RouteEvidence,
  type RouteIdentity,
  type RouteLedgerData,
  type Snapshot,
  type State,
  type Task,
} from '../src/index.js';

const task: Task = {
  schema_version: 1,
  task_id: 'ticket-78',
  workspace: process.cwd(),
  goal: 'Retain current C2 evidence.',
  acceptance: [{ id: 'A1', text: 'The current proof remains traceable.' }],
  authorization: 'Workspace only.',
  limits: { max_worker_turns: null, max_minutes: null },
};
const scope = { task_id: task.task_id, task_version: 1 };
const at = '2026-11-13T00:00:00.000Z';

function observation(id: string, value: unknown, summary = `source summary for ${id}`): RouteEvidence {
  return { id, source: 'probe', reference: `source:${id}`, observed_at: at, task_version: 1, content_sha256: routeEvidenceDigest(value), summary };
}

function entry(routeId: string): RouteCatalogEntry {
  const proof = observation(`proof:${routeId}`, { routeId, authorized: true });
  return {
    route_id: routeId,
    resource: { kind: 'artifact', id: `${routeId}.json` },
    operation: 'read-local-artifact',
    status: 'observed',
    authorization: { status: 'authorized', evidence_ids: [proof.id] },
    network: { required: false, available: null, evidence_ids: [proof.id] },
    authentication: { status: 'not_required', evidence_ids: [proof.id] },
    rate_limit: { status: 'clear', retry_at: null, evidence_ids: [proof.id] },
    last_success: null,
    capabilities: ['read'],
    evidence: [proof],
  };
}

function baseSnapshot(): Snapshot {
  return {
    snapshot_id: 'snapshot', task_id: task.task_id, task_version: 1,
    worker_thread_id: 'worker', worker_turn_id: 'stop', task: structuredClone(task),
    evidence: [{ id: 'current-proof', type: 'commandExecution', value: { output: 'current proof' }, complete: true, source: { event_id: 'stop-proof', observed_at: at } }],
    evidence_complete: true, omissions: [],
  };
}

function state(catalog: RouteCatalogData, ledger: RouteLedgerData): State {
  return {
    schema_version: 1, ...scope, task: structuredClone(task), worker_thread_id: 'worker',
    status: 'ACTIVE', phase: 'JUDGE', active_worker_turn_id: null, reviewing_turn_id: 'stop',
    handled_turn_ids: [], pending_action: null, retry: { kind: null, attempt: 0, next_at: null },
    last_decision: {
      action: 'CONTINUE', reason: 'retain current route', evidence_ids: ['current-proof'],
      next_message: 'inspect current route', external: null,
      route_plan: {
        plan_id: 'plan-78', selected_route_id: 'keep-route', selection_reason: 'current proof', single_route_reason: 'single route',
        success_condition: 'proof', stop_condition: 'stop',
        candidates: [{
          route_id: 'keep-route', resource: { kind: 'artifact', id: 'keep-route.json' }, operation: 'read-local-artifact',
          hypothesis_id: 'keep', hypothesis: 'keep', expected_evidence: ['proof'], status: 'observed', evidence_ids: ['proof:keep-route'],
          actions: ['inspect current route'], expected_signal: 'proof', risk: 'none', fallback: { route_id: null, when: 'stop' }, discriminating_check: null,
        }],
      },
    },
    worker_turn_count: 1, elapsed_active_seconds: 0, updated_at: at, codex_version: null, mode: 'live',
    route_catalog: catalog, route_ledger: ledger,
  };
}

test('budget keeps route evidence referenced by the current C plan and records omitted history summaries', () => {
  const catalog = new RouteCatalog(scope);
  for (let index = 0; index < 30; index++) {
    const item = entry(index === 0 ? 'keep-route' : `history-${index}`);
    item.capabilities = ['large '.repeat(240)];
    catalog.upsert(item);
  }
  const ledger = new RouteLedger(scope);
  const route: RouteIdentity = {
    route_id: 'keep-route', resource: { kind: 'artifact', id: 'keep-route.json' }, operation: 'read-local-artifact',
    hypothesis_id: 'keep', hypothesis: 'keep', expected_evidence: ['proof'],
  };
  ledger.recordAttempt({ route, outcome: 'diagnostic', evidence_ids: ['proof:keep-route'], evidence: [catalog.get('keep-route')!.evidence[0]!] });
  const input = buildC2Context(baseSnapshot(), state(catalog.toJSON(), ledger.toJSON()));
  assert.ok(input.c2!.catalog.entries.some((item) => item.route_id === 'keep-route'));
  assert.ok(input.c2!.ledger.attempts.some((item) => item.route.route_id === 'keep-route'));
  assert.ok(input.c2!.catalog.entries.length < 30 || input.c2!.ledger.attempts.length < 30);
  assert.ok(input.c2!.omissions.catalog.length + input.c2!.omissions.ledger.length > 0);
  assert.match(JSON.stringify(input.c2!.omissions), /history|omitted/i);
});

test('diagnostic identity distinguishes target resource sets and classes while ignoring route labels', () => {
  const artifact: RouteIdentity = {
    route_id: 'artifact-check', resource: { kind: 'diagnostic', id: 'artifact-check' }, operation: 'verify-artifact',
    hypothesis_id: 'same-hypothesis', hypothesis: 'Check the selected artifact.', expected_evidence: ['artifact digest'],
    diagnostic_class: 'artifact_validation', target_resource_ids: ['cache/prices.csv'],
  };
  const receipt: RouteIdentity = {
    ...artifact, route_id: 'renamed-receipt-check', operation: 'verify-receipt',
    diagnostic_class: 'final_safe_receipt_validation', target_resource_ids: ['stop-proof:final'],
  };
  assert.notEqual(routeFamilyFingerprint(artifact), routeFamilyFingerprint(receipt));
  assert.equal(routeFamilyFingerprint(artifact), routeFamilyFingerprint({ ...artifact, route_id: 'renamed-artifact-check' }));
});

test('route catalog persistence retains source summary and substantive digest', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nf-ticket78-')), 'catalog.json');
  const catalog = new RouteCatalog(scope, { path });
  const original = entry('persisted');
  catalog.upsert(original);
  const restored = new RouteCatalog(scope, { path }).get('persisted')!;
  assert.equal(restored.evidence[0]!.summary, original.evidence[0]!.summary);
  assert.equal(restored.evidence[0]!.content_sha256, original.evidence[0]!.content_sha256);
});
