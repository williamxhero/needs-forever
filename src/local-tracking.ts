import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Task } from './types.js';

export type TrackingBackend = 'local-json' | 'github-issue';
export type TrackingProgressStatus = 'TODO' | 'IN_PROGRESS' | 'REPORTED_DONE' | 'BLOCKED';

export interface ClarificationConclusions {
  value: string;
  priority: string;
  evidence: string;
  authorization: string;
  stop_condition: string;
  budget: string;
}

export interface TrackingAcceptanceItem {
  id: string;
  text: string;
  status: TrackingProgressStatus;
  notes: string;
  evidence_refs: string[];
}

export interface TrackingRecord {
  schema_version: 1;
  backend: TrackingBackend;
  locator: string;
  task_id: string;
  contract_identity: string;
  contract: Task;
  clarification: ClarificationConclusions;
  acceptance: TrackingAcceptanceItem[];
  updated_at: string;
}

export interface TrackingUpdate {
  acceptance_id: string;
  status: TrackingProgressStatus;
  notes: string;
  evidence_refs: string[];
}

export interface LocalTrackingStoreOptions {
  backend?: TrackingBackend;
  path: string;
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string.`);
  return value.trim();
}

function normalizedTask(task: Task): Task {
  const acceptance = task.acceptance.map((item) => ({ id: nonempty(item.id, 'acceptance id'), text: nonempty(item.text, 'acceptance text') }));
  const ids = new Set<string>();
  for (const item of acceptance) {
    if (ids.has(item.id)) throw new Error(`Duplicate acceptance id: ${item.id}`);
    ids.add(item.id);
  }
  return {
    ...structuredClone(task),
    task_id: nonempty(task.task_id, 'task_id'),
    workspace: resolve(nonempty(task.workspace, 'workspace')),
    goal: nonempty(task.goal, 'goal'),
    acceptance,
    authorization: nonempty(task.authorization, 'authorization'),
    limits: { max_worker_turns: task.limits.max_worker_turns, max_minutes: task.limits.max_minutes },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A stable digest of the execution contract. Tracking metadata is excluded. */
export function contractIdentity(task: Task): string {
  const normalized = normalizedTask(task);
  if (process.platform === 'win32') normalized.workspace = normalized.workspace.toLowerCase();
  normalized.acceptance = [...normalized.acceptance].sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(canonical(normalized)).digest('hex');
}

function clarificationValue(value: ClarificationConclusions): ClarificationConclusions {
  return {
    value: nonempty(value.value, 'clarification.value'),
    priority: nonempty(value.priority, 'clarification.priority'),
    evidence: nonempty(value.evidence, 'clarification.evidence'),
    authorization: nonempty(value.authorization, 'clarification.authorization'),
    stop_condition: nonempty(value.stop_condition, 'clarification.stop_condition'),
    budget: nonempty(value.budget, 'clarification.budget'),
  };
}

function evidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('evidence_refs must contain only nonempty strings.');
  return value.map((item) => (item as string).trim());
}

function validateRecord(value: unknown, locator: string): TrackingRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tracking record must be a JSON object.');
  const record = value as Partial<TrackingRecord>;
  if (record.schema_version !== 1 || record.backend !== 'local-json') throw new Error('Unsupported local tracking record.');
  if (record.locator !== locator) throw new Error('Tracking record locator mismatch.');
  if (typeof record.task_id !== 'string' || typeof record.contract_identity !== 'string' || !record.contract || !record.clarification || !Array.isArray(record.acceptance)) throw new Error('Malformed local tracking record.');
  const acceptance = record.acceptance.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Malformed acceptance item.');
    const candidate = item as TrackingAcceptanceItem;
    const id = nonempty(candidate.id, 'acceptance id');
    const text = nonempty(candidate.text, 'acceptance text');
    if (!['TODO', 'IN_PROGRESS', 'REPORTED_DONE', 'BLOCKED'].includes(candidate.status)) throw new Error(`Invalid acceptance status for ${id}.`);
    const notes = typeof candidate.notes === 'string' ? candidate.notes : '';
    const refs = evidenceRefs(candidate.evidence_refs);
    if (candidate.status === 'REPORTED_DONE' && refs.length === 0) throw new Error(`Reported completion for ${id} requires evidence.`);
    if (candidate.status === 'BLOCKED' && !notes.trim()) throw new Error(`Blocked acceptance ${id} requires notes.`);
    return { id, text, status: candidate.status, notes, evidence_refs: refs };
  });
  const ids = new Set<string>();
  for (const item of acceptance) {
    if (ids.has(item.id)) throw new Error(`Duplicate acceptance id: ${item.id}`);
    ids.add(item.id);
  }
  return {
    schema_version: 1,
    backend: 'local-json',
    locator,
    task_id: record.task_id,
    contract_identity: record.contract_identity,
    contract: normalizedTask(record.contract as Task),
    clarification: clarificationValue(record.clarification),
    acceptance,
    updated_at: nonempty(record.updated_at, 'updated_at'),
  };
}

function compareContract(record: TrackingRecord, task: Task): void {
  const identity = contractIdentity(task);
  if (record.task_id !== task.task_id || record.contract_identity !== identity) throw new Error('Tracking record contract mismatch.');
  if (contractIdentity(record.contract) !== identity) throw new Error('Tracking record contract mismatch.');
  const expected = normalizedTask(task).acceptance;
  const actual = new Map(record.acceptance.map((item) => [item.id, item.text]));
  if (expected.length !== actual.size || expected.some((item) => actual.get(item.id) !== item.text)) throw new Error('Tracking record acceptance identity mismatch.');
}

export class LocalTrackingStore {
  readonly backend: TrackingBackend;
  readonly path: string;

  constructor(options: LocalTrackingStoreOptions) {
    if (options.backend !== 'local-json') throw new Error('An explicit backend selection of local-json is required.');
    if (!options.path.trim() || !isAbsolute(options.path)) throw new Error('Tracking path must be a nonempty absolute path.');
    this.backend = options.backend;
    this.path = resolve(options.path);
  }

  create(task: Task, clarification: ClarificationConclusions): TrackingRecord {
    if (existsSync(this.path)) throw new Error(`Tracking record already exists: ${this.path}`);
    const contract = normalizedTask(task);
    const record: TrackingRecord = {
      schema_version: 1,
      backend: this.backend,
      locator: this.path,
      task_id: contract.task_id,
      contract_identity: contractIdentity(contract),
      contract,
      clarification: clarificationValue(clarification),
      acceptance: contract.acceptance.map(({ id, text }) => ({ id, text, status: 'TODO', notes: '', evidence_refs: [] })),
      updated_at: new Date().toISOString(),
    };
    return this.writeReadBack(record);
  }

  load(task: Task): TrackingRecord {
    const record = validateRecord(JSON.parse(readFileSync(this.path, 'utf8')), this.path);
    compareContract(record, task);
    return record;
  }

  update(task: Task, update: TrackingUpdate): TrackingRecord {
    const current = this.load(task);
    const id = nonempty(update.acceptance_id, 'acceptance_id');
    const item = current.acceptance.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Unknown acceptance id: ${id}`);
    if (!['TODO', 'IN_PROGRESS', 'REPORTED_DONE', 'BLOCKED'].includes(update.status)) throw new Error(`Invalid acceptance status for ${id}.`);
    const notes = typeof update.notes === 'string' ? update.notes.trim() : '';
    const refs = evidenceRefs(update.evidence_refs);
    if (update.status === 'REPORTED_DONE' && refs.length === 0) throw new Error(`Reported completion for ${id} requires evidence.`);
    if (update.status === 'BLOCKED' && !notes) throw new Error(`Blocked acceptance ${id} requires notes.`);
    item.status = update.status;
    item.notes = notes;
    item.evidence_refs = refs;
    current.updated_at = new Date().toISOString();
    return this.writeReadBack(current);
  }

  private writeReadBack(record: TrackingRecord): TrackingRecord {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      renameSync(temporary, this.path);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* preserve the original write failure */ }
      throw new Error(`Unable to save local tracking record at ${this.path}: ${(error as Error).message}`, { cause: error });
    }
    const saved = validateRecord(JSON.parse(readFileSync(this.path, 'utf8')), this.path);
    if (JSON.stringify(saved) !== JSON.stringify(record)) throw new Error('Local tracking record read-back mismatch.');
    return saved;
  }
}
