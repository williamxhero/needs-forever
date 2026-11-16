import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { State } from '../types.js';
import type { TaskCatalogOptions, TaskRecord, TaskSummary } from './types.js';
import { piNfRecord, piNfSummary, piNfTaskDirectories, readPiNfAudit } from './pi-nf.js';
import {
  SessionIdAllocator,
  displayMetadata,
  displayTitle,
  isCompleteLiveSupervisionRound,
  isCompleteSupervisionRound,
  makeRounds,
  safeEvents,
  snapshotIds,
  stateView,
  stringValue,
  taskDirectory,
} from './projection.js';

export type TaskSource = 'codex' | 'pi-nf';

export type LocatedTask = {
  root: string;
  directory: string;
  workspace: string;
  source: TaskSource;
};

export class TaskCatalog {
  readonly root: string;
  readonly roots: string[];
  readonly workspaces: string[];
  private readonly sessionIds = new SessionIdAllocator();
  constructor(options: TaskCatalogOptions) {
    this.workspaces = [...new Set([options.workspace, ...(options.workspaces ?? [])].map((workspace) => resolve(workspace)))];
    this.roots = this.workspaces.map((workspace) => resolve(workspace, '.codex-supervisor'));
    this.root = this.roots[0]!;
  }

  list(): TaskSummary[] {
    const entries: TaskSummary[] = [];
    const seen = new Set<string>();
    for (const root of this.roots) {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        // Windows explicit task views may be exposed through a junction. Keep
        // discovery read-only while allowing the linked state directory to be
        // rendered alongside ordinary .codex-supervisor task directories.
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        try {
          const record = this.readFromRoot(root, entry.name);
          const result = record.state.lastDecision?.action ?? record.state.status;
          seen.add(record.taskId);
          entries.push({ title: record.title, sessionId: record.sessionId, taskId: record.taskId, status: record.state.status, phase: record.state.phase, updatedAt: record.updatedAt, lastResult: result });
        } catch {
          // A task is only discoverable once its atomically written state is readable.
        }
      }
    }
    for (const workspace of this.workspaces) {
      for (const task of piNfTaskDirectories(workspace)) {
        if (seen.has(task.taskId)) continue;
        const audit = readPiNfAudit(task.directory);
        if (!audit) continue;
        seen.add(task.taskId);
        entries.push(piNfSummary(audit, this.sessionIds));
      }
    }
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  locate(taskId: string): LocatedTask {
    for (const root of this.roots) {
      const directory = taskDirectory(root, taskId);
      if (existsSync(resolve(directory, 'state.json'))) return { root, directory, workspace: resolve(root, '..'), source: 'codex' };
    }
    for (const workspace of this.workspaces) {
      const root = resolve(workspace, '.pi-nf');
      const directory = taskDirectory(root, taskId);
      if (existsSync(resolve(directory, 'audit.json'))) return { root, directory, workspace, source: 'pi-nf' };
    }
    throw new Error('Task not found.');
  }

  sourceOf(taskId: string): TaskSource {
    return this.locate(taskId).source;
  }

  read(taskId: string): TaskRecord {
    const located = this.locate(taskId);
    if (located.source === 'pi-nf') {
      const audit = readPiNfAudit(located.directory);
      if (!audit) throw new Error('Task not found.');
      return piNfRecord(audit, this.sessionIds);
    }
    return this.readFromRoot(located.root, taskId);
  }

  private readFromRoot(root: string, taskId: string): TaskRecord {
    const directory = taskDirectory(root, taskId);
    const statePath = resolve(directory, 'state.json');
    if (!existsSync(statePath)) throw new Error('Task not found.');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as State;
    if (!state.task || state.task_id !== taskId) throw new Error('Task state identity mismatch.');
    const title = displayTitle(directory, taskId);
    const metadata = displayMetadata(directory);
    const persistedSessionId = stringValue(metadata.session_id);
    const sessionSeed = stringValue((state as State & { main_session_id?: string }).main_session_id) ?? state.worker_thread_id ?? stringValue((state as State & { run_generation?: string }).run_generation) ?? taskId;
    const sessionId = this.sessionIds.assign(`${root}:${taskId}`, state.status, sessionSeed, persistedSessionId ?? undefined);
    const events = safeEvents(resolve(directory, 'events.jsonl'));
    const summaryPath = resolve(directory, 'summary.md');
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
    const rounds = makeRounds(events).filter(state.mode === 'live' ? isCompleteLiveSupervisionRound : isCompleteSupervisionRound);
    return { title, sessionId, taskId, state: stateView(state, title, sessionId), summary, rounds, eventCount: events.length, snapshotIds: snapshotIds(directory), updatedAt: state.updated_at };
  }
}
