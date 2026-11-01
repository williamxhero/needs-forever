import { mkdirSync, openSync, closeSync, writeFileSync, renameSync, appendFileSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { redact } from './redact.js';
export class Store {
    path;
    directory;
    locks = [];
    constructor(path) {
        this.path = path;
        this.directory = dirname(path);
    }
    lock(task, recover = false) {
        mkdirSync(this.directory, { recursive: true });
        const canonicalWorkspace = realpathSync(task.workspace);
        const identity = JSON.stringify([process.platform === 'win32' ? canonicalWorkspace.toLowerCase() : canonicalWorkspace, task.task_id]);
        const lockPath = resolve(tmpdir(), 'codex-supervisor-locks', `${createHash('sha256').update(identity).digest('hex')}.lock`);
        mkdirSync(dirname(lockPath), { recursive: true });
        try {
            for (const path of [lockPath, `${this.path}.lock`]) {
                let fd;
                try {
                    fd = openSync(path, 'wx');
                }
                catch (error) {
                    if (!recover || error.code !== 'EEXIST')
                        throw error;
                    const guard = `${path}.reclaim`;
                    const guardFd = openSync(guard, 'wx');
                    try {
                        const owner = JSON.parse(readFileSync(path, 'utf8'));
                        if (!Number.isInteger(owner.pid) || owner.pid <= 0 || owner.task_id !== task.task_id || owner.state_path !== this.path)
                            throw new Error('Existing lock ownership cannot be safely recovered.');
                        try {
                            process.kill(owner.pid, 0);
                            throw new Error('Task already has a live supervisor lock.');
                        }
                        catch (probe) {
                            if (probe.code !== 'ESRCH')
                                throw probe;
                        }
                        unlinkSync(path);
                        fd = openSync(path, 'wx');
                    }
                    finally {
                        closeSync(guardFd);
                        unlinkSync(guard);
                    }
                }
                const token = randomUUID();
                this.locks.push({ fd, path, token });
                writeFileSync(fd, JSON.stringify({ pid: process.pid, token, task_id: task.task_id, state_path: this.path, started_at: new Date().toISOString() }));
            }
        }
        catch (error) {
            this.release();
            if (error.code === 'EEXIST')
                throw new Error('Task already has a supervisor lock.');
            throw error;
        }
    }
    release() {
        for (const lock of this.locks.splice(0)) {
            closeSync(lock.fd);
            if (JSON.parse(readFileSync(lock.path, 'utf8')).token === lock.token)
                unlinkSync(lock.path);
        }
    }
    read() { return JSON.parse(readFileSync(this.path, 'utf8')); }
    protect(state) {
        if (!state.task.verify)
            return;
        if (state.protected_baseline)
            return;
        if (state.worker_thread_id)
            throw new Error('Existing worker has no protected baseline; cannot invent a resumed baseline.');
        state.protected_baseline = state.task.verify.protected_files.map((file) => {
            const path = resolve(state.task.workspace, file);
            const suffix = relative(realpathSync(state.task.workspace), realpathSync(path));
            if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('../') || suffix.startsWith('..\\'))
                throw new Error('Protected files must remain within the task workspace.');
            const content = readFileSync(path);
            return { path, sha256: createHash('sha256').update(content).digest('hex'), content_base64: content.toString('base64') };
        });
        this.save(state);
        this.event(state, 'protected_baseline_recorded', { files: state.protected_baseline.map(({ path, sha256 }) => ({ path, sha256 })) });
    }
    protectedChanges(state) {
        return (state.protected_baseline ?? []).flatMap((file) => {
            let actual = null;
            try {
                actual = createHash('sha256').update(readFileSync(file.path)).digest('hex');
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            return actual === file.sha256 ? [] : [{ path: file.path, expected_sha256: file.sha256, actual_sha256: actual }];
        });
    }
    save(state) {
        state.updated_at = new Date().toISOString();
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        // Windows readers/indexers may briefly deny replacement. Keep the old
        // checkpoint intact and retry the same atomic rename; never unlink it.
        const deadline = Date.now() + 5_000;
        while (true) {
            try {
                renameSync(temporary, this.path);
                break;
            }
            catch (error) {
                const code = error.code;
                if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() >= deadline)
                    throw error;
                // Avoid phase-locking retries with another process polling status at a
                // fixed interval. Windows readers/indexers can outlive a short probe.
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 40));
            }
        }
        const summary = `# ${state.task_id}\n\n${state.task.goal}\n\nStatus: ${state.status}; phase: ${state.phase}; mode: ${state.mode}\n\nLast decision: ${state.last_decision?.action ?? 'none'}\n\n${state.last_decision?.reason ?? ''}\n\n${state.last_decision?.external?.missing ?? ''}\n\n${state.last_decision?.external?.resume_when ?? ''}\n\n${state.last_error ?? ''}\n`;
        writeFileSync(resolve(this.directory, 'summary.md'), `${summary.trimEnd()}\n`, 'utf8');
    }
    event(state, type, details = {}) {
        appendFileSync(resolve(this.directory, 'events.jsonl'), `${JSON.stringify(redact({ event_id: randomUUID(), at: new Date().toISOString(), type, task_id: state.task_id, task_version: state.task_version, mode: state.mode, ...details }))}\n`, 'utf8');
    }
    events() { return readFileSync(resolve(this.directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    snapshot(snapshot, result, validation = result === null ? 'pending' : 'fixture-only') {
        const directory = resolve(this.directory, 'snapshots');
        mkdirSync(directory, { recursive: true });
        // Snapshot identity is generated locally, never an arbitrary external pathname.
        writeFileSync(resolve(directory, `${snapshot.snapshot_id}.json`), `${JSON.stringify(redact({ input: snapshot, raw_output: result, validation }), null, 2)}\n`, 'utf8');
    }
}
