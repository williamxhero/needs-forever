import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_TRACKING_END,
  GITHUB_TRACKING_START,
  GitHubTrackingStore,
  type GitHubCliAdapter,
  type GitHubCommandResult,
  type ClarificationConclusions,
} from '../src/index.js';
import type { Task } from '../src/types.js';

const clarification: ClarificationConclusions = { value: 'Reliable report', priority: 'Reliability', evidence: 'Passing checks', authorization: 'Workspace only', stop_condition: 'Checks pass', budget: 'Two turns' };
function task(): Task { return { schema_version: 1, task_id: 'github-task', workspace: resolve('.'), goal: 'Produce report', acceptance: [{ id: 'A1', text: 'Report is complete.' }, { id: 'A2', text: 'Checks pass.' }], authorization: 'Workspace only', limits: { max_worker_turns: 2, max_minutes: 10 } }; }
function result(stdout: string): GitHubCommandResult { return { status: 0, stdout, stderr: '' }; }
class FakeGh implements GitHubCliAdapter {
  body = ''; issue = 42; calls: string[][] = []; directory = mkdtempSync(join(tmpdir(), 'nf-gh-'));
  run(args: readonly string[]): GitHubCommandResult {
    this.calls.push([...args]);
    if (args[0] === 'repo') return result(JSON.stringify({ nameWithOwner: 'acme/reports' }));
    if (args[0] === 'issue' && args[1] === 'view') return result(JSON.stringify({ number: this.issue, title: 'Tracking', body: this.body }));
    if (args[0] === 'issue' && args[1] === 'create') { assert.equal(args.includes('--json'), false); this.body = readFileSync(String(args[args.indexOf('--body-file') + 1]), 'utf8'); return result(`https://github.com/acme/reports/issues/${this.issue}\n`); }
    if (args[0] === 'issue' && args[1] === 'edit') { this.body = readFileSync(String(args[args.indexOf('--body-file') + 1]), 'utf8'); return result(''); }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  }
  close(): void { rmSync(this.directory, { recursive: true, force: true }); }
}

test('creates a marked GitHub record and reads the canonical block back', () => {
  const gh = new FakeGh();
  try {
    const record = new GitHubTrackingStore({ backend: 'github-issue', repository: 'acme/reports', title: 'NF tracking', adapter: gh }).create(task(), clarification);
    assert.equal(record.locator, 'github:acme/reports#42');
    assert.match(gh.body, new RegExp(GITHUB_TRACKING_START)); assert.match(gh.body, new RegExp(GITHUB_TRACKING_END));
    assert.match(gh.body, /"task_id": "github-task"/);
  } finally { gh.close(); }
});

test('updates only the NF block and preserves unrelated Issue content', () => {
  const gh = new FakeGh(); gh.body = 'Customer notes\n\n';
  try {
    const creator = new GitHubTrackingStore({ backend: 'github-issue', repository: 'acme/reports', title: 'NF tracking', adapter: gh });
    creator.create(task(), clarification);
    gh.body = `Customer notes\n\n${gh.body}`;
    const store = new GitHubTrackingStore({ backend: 'github-issue', repository: 'acme/reports', issue: 42, adapter: gh });
    const updated = store.update(task(), { acceptance_id: 'A1', status: 'REPORTED_DONE', notes: 'Verified', evidence_refs: ['test:1'] });
    assert.equal(updated.acceptance[0]!.status, 'REPORTED_DONE'); assert.match(gh.body, /^Customer notes/); assert.match(gh.body, /test:1/);
  } finally { gh.close(); }
});

test('rejects task or contract mismatch and never falls back locally', () => {
  const gh = new FakeGh();
  try {
    new GitHubTrackingStore({ backend: 'github-issue', repository: 'acme/reports', title: 'NF tracking', adapter: gh }).create(task(), clarification);
    const changed = { ...task(), goal: 'Different' };
    assert.throws(() => new GitHubTrackingStore({ backend: 'github-issue', repository: 'acme/reports', issue: 42, adapter: gh }).load(changed), /contract.*mismatch/i);
    gh.run = () => ({ status: 1, stdout: '', stderr: 'permission denied' });
    assert.throws(() => new GitHubTrackingStore({ backend: 'github-issue', repository: 'acme/reports', title: 'NF tracking', adapter: gh }).create(task(), clarification), /not saved.*fallback/i);
  } finally { gh.close(); }
});

test('requires explicit GitHub backend and repository/Issue selection', () => {
  const gh = new FakeGh();
  try {
    assert.throws(() => new GitHubTrackingStore({ repository: 'acme/reports', title: 'x', adapter: gh } as never), /explicit backend/i);
    assert.throws(() => new GitHubTrackingStore({ backend: 'github-issue', repository: 'acme/reports', adapter: gh } as never), /title is required/i);
    assert.throws(() => new GitHubTrackingStore({ backend: 'github-issue', repository: 'acme/reports', issue: 0, adapter: gh }), /positive integer/i);
  } finally { gh.close(); }
});
