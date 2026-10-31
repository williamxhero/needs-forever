import { mkdirSync, openSync, closeSync, writeFileSync, renameSync, appendFileSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { State, Snapshot, Task } from './types.js';
import { redact } from './redact.js';

export class Store {
  readonly directory: string;
  private readonly locks: { fd: number; path: string; token: string }[] = [];
  constructor(readonly path: string) { this.directory = dirname(path); }
  lock(task: Task, recover = false): void {
    mkdirSync(this.directory, { recursive: true });
    const canonicalWorkspace = realpathSync(task.workspace);
    const identity = JSON.stringify([process.platform === 'win32' ? canonicalWorkspace.toLowerCase() : canonicalWorkspace, task.task_id]);
    const lockPath = resolve(tmpdir(), 'codex-supervisor-locks', `${createHash('sha256').update(identity).digest('hex')}.lock`);
    mkdirSync(dirname(lockPath), { recursive: true });
    try {
      for (const path of [lockPath, `${this.path}.lock`]) {
        let fd: number;
        try { fd = openSync(path, 'wx'); }
        catch (error) {
          if (!recover || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const guard = `${path}.reclaim`;
          const guardFd = openSync(guard, 'wx');
          try {
            const owner = JSON.parse(readFileSync(path, 'utf8'));
            if (!Number.isInteger(owner.pid) || owner.pid <= 0 || owner.task_id !== task.task_id || owner.state_path !== this.path) throw new Error('Existing lock ownership cannot be safely recovered.');
            try { process.kill(owner.pid, 0); throw new Error('Task already has a live supervisor lock.'); }
            catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
            unlinkSync(path);
            fd = openSync(path, 'wx');
          } finally { closeSync(guardFd); unlinkSync(guard); }
        }
        const token = randomUUID();
        this.locks.push({ fd, path, token });
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, task_id: task.task_id, state_path: this.path, started_at: new Date().toISOString() }));
      }
    }
    catch (error) {
      this.release();
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Task already has a supervisor lock.');
      throw error;
    }
  }
  release(): void {
    for (const lock of this.locks.splice(0)) {
      closeSync(lock.fd);
      if (JSON.parse(readFileSync(lock.path, 'utf8')).token === lock.token) unlinkSync(lock.path);
    }
  }
  read(): State { return JSON.parse(readFileSync(this.path, 'utf8')) as State; }
  save(state: State): void {
    state.updated_at = new Date().toISOString();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    // Windows readers/indexers may briefly deny replacement. Keep the old
    // checkpoint intact and retry the same atomic rename; never unlink it.
    const deadline = Date.now() + 5_000;
    while (true) {
      try { renameSync(temporary, this.path); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() >= deadline) throw error;
        // Avoid phase-locking retries with another process polling status at a
        // fixed interval. Windows readers/indexers can outlive a short probe.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 40));
      }
    }
    const summary = `# ${state.task_id}\n\n${state.task.goal}\n\nStatus: ${state.status}; phase: ${state.phase}; mode: ${state.mode}\n\nLast decision: ${state.last_decision?.action ?? 'none'}\n\n${state.last_decision?.reason ?? ''}\n\n${state.last_decision?.external?.missing ?? ''}\n\n${state.last_decision?.external?.resume_when ?? ''}\n\n${state.last_error ?? ''}\n`;
    writeFileSync(resolve(this.directory, 'summary.md'), `${summary.trimEnd()}\n`, 'utf8');
  }
  event(state: State, type: string, details: Record<string, unknown> = {}): void {
    appendFileSync(resolve(this.directory, 'events.jsonl'), `${JSON.stringify(redact({ at: new Date().toISOString(), type, task_id: state.task_id, task_version: state.task_version, mode: state.mode, ...details }))}\n`, 'utf8');
  }
  snapshot(snapshot: Snapshot, result: unknown): void {
    const directory = resolve(this.directory, 'snapshots');
    mkdirSync(directory, { recursive: true });
    // Snapshot identity is generated locally, never an arbitrary external pathname.
    writeFileSync(resolve(directory, `${snapshot.snapshot_id}.json`), `${JSON.stringify({ input: snapshot, raw_output: result, validation: result === null ? 'pending' : 'fixture-only' }, null, 2)}\n`, 'utf8');
  }
}
