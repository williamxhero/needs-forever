import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RoutePersistenceOptions, RouteScope } from './route-contract.js';
import { record, text } from './types.js';

export function clone<T>(value: T): T { return structuredClone(value); }
export function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${field} must contain nonempty strings.`);
  return value as string[];
}
export function timestamp(value: unknown, field: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp.`);
}
export function validateEvidence(value: unknown): void {
  const evidence = record(value);
  text(evidence.id, 'evidence.id'); text(evidence.reference, 'evidence.reference');
  if (!['probe', 'verification', 'artifact', 'event'].includes(String(evidence.source))) throw new Error('Invalid observation source.');
  timestamp(evidence.observed_at, 'evidence.observed_at');
  if (!Number.isInteger(evidence.task_version) || Number(evidence.task_version) < 1) throw new Error('Invalid observation task_version.');
  if (typeof evidence.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.content_sha256)) throw new Error('Observation requires a substantive content_sha256.');
  if (evidence.summary !== undefined) text(evidence.summary, 'evidence.summary');
  if (evidence.omitted !== undefined && typeof evidence.omitted !== 'boolean') throw new Error('evidence.omitted must be boolean.');
}
export function scopeOf(value: unknown): RouteScope {
  const scope = record(value);
  text(scope.task_id, 'task_id');
  if (!Number.isInteger(scope.task_version) || Number(scope.task_version) < 1) throw new Error('task_version must be a positive integer.');
  return scope as unknown as RouteScope;
}
export function validateEnvelope(value: unknown): void {
  const data = record(value);
  if (data.schema_version !== 1 || !Number.isInteger(data.revision) || Number(data.revision) < 0) throw new Error('Invalid route storage schema or revision.');
  scopeOf(data.scope);
}

/** Separate sidecars leave State/events/recovery untouched. Each mutation reloads
 * under an exclusive writer lock so independent instances cannot lose updates.
 * A resumed task inherits history; an older task version cannot write over it.
 */
export class RouteStorage<T extends { scope: RouteScope; revision: number }> {
  private data: T;
  private readonly scope: RouteScope;
  private readonly path: string | undefined;
  constructor(scope: RouteScope, options: RoutePersistenceOptions<T>, empty: T, private readonly validate: (value: unknown) => void) {
    this.scope = clone(scopeOf(scope));
    if (options.path && options.data) throw new Error('Use either a route sidecar path or serialized data.');
    this.path = options.path;
    this.data = clone(options.data ?? empty);
    this.read();
  }
  read(): T {
    if (this.path) {
      try { this.data = JSON.parse(readFileSync(this.path, 'utf8')) as T; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.validate(this.data);
    if (this.data.scope.task_id !== this.scope.task_id) throw new Error('Route storage belongs to another task.');
    return clone(this.data);
  }
  update<R>(change: (data: T) => R): R {
    if (!this.path) return this.commit(change);
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    const fd = openSync(lock, 'wx');
    try { return this.commit(change); }
    finally { closeSync(fd); unlinkSync(lock); }
  }
  private commit<R>(change: (data: T) => R): R {
    const data = this.read();
    if (data.scope.task_version > this.scope.task_version) throw new Error('Stale task version cannot update route storage.');
    const result = change(data);
    data.scope = clone(this.scope);
    data.revision += 1;
    this.validate(data);
    if (this.path) {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        const deadline = Date.now() + 5_000;
        while (true) {
          try { renameSync(temporary, this.path); break; }
          catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          }
        }
      } finally {
        try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    this.data = data;
    return clone(result);
  }
}
