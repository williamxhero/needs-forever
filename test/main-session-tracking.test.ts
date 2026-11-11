import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `nf-main-tracking-${name}-`));
  const workspace = join(root, 'workspace');
  const task = join(root, 'task.json');
  const state = join(workspace, '.codex-supervisor', name, 'state.json');
  const tracking = join(root, 'tracking.json');
  const clarification = join(root, 'clarification.json');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, goal: 'Complete the tracked task.', acceptance: [{ id: 'A1', text: 'The result is checked.' }], authorization: 'Workspace only.', limits: { max_worker_turns: null, max_minutes: null } }));
  writeFileSync(clarification, JSON.stringify({ value: 'Tracked result', priority: 'Reliability', evidence: 'Recorded checks', authorization: 'Workspace only', stop_condition: 'Acceptance evidence exists', budget: 'One supervised run' }));
  const script = resolve('plugins/needs-forever/scripts/main-session.mjs');
  const run = (command: string, args: string[] = []) => spawnSync(process.execPath, [script, command, '--state', state, ...args], { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
  return { root, workspace, task, state, tracking, clarification, run };
}

test('main-session tracking creation persists the explicit locator and supports observable load/update', () => {
  const f = fixture('local');
  const prepared = f.run('prepare', ['--task', f.task, '--tracking-backend', 'local-json', '--tracking-path', f.tracking, '--tracking-clarification', f.clarification]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const state = JSON.parse(readFileSync(f.state, 'utf8'));
  assert.deepEqual(state.tracking, { backend: 'local-json', locator: f.tracking, contract_identity: state.tracking.contract_identity });
  const loaded = f.run('tracking-load');
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(JSON.parse(loaded.stdout).acceptance[0].status, 'TODO');
  const updated = f.run('tracking-update', ['--acceptance-id', 'A1', '--tracking-status', 'REPORTED_DONE', '--tracking-evidence', 'event:checked']);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).acceptance[0].status, 'REPORTED_DONE');
  assert.equal(JSON.parse(readFileSync(f.state, 'utf8')).status, 'PAUSED', 'tracking progress does not become NF DONE');
});

test('resume reads the persisted tracking locator and rejects an explicit locator mismatch', () => {
  const f = fixture('resume');
  assert.equal(f.run('prepare', ['--task', f.task, '--tracking-backend', 'local-json', '--tracking-path', f.tracking, '--tracking-clarification', f.clarification]).status, 0);
  const resumed = f.run('resume');
  assert.equal(resumed.status, 0, resumed.stderr);
  const mismatch = f.run('resume', ['--tracking-backend', 'local-json', '--tracking-path', join(f.root, 'other.json')]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /tracking selection|locator|record/i);
});

test('tracking selection is explicit and does not silently choose a backend', () => {
  const f = fixture('explicit');
  const result = f.run('prepare', ['--task', f.task, '--tracking-path', f.tracking, '--tracking-clarification', f.clarification]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit.*backend/i);
  assert.equal(existsSync(f.state), false);
});

test('active resume rejects acceptance changes before tracking can drift', () => {
  const f = fixture('active-contract');
  assert.equal(f.run('prepare', ['--task', f.task, '--tracking-backend', 'local-json', '--tracking-path', f.tracking, '--tracking-clarification', f.clarification]).status, 0);
  const changed = join(f.root, 'changed-task.json');
  const task = JSON.parse(readFileSync(f.task, 'utf8')); task.acceptance = [{ id: 'A1', text: 'A changed acceptance.' }]; writeFileSync(changed, JSON.stringify(task));
  const state = JSON.parse(readFileSync(f.state, 'utf8')); state.status = 'ACTIVE'; writeFileSync(f.state, JSON.stringify(state));
  const result = f.run('resume', ['--task', changed]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /acceptance.*PAUSED/i);
});
