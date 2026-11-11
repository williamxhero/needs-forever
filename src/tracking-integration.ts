import { resolve } from 'node:path';
import type { Task } from './types.js';
import { LocalTrackingStore, contractIdentity, type ClarificationConclusions, type TrackingBackend, type TrackingRecord, type TrackingUpdate } from './local-tracking.js';
import { GitHubTrackingStore } from './github-tracking.js';

export interface TrackingSelection {
  backend: TrackingBackend;
  path?: string;
  repository?: string;
  issue?: number;
  title?: string;
  clarification?: ClarificationConclusions;
}

export interface TrackingLocator {
  backend: TrackingBackend;
  locator: string;
  contract_identity: string;
}

export function trackingLocator(record: TrackingRecord): TrackingLocator {
  return { backend: record.backend, locator: record.locator, contract_identity: record.contract_identity };
}

function githubLocator(locator: string): { repository: string; issue: number } {
  const match = /^github:(.+)#([1-9][0-9]*)$/.exec(locator);
  if (!match) throw new Error(`Invalid GitHub tracking locator: ${locator}`);
  return { repository: match[1]!, issue: Number(match[2]) };
}

export function locatorForSelection(selection: TrackingSelection): Pick<TrackingLocator, 'backend' | 'locator'> {
  if (selection.backend === 'local-json') {
    if (!selection.path || !selection.path.trim()) throw new Error('local-json tracking requires an explicit path.');
    return { backend: 'local-json', locator: resolve(selection.path) };
  }
  if (!selection.repository || !selection.repository.trim() || selection.issue === undefined) throw new Error('github-issue resume requires an explicit repository and issue.');
  if (!Number.isInteger(selection.issue) || selection.issue <= 0) throw new Error('issue must be a positive integer.');
  return { backend: 'github-issue', locator: `github:${selection.repository.trim()}#${selection.issue}` };
}

export function storeForLocator(selection: Pick<TrackingLocator, 'backend' | 'locator'>) {
  if (selection.backend === 'local-json') return new LocalTrackingStore({ backend: 'local-json', path: selection.locator });
  const parsed = githubLocator(selection.locator);
  return new GitHubTrackingStore({ backend: 'github-issue', repository: parsed.repository, issue: parsed.issue });
}

function validateSelection(selection: TrackingSelection, forCreate: boolean): void {
  if (selection.backend === 'local-json') {
    if (!selection.path || !selection.path.trim()) throw new Error('local-json tracking requires an explicit path.');
    if (selection.repository || selection.issue !== undefined || selection.title) throw new Error('local-json tracking cannot include GitHub options.');
  } else {
    if (!selection.repository || !selection.repository.trim()) throw new Error('github-issue tracking requires an explicit repository.');
    if (selection.path) throw new Error('github-issue tracking cannot include a local path.');
    if (forCreate && selection.issue === undefined && !selection.title) throw new Error('github-issue tracking creation requires an explicit title.');
  }
  if (forCreate && !selection.clarification) throw new Error('Tracking creation requires explicit clarification conclusions.');
}

export function createTracking(task: Task, selection: TrackingSelection): TrackingRecord {
  validateSelection(selection, true);
  if (selection.backend === 'local-json') return new LocalTrackingStore({ backend: 'local-json', path: selection.path! }).create(task, selection.clarification!);
  return new GitHubTrackingStore({ backend: 'github-issue', repository: selection.repository!, ...(selection.issue !== undefined ? { issue: selection.issue } : {}), ...(selection.title ? { title: selection.title } : {}) }).create(task, selection.clarification!);
}

export function loadTracking(task: Task, locator: Pick<TrackingLocator, 'backend' | 'locator'>): TrackingRecord {
  return storeForLocator(locator).load(task);
}

export function updateTracking(task: Task, locator: Pick<TrackingLocator, 'backend' | 'locator'>, update: TrackingUpdate): TrackingRecord {
  return storeForLocator(locator).update(task, update);
}

export function assertTrackingContract(record: TrackingRecord, task: Task, expected?: TrackingLocator): void {
  if (expected && (record.backend !== expected.backend || record.locator !== expected.locator)) throw new Error('Tracking record locator mismatch.');
  if (expected && record.contract_identity !== expected.contract_identity) throw new Error('Tracking record checkpoint contract mismatch.');
  if (record.task_id !== task.task_id || record.contract_identity !== contractIdentity(task)) throw new Error('Tracking record contract mismatch.');
}
