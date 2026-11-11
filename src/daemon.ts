import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { createRecoveryPlan, reconcileRecoveryTick, cancelRecovery, resetRecoveryWindow } from './recovery-coordinator.js';
import { validateAdapterEnvelope, type AdapterEnvelope } from './adapter-protocol.js';
import { Store } from './store.js';
import type { State } from './types.js';
import { armNativeRebind, type MainSessionState } from './main-session.js';

/** A persisted task known to the NF daemon. State remains owned by the task
 * directory; the daemon only keeps a registry and a durable audit trail. */
export interface DaemonTaskRecord {
  taskId: string;
  statePath: string;
  workspace: string;
  status: State['status'] | 'UNKNOWN';
  phase: State['phase'] | 'UNKNOWN';
  updatedAt: string | null;
  deleted: boolean;
  lastSeenAt: string;
}

export interface DaemonAuditEvent {
  id: string;
  at: string;
  type: string;
  taskId?: string;
  details?: Record<string, unknown>;
}

interface DaemonManifest {
  schemaVersion: 1;
  daemonId: string;
  workspaces: string[];
  tasks: Record<string, DaemonTaskRecord>;
  createdAt: string;
  updatedAt: string;
}

export interface NFDaemonOptions {
  /** Roots to scan for state.json files below `.codex-supervisor`. */
  workspaces: string[];
  /** Directory or manifest file used for daemon persistence. */
  dataPath?: string;
  /** Tick period. Set to zero to disable the timer (useful for tests). */
  intervalMs?: number;
  /** Clock injection makes recovery and audit tests deterministic. */
  now?: () => number;
  /** Provider adapter invoked only after the recovery checkpoint is durable. */
  recoverTask?: (statePath: string) => void;
}

export interface DaemonTickResult {
  at: string;
  discovered: number;
  changed: number;
  waitingNative: number;
  nextRetryAt: string | null;
}

export interface NFDaemonStatus {
  daemonId: string;
  running: boolean;
  pid: number;
  workspaces: string[];
  taskCount: number;
  activeTaskCount: number;
  lastTickAt: string | null;
  tickCount: number;
}

function readState(path: string): State | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<State>;
    if (value.schema_version !== 1 || typeof value.task_id !== 'string' || !value.task || typeof value.task.workspace !== 'string') return null;
    return value as State;
  } catch {
    return null;
  }
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function canonical(path: string): string {
  return resolve(path).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
}

function inside(child: string, parent: string): boolean {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(`${p}/`);
}

function discoverStateFiles(workspace: string): string[] {
  const root = resolve(workspace, '.codex-supervisor');
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isFile() && entry.name === 'state.json') found.push(path);
      else if (entry.isDirectory() && entry.name !== 'snapshots') visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return found.sort();
}

/**
 * The independent NF supervision daemon. It has no dependency on a Codex
 * process: task discovery and recovery ticks continue while adapters connect
 * and disconnect. The B/C execution itself remains behind the existing
 * supervisor and can be supplied by a provider adapter in a later ticket.
 */
export class NFDaemon {
  readonly dataPath: string;
  readonly auditPath: string;
  readonly tokenPath: string;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly workspaceRoots: string[];
  private readonly recoverTask: NFDaemonOptions['recoverTask'];
  private manifest: DaemonManifest;
  private timer: NodeJS.Timeout | undefined;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private running = false;
  private lastTickAt: string | null = null;
  private tickCount = 0;
  private readonly callbacks = new Set<(result: DaemonTickResult) => void>();
  private readonly seenOccurrences = new Set<string>();

