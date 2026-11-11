import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalTrackingStore, contractIdentity, type ClarificationConclusions } from '../src/index.js';
import type { Task } from '../src/types.js';

const clarification: ClarificationConclusions = {
  value: 'Reliable daily report',
  priority: 'Reliability before speed',
  evidence: 'A passing verification command and captured output',
  authorization: 'Read and write the task workspace only',
  stop_condition: 'Stop after the acceptance checks pass',
  budget: 'Two worker turns or ten minutes',
};

function task(): Task {
  return {
    schema_version: 1,
    task_id: 'tracking-task',
    workspace: resolve('.'),
    goal: 'Produce the daily report',
    acceptance: [
      { id: 'A1', text: 'The report contains all required rows.' },
      { id: 'A2', text: 'The fixed verification command passes.' },
    ],
    authorization: 'Read and write the task workspace only.',
    limits: { max_worker_turns: 2, max_minutes: 10 },
  };
}

function storePath(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'nf-tracking-'));
  return { root, path: join(root, 'tracking.json') };
}

function cleanup(root: string): void { rmSync(root, { recursive: true, force: true }); }

test('local tracking requires an explicit backend and creates a durable record with stable contract and acceptance identities', () => {
  const { root, path } = storePath();
  try {
    assert.throws(() => new LocalTrackingStore({ path }), /backend.*local-json|explicit backend/i);
    assert.throws(() => new LocalTrackingStore({ backend: 'local-json', path: 'tracking.json' }), /absolute path/i);
    const store = new LocalTrackingStore({ backend: 'local-json', path });
    const record = store.create(task(), clarification);
    assert.equal(record.backend, 'local-json');
    assert.equal(record.locator, resolve(path));
    assert.equal(record.contract_identity, contractIdentity(task()));
    assert.deepEqual(record.acceptance.map((item) => item.id), ['A1', 'A2']);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), record);
  } finally { cleanup(root); }
});

test('updates preserve the running contract, require known acceptance IDs, and read back after restart', () => {
  const { root, path } = storePath();
  try {
    const original = task();
    const store = new LocalTrackingStore({ backend: 'local-json', path });
    const created = store.create(original, clarification);
    const updated = store.update(original, {
      acceptance_id: 'A1',
      status: 'REPORTED_DONE',
      notes: 'The required rows are present.',
      evidence_refs: ['event:report-check', 'artifact:report.csv'],
    });
    assert.equal(updated.acceptance.find((item) => item.id === 'A1')?.status, 'REPORTED_DONE');
    assert.deepEqual(updated.acceptance.find((item) => item.id === 'A1')?.evidence_refs, ['event:report-check', 'artifact:report.csv']);
    assert.deepEqual(updated.contract, created.contract);
    assert.throws(() => store.update(original, { acceptance_id: 'unknown', status: 'TODO', notes: '', evidence_refs: [] }), /unknown acceptance/i);
    const changed = { ...original, goal: 'A different goal' };
    assert.throws(() => store.load(changed), /contract.*mismatch/i);
    const restarted = new LocalTrackingStore({ backend: 'local-json', path });
    assert.deepEqual(restarted.load(original), updated);
  } finally { cleanup(root); }
});

test('reported completion needs evidence and blocked progress needs an explanation', () => {
  const { root, path } = storePath();
  try {
    const original = task();
    const store = new LocalTrackingStore({ backend: 'local-json', path });
    store.create(original, clarification);
    assert.throws(() => store.update(original, { acceptance_id: 'A1', status: 'REPORTED_DONE', notes: '', evidence_refs: [] }), /evidence/i);
    assert.throws(() => store.update(original, { acceptance_id: 'A1', status: 'BLOCKED', notes: '', evidence_refs: [] }), /blocked.*notes|explanation/i);
  } finally { cleanup(root); }
});

test('failed local writes are surfaced and cannot be mistaken for a saved record', () => {
  const { root } = storePath();
  try {
    const path = join(root, 'as-directory');
    mkdirSync(path);
    const store = new LocalTrackingStore({ backend: 'local-json', path });
    assert.throws(() => store.create(task(), clarification), /EISDIR|directory|rename|write/i);
  } finally { cleanup(root); }
});
