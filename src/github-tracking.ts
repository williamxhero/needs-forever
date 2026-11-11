import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from './types.js';
import {
  contractIdentity,
  type ClarificationConclusions,
  type TrackingAcceptanceItem,
  type TrackingProgressStatus,
  type TrackingRecord,
  type TrackingUpdate,
} from './local-tracking.js';

export const GITHUB_TRACKING_START = '<!-- needs-forever:tracking:start -->';
export const GITHUB_TRACKING_END = '<!-- needs-forever:tracking:end -->';

export interface GitHubCommandResult { status: number | null; stdout: string; stderr: string }
export interface GitHubCliAdapter { run(args: readonly string[]): GitHubCommandResult }

/** The production seam. Tests should inject a controlled adapter instead. */
export class GhCliAdapter implements GitHubCliAdapter {
  constructor(readonly executable = 'gh') {}
  run(args: readonly string[]): GitHubCommandResult {
    const result = spawnSync(this.executable, [...args], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}

export interface GitHubTrackingStoreOptions {
  backend?: 'github-issue';
  repository: string;
  /** Omit issue to create a new one; supply it to reuse an existing issue. */
  issue?: number;
  title?: string;
  adapter?: GitHubCliAdapter;
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string.`);
  return value.trim();
}
function evidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('evidence_refs must contain only nonempty strings.');
  return value.map((item) => (item as string).trim());
}
function clarification(value: unknown): ClarificationConclusions {
  if (!value || typeof value !== 'object') throw new Error('Malformed clarification.');
  const item = value as Partial<ClarificationConclusions>;
  return {
    value: required(item.value, 'clarification.value'), priority: required(item.priority, 'clarification.priority'),
    evidence: required(item.evidence, 'clarification.evidence'), authorization: required(item.authorization, 'clarification.authorization'),
    stop_condition: required(item.stop_condition, 'clarification.stop_condition'), budget: required(item.budget, 'clarification.budget'),
  };
}
function normalizedTask(task: Task): Task {
  const ids = new Set<string>();
  const acceptance = task.acceptance.map((item) => {
    const id = required(item.id, 'acceptance id'); const text = required(item.text, 'acceptance text');
    if (ids.has(id)) throw new Error(`Duplicate acceptance id: ${id}`); ids.add(id); return { id, text };
  });
  return { ...structuredClone(task), task_id: required(task.task_id, 'task_id'), workspace: required(task.workspace, 'workspace'), goal: required(task.goal, 'goal'), acceptance, authorization: required(task.authorization, 'authorization'), limits: { ...task.limits } };
}
function locator(repository: string, issue: number): string { return `github:${repository}#${issue}`; }
function validateRecord(value: unknown, expectedLocator: string): TrackingRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tracking record must be a JSON object.');
  const record = value as Partial<TrackingRecord>;
  if (record.schema_version !== 1 || record.backend !== 'github-issue' || record.locator !== expectedLocator) throw new Error('GitHub tracking marker or locator mismatch.');
  if (typeof record.task_id !== 'string' || typeof record.contract_identity !== 'string' || !record.contract || !Array.isArray(record.acceptance)) throw new Error('Malformed GitHub tracking record.');
  const acceptance = record.acceptance.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('Malformed acceptance item.');
    const item = candidate as TrackingAcceptanceItem; const id = required(item.id, 'acceptance id'); const text = required(item.text, 'acceptance text');
    if (!['TODO', 'IN_PROGRESS', 'REPORTED_DONE', 'BLOCKED'].includes(item.status)) throw new Error(`Invalid acceptance status for ${id}.`);
    const notes = typeof item.notes === 'string' ? item.notes : ''; const refs = evidenceRefs(item.evidence_refs);
    if (item.status === 'REPORTED_DONE' && refs.length === 0) throw new Error(`Reported completion for ${id} requires evidence.`);
    if (item.status === 'BLOCKED' && !notes.trim()) throw new Error(`Blocked acceptance ${id} requires notes.`);
    return { id, text, status: item.status, notes, evidence_refs: refs };
  });
  const ids = new Set<string>(); for (const item of acceptance) { if (ids.has(item.id)) throw new Error(`Duplicate acceptance id: ${item.id}`); ids.add(item.id); }
  return { schema_version: 1, backend: 'github-issue', locator: expectedLocator, task_id: record.task_id, contract_identity: record.contract_identity, contract: normalizedTask(record.contract as Task), clarification: clarification(record.clarification), acceptance, updated_at: required(record.updated_at, 'updated_at') };
}
function compareContract(record: TrackingRecord, task: Task): void {
  const identity = contractIdentity(task); const expected = normalizedTask(task).acceptance;
  if (record.task_id !== task.task_id || record.contract_identity !== identity || contractIdentity(record.contract) !== identity) throw new Error('Tracking record contract mismatch.');
  const actual = new Map(record.acceptance.map((item) => [item.id, item.text]));
  if (expected.length !== actual.size || expected.some((item) => actual.get(item.id) !== item.text)) throw new Error('Tracking record acceptance identity mismatch.');
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
  return value;
}
function json(value: unknown): string { return JSON.stringify(sorted(value), null, 2); }
function block(record: TrackingRecord): string { return `${GITHUB_TRACKING_START}\n${json(record)}\n${GITHUB_TRACKING_END}`; }
function extract(body: string, expectedLocator: string): TrackingRecord {
  const pattern = new RegExp(`${GITHUB_TRACKING_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n([\\s\\S]*?)\\r?\\n${GITHUB_TRACKING_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('GitHub tracking canonical block is missing or duplicated.');
  let parsed: unknown; try { parsed = JSON.parse(matches[0]![1]!); } catch (error) { throw new Error(`Invalid GitHub tracking JSON: ${(error as Error).message}`, { cause: error }); }
  return validateRecord(parsed, expectedLocator);
}
function replaceBlock(body: string, record: TrackingRecord, expectedLocator: string): string {
  extract(body, expectedLocator);
  const pattern = new RegExp(`${GITHUB_TRACKING_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n[\\s\\S]*?\\r?\\n${GITHUB_TRACKING_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  return body.replace(pattern, block(record));
}
function command(adapter: GitHubCliAdapter, args: readonly string[]): string {
  const result = adapter.run(args); if (result.status !== 0) throw new Error(`GitHub command failed (${args.join(' ')}): ${result.stderr.trim() || `exit ${result.status}`}`); return result.stdout;
}
function parseJson(output: string, description: string): any { try { return JSON.parse(output); } catch (error) { throw new Error(`GitHub ${description} returned invalid JSON.`, { cause: error }); } }

export class GitHubTrackingStore {
  readonly backend = 'github-issue' as const;
  readonly repository: string;
  readonly issue: number | undefined;
  readonly title: string | undefined;
  readonly adapter: GitHubCliAdapter;
  constructor(options: GitHubTrackingStoreOptions) {
    if (options.backend !== 'github-issue') throw new Error('An explicit backend selection of github-issue is required.');
    this.repository = required(options.repository, 'repository');
    if (options.issue !== undefined && (!Number.isInteger(options.issue) || options.issue <= 0)) throw new Error('issue must be a positive integer.');
    this.issue = options.issue; this.title = options.title?.trim(); this.adapter = options.adapter ?? new GhCliAdapter();
    if (this.issue === undefined && !this.title) throw new Error('title is required when creating a GitHub Issue.');
  }
  private verifyRepository(): void {
    const viewed = parseJson(command(this.adapter, ['repo', 'view', this.repository, '--json', 'nameWithOwner']), 'repository response');
    if (viewed.nameWithOwner !== this.repository) throw new Error(`GitHub repository identity mismatch: expected ${this.repository}.`);
  }
  private view(issue: number): { number: number; title: string; body: string } {
    const viewed = parseJson(command(this.adapter, ['issue', 'view', String(issue), '--repo', this.repository, '--json', 'number,title,body']), 'Issue response');
    if (viewed.number !== issue || typeof viewed.body !== 'string') throw new Error('GitHub Issue identity mismatch.');
    return { number: viewed.number, title: String(viewed.title ?? ''), body: viewed.body };
  }
  create(task: Task, clarificationValue: ClarificationConclusions): TrackingRecord {
    if (this.issue !== undefined) throw new Error('This GitHub tracking store targets an existing Issue; use load or update.');
    const temporary = join(tmpdir(), `needs-forever-${randomUUID()}.md`);
    const base: TrackingRecord = { schema_version: 1, backend: 'github-issue', locator: 'github:pending#0', task_id: required(task.task_id, 'task_id'), contract_identity: contractIdentity(task), contract: normalizedTask(task), clarification: clarification(clarificationValue), acceptance: normalizedTask(task).acceptance.map(({ id, text }) => ({ id, text, status: 'TODO', notes: '', evidence_refs: [] })), updated_at: new Date().toISOString() };
    try {
      this.verifyRepository();
      // The issue number is unknown until creation; create with a temporary marked body,
      // then replace its pending locator after GitHub assigns the Issue number.
      writeFileSync(temporary, `${block(base)}\n`, { encoding: 'utf8' });
      const created = parseJson(command(this.adapter, ['issue', 'create', '--repo', this.repository, '--title', this.title!, '--body-file', temporary, '--json', 'number']), 'create response');
      const issue = Number(created.number); if (!Number.isInteger(issue) || issue <= 0) throw new Error('GitHub create response did not contain an Issue number.');
      const record = { ...base, locator: locator(this.repository, issue) };
      writeFileSync(temporary, `${block(record)}\n`, { encoding: 'utf8' });
      // Adapters may emulate create by reading the body file; real gh needs the file populated first.
      command(this.adapter, ['issue', 'edit', String(issue), '--repo', this.repository, '--body-file', temporary]);
      return this.readBack(issue, record);
    } catch (error) { throw new Error(`GitHub tracking record was not saved; no local fallback was attempted: ${(error as Error).message}`, { cause: error }); }
    finally { try { unlinkSync(temporary); } catch { /* best effort */ } }
  }
  private readBack(issue: number, expected: TrackingRecord): TrackingRecord {
    const viewed = this.view(issue); const saved = extract(viewed.body, expected.locator); compareContract(saved, expected.contract); if (JSON.stringify(sorted(saved)) !== JSON.stringify(sorted(expected))) throw new Error('GitHub tracking canonical block read-back mismatch.'); return saved;
  }
  load(task: Task): TrackingRecord {
    if (this.issue === undefined) throw new Error('An explicit existing Issue is required to load GitHub tracking.');
    this.verifyRepository(); const viewed = this.view(this.issue); const saved = extract(viewed.body, locator(this.repository, this.issue)); compareContract(saved, task); return saved;
  }
  update(task: Task, update: TrackingUpdate): TrackingRecord {
    if (this.issue === undefined) throw new Error('An explicit existing Issue is required to update GitHub tracking.');
    const current = this.load(task); const id = required(update.acceptance_id, 'acceptance_id'); const item = current.acceptance.find((candidate) => candidate.id === id); if (!item) throw new Error(`Unknown acceptance id: ${id}`);
    if (!['TODO', 'IN_PROGRESS', 'REPORTED_DONE', 'BLOCKED'].includes(update.status)) throw new Error(`Invalid acceptance status for ${id}.`);
    const notes = typeof update.notes === 'string' ? update.notes.trim() : ''; const refs = evidenceRefs(update.evidence_refs);
    if (update.status === 'REPORTED_DONE' && refs.length === 0) throw new Error(`Reported completion for ${id} requires evidence.`); if (update.status === 'BLOCKED' && !notes) throw new Error(`Blocked acceptance ${id} requires notes.`);
    item.status = update.status as TrackingProgressStatus; item.notes = notes; item.evidence_refs = refs; current.updated_at = new Date().toISOString();
    const viewed = this.view(this.issue); const body = replaceBlock(viewed.body, current, current.locator); const temporary = join(tmpdir(), `needs-forever-${randomUUID()}.md`);
    try { writeFileSync(temporary, body.replace(/^\uFEFF/, ''), { encoding: 'utf8' }); command(this.adapter, ['issue', 'edit', String(this.issue), '--repo', this.repository, '--body-file', temporary]); return this.readBack(this.issue, current); } catch (error) { throw new Error(`GitHub tracking update was not saved; no local fallback was attempted: ${(error as Error).message}`, { cause: error }); } finally { try { unlinkSync(temporary); } catch { /* best effort */ } }
  }
}