  constructor(options: NFDaemonOptions) {
    if (!options.workspaces.length) throw new Error('NF daemon requires at least one workspace.');
    this.workspaceRoots = [...new Set(options.workspaces.map((workspace) => resolve(workspace)))].sort();
    this.now = options.now ?? (() => Date.now());
    this.recoverTask = options.recoverTask;
    this.intervalMs = options.intervalMs ?? 30_000;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 0) throw new Error('intervalMs must be a nonnegative number.');
    const configured = options.dataPath ?? resolve(homedir(), '.needs-forever', 'daemon.json');
    this.dataPath = configured.endsWith('.json') ? resolve(configured) : resolve(configured, 'daemon.json');
    this.auditPath = resolve(dirname(this.dataPath), 'audit.jsonl');
    this.tokenPath = resolve(dirname(this.dataPath), 'daemon.token');
    this.manifest = this.loadManifest();
    this.manifest.workspaces = this.workspaceRoots;
    for (const event of this.auditEvents()) {
      const occurrence = event.details?.occurrence_id;
      if (typeof occurrence === 'string') this.seenOccurrences.add(occurrence);
    }
    this.persist();
  }

  private loadManifest(): DaemonManifest {
    try {
      const parsed = JSON.parse(readFileSync(this.dataPath, 'utf8')) as Partial<DaemonManifest>;
      if (parsed.schemaVersion === 1 && typeof parsed.daemonId === 'string' && parsed.tasks && Array.isArray(parsed.workspaces)) {
        return { ...parsed, tasks: parsed.tasks as Record<string, DaemonTaskRecord>, workspaces: parsed.workspaces.map(String) } as DaemonManifest;
      }
    } catch { /* first start or an interrupted write */ }
    const at = new Date(this.now()).toISOString();
    return { schemaVersion: 1, daemonId: randomUUID(), workspaces: [], tasks: {}, createdAt: at, updatedAt: at };
  }

  private persist(): void {
    this.manifest.updatedAt = new Date(this.now()).toISOString();
    atomicWrite(this.dataPath, this.manifest);
  }

  /** A bearer token is persisted with the daemon manifest and never printed. */
  getToken(): string {
    try {
      const token = readFileSync(this.tokenPath, 'utf8').trim();
      if (token) return token;
    } catch { /* generate below */ }
    const token = randomBytes(32).toString('hex');
    mkdirSync(dirname(this.tokenPath), { recursive: true });
    writeFileSync(this.tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    return token;
  }

  onTick(callback: (result: DaemonTickResult) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    if (this.intervalMs > 0) this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.audit('daemon_started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.timer = undefined;
    if (!this.running) return;
    this.running = false;
    this.audit('daemon_stopped');
  }

  async tick(): Promise<DaemonTickResult> {
    const at = new Date(this.now()).toISOString();
    let discovered = 0;
    let changed = 0;
    let waitingNative = 0;
    let nextRetryAt: string | null = null;
    let recoveryDeadline: number | null = null;
    let recoveryPromptAt: number | null = null;
    for (const workspace of this.workspaceRoots) {
      for (const statePath of discoverStateFiles(workspace)) {
        const state = readState(statePath);
        if (!state || !inside(state.task.workspace, workspace)) continue;
        discovered++;
        const prior = this.manifest.tasks[state.task_id];
        const record: DaemonTaskRecord = {
          taskId: state.task_id, statePath: resolve(statePath), workspace: resolve(state.task.workspace), status: state.status,
          phase: state.phase, updatedAt: state.updated_at ?? null, deleted: prior?.deleted ?? false, lastSeenAt: at,
        };
        this.manifest.tasks[state.task_id] = record;
        if (record.deleted) continue;
        const result = reconcileRecoveryTick(statePath, this.now());
        if (result.waitingNative) this.dispatchRecovery(statePath);
        if (result.changed) changed++;
        if (result.waitingNative) waitingNative++;
        if (result.nextRetryAt && (!nextRetryAt || result.nextRetryAt < nextRetryAt)) nextRetryAt = result.nextRetryAt;
        const refreshed = readState(statePath);
        if (refreshed) {
          const record = this.manifest.tasks[state.task_id]!;
          record.status = refreshed.status; record.phase = refreshed.phase; record.updatedAt = refreshed.updated_at ?? null;
          if ((refreshed.status === 'ACTIVE' || (refreshed.status === 'PAUSED' && !refreshed.pause_reason)) && refreshed.recovery_window && refreshed.recovery_plan?.status !== 'cancelled') {
            const deadline = Date.parse(refreshed.recovery_window.deadline_at);
            if (Number.isFinite(deadline)) recoveryDeadline = Math.min(recoveryDeadline ?? deadline, deadline);
          }
          // The detached coordinator is normally responsible for fallback
          // prompts, but it may exit while B is still alive (or before it is
          // restarted).  Keep the global NF watchdog authoritative for every
          // due prompt, including ordinary continuation prompts whose
          // recovery plan is `armed` rather than `waiting_native`.
          const prompt = (refreshed as MainSessionState).recovery_prompt;
          if (refreshed.status === 'ACTIVE' && (refreshed as MainSessionState).control_mode === 'main-session' && prompt) {
            const dueAt = Date.parse(prompt.due_at);
            if (Number.isFinite(dueAt)) recoveryPromptAt = Math.min(recoveryPromptAt ?? dueAt, dueAt);
          }
          if (prompt && Number.isFinite(Date.parse(prompt.due_at)) && Date.parse(prompt.due_at) <= this.now()) this.dispatchRecovery(statePath);
        }
      }
    }
    this.persist();
    this.lastTickAt = at;
    this.tickCount++;
    // Honor the persisted deadline even between the ordinary discovery polls.
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    const nextWakeAt = [recoveryDeadline, recoveryPromptAt].filter((value): value is number => value !== null).reduce<number | null>((earliest, value) => Math.min(earliest ?? value, value), null);
    this.recoveryTimer = this.running && nextWakeAt !== null
      ? setTimeout(() => { void this.tick(); }, Math.max(1, nextWakeAt - this.now()))
      : undefined;
    const result = { at, discovered, changed, waitingNative, nextRetryAt };
    for (const callback of this.callbacks) callback(result);
    return result;
  }

  status(): NFDaemonStatus {
    const records = this.tasks();
    return {
      daemonId: this.manifest.daemonId, running: this.running, pid: process.pid, workspaces: [...this.workspaceRoots],
      taskCount: records.length, activeTaskCount: records.filter((task) => task.status === 'ACTIVE').length,
      lastTickAt: this.lastTickAt, tickCount: this.tickCount,
    };
  }

  tasks(includeDeleted = false): DaemonTaskRecord[] {
    return Object.values(this.manifest.tasks).filter((task) => includeDeleted || !task.deleted).sort((a, b) => a.taskId.localeCompare(b.taskId));
  }

  task(taskId: string): DaemonTaskRecord | null {
    const task = this.manifest.tasks[taskId];
    return task && !task.deleted ? { ...task } : null;
  }

  private dispatchRecovery(statePath: string): void {
    if (!this.recoverTask) return;
    try { this.recoverTask(statePath); }
    catch { this.audit('recovery_dispatch_failed', readState(statePath)?.task_id, { reason: 'Provider recovery driver failed; the next daemon tick will retry.' }); }
  }

  /** Apply a user control boundary and leave a durable audit record. */
  control(taskId: string, action: 'pause' | 'resume' | 'delete'): DaemonTaskRecord | null {
    const record = this.manifest.tasks[taskId];
    if (!record || record.deleted) return null;
    if (action === 'delete') {
      record.deleted = true;
      this.audit('task_deleted', taskId);
      this.persist();
      return null;
    }
    const state = readState(record.statePath);
    if (!state) throw new Error('Task state is unavailable or invalid.');
    if (action === 'pause') {
      if (state.status !== 'DONE' && state.status !== 'INTERRUPTED') {
        state.status = 'PAUSED'; state.phase = 'IDLE'; state.pause_reason = 'user'; delete state.route_execution;
        cancelRecovery(state, 'pause', this.now());
        const store = new Store(record.statePath); store.save(state); store.event(state, 'daemon_paused', { source: 'nf-daemon' });
      }
      this.audit('task_paused', taskId);
    } else {
      if (state.status === 'PAUSED' || state.status === 'WAIT_EXTERNAL' || state.status === 'INTERRUPTED') {
        if (state.status === 'INTERRUPTED') state.task_version++;
        resetRecoveryWindow(state, this.now());
        delete state.last_error;
        delete state.pause_reason;
        if ((state as State & { control_mode?: string }).control_mode === 'main-session') {
                    // A daemon resume re-arms the provider binding. The NF
                    // recovery prompt path is separate and records its own
                    // send/ack events; it does not claim a host receipt.
          const main = state as MainSessionState;
          main.recovery_condition = { kind: 'daemon_resume', message: 'Task resumed through NF daemon; waiting for a fresh native host receipt.', resume_when: 'A registered original host may complete the binding.' };
          if (main.main_session_id) {
            state.status = 'ACTIVE';
            armNativeRebind(main, main.recovery_condition.message);
          } else {
            state.status = 'PAUSED'; state.phase = 'RECOVERING';
            if (main.binding) main.binding.status = 'PENDING_NATIVE_HOOK';
            state.recovery_plan = createRecoveryPlan(state, main.recovery_condition, true);
          }
        } else {
          state.status = 'ACTIVE'; state.phase = 'RECOVERING';
          state.recovery_plan = createRecoveryPlan(state, { kind: 'daemon_resume', message: 'Task resumed through NF daemon.', resume_when: 'A registered host may continue the saved task.' });
        }
        const store = new Store(record.statePath); store.save(state); store.event(state, 'daemon_resumed', { source: 'nf-daemon' });
        this.dispatchRecovery(record.statePath);
      }
      this.audit('task_resumed', taskId);
    }
    record.status = state.status; record.phase = state.phase; record.updatedAt = state.updated_at;
    this.persist();
    return { ...record };
  }

  audit(type: string, taskId?: string, details?: Record<string, unknown>): void {
    const event: DaemonAuditEvent = { id: randomUUID(), at: new Date(this.now()).toISOString(), type, ...(taskId ? { taskId } : {}), ...(details ? { details } : {}) };
    mkdirSync(dirname(this.auditPath), { recursive: true });
    appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  auditEvents(): DaemonAuditEvent[] {
    try { return readFileSync(this.auditPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as DaemonAuditEvent); } catch { return []; }
  }

  /** Accept a provider-neutral event without allowing the adapter to mutate
   * task state directly. Provider-specific lifecycle handling remains behind
   * the registered adapter/controller boundary. */
  ingest(value: unknown): { accepted: boolean; duplicate: boolean; occurrence_id: string } {
    const envelope = validateAdapterEnvelope(value);
    const task = this.manifest.tasks[envelope.task_id];
    if (!task && envelope.event_type !== 'register') throw new Error('Adapter event references an unknown task.');
    if (this.seenOccurrences.has(envelope.occurrence_id)) return { accepted: false, duplicate: true, occurrence_id: envelope.occurrence_id };
    this.seenOccurrences.add(envelope.occurrence_id);
    this.audit('adapter_event', envelope.task_id, { occurrence_id: envelope.occurrence_id, provider: envelope.provider, host_instance_id: envelope.host_instance_id, session_id: envelope.session_id, event_type: envelope.event_type, turn_id: envelope.turn_id, issued_at: envelope.issued_at, bundle_sha256: envelope.bundle_sha256, payload: envelope.payload });
    return { accepted: true, duplicate: false, occurrence_id: envelope.occurrence_id };
  }
}

export interface LoopbackApiOptions { daemon: NFDaemon; host?: string; port?: number; token?: string; }
export interface RunningLoopbackApi { server: Server; host: string; port: number; url: string; token: string; close: () => Promise<void>; }

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) { text += String(chunk); if (text.length > 1_000_000) throw new Error('Request body too large.'); }
  if (!text.trim()) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object.');
  return value as Record<string, unknown>;
}

/** Start the authenticated local control plane. Loopback binding keeps the
 * first daemon release single-user while remaining portable beyond Windows. */
export function startLoopbackApi(options: LoopbackApiOptions): Promise<RunningLoopbackApi> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const token = options.token ?? options.daemon.getToken();
  const daemon = options.daemon;
  const server = createServer(async (request, response) => {
    try {
      const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? request.headers['x-nf-token'];
      if (supplied !== token) { json(response, 401, { error: 'Unauthorized' }); return; }
      const url = new URL(request.url ?? '/', `http://${host}`);
      const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
      const apiOffset = parts[0] === 'api' || parts[0] === 'v1' ? 1 : -1;
      if (apiOffset >= 0 && parts.length === apiOffset + 1 && parts[apiOffset] === 'events' && request.method === 'POST') {
        const result = daemon.ingest(await body(request)); json(response, 202, result); return;
      }
      if (apiOffset < 0 || parts[apiOffset] !== 'tasks') {
        if (parts[apiOffset] === 'health' || parts[0] === 'health') { json(response, 200, { ok: true, daemon: daemon.status() }); return; }
        if (parts[apiOffset] === 'status' || parts[0] === 'status') { json(response, 200, daemon.status()); return; }
        json(response, 404, { error: 'Not found' }); return;
      }
      if (parts.length === apiOffset + 1 && request.method === 'GET') { json(response, 200, { tasks: daemon.tasks() }); return; }
      const taskId = parts[apiOffset + 1];
      if (!taskId) { json(response, 400, { error: 'Task id is required.' }); return; }
      if (parts.length === apiOffset + 2 && request.method === 'GET') {
        const task = daemon.task(taskId); if (!task) { json(response, 404, { error: 'Task not found.' }); return; }
        json(response, 200, task); return;
      }
      if (parts.length === apiOffset + 3 && parts[apiOffset + 2] === 'control' && request.method === 'POST') {
        const action = (await body(request)).action;
        if (action !== 'pause' && action !== 'resume' && action !== 'delete') { json(response, 400, { error: 'action must be pause, resume, or delete.' }); return; }
        const task = daemon.control(taskId, action); json(response, 200, { ok: true, task }); return;
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : 'Request failed.' }); }
  });
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolvePromise({ server, host, port: actualPort, url: `http://${host}:${actualPort}`, token, close: () => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) });
    };
    server.once('error', onError); server.once('listening', onListening); server.listen(port, host);
  });
}

export { discoverStateFiles };
