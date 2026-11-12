import { createHash } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { setImmediate as yieldControl } from 'node:timers/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { routeInventoryDecision } from './planning.js';
import { validateDecision } from './judge.js';
import { Store } from './store.js';
import { redact } from './redact.js';
import type { Decision, Snapshot } from './types.js';
import type { MainSessionState } from './main-session.js';
import type { Rpc } from './transport.js';

export interface CompletionGateContext {
  state: MainSessionState;
  snapshot: Snapshot;
  store: Store;
  rpc: Rpc;
  signal: AbortSignal;
}

async function retryRead<T>(operation: string, path: string, read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (true) {
    signal.throwIfAborted();
    try { return await read(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() >= deadline) {
        throw new Error(`${operation} ${path}: ${(error as Error).message}`, { cause: error });
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10 + Math.floor(Math.random() * 40));
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    }
  }
}

async function readFileRetry(path: string, signal: AbortSignal): Promise<Buffer> {
  return retryRead('read', path, () => readFile(path), signal);
}

function verificationWorkspace(state: MainSessionState): string {
  const verify = state.task.verify;
  if (!verify || verify.argv.length < 2 || !isAbsolute(verify.argv[1]!)) return state.task.workspace;
  const workspace = resolve(state.task.workspace);
  const candidates = [dirname(resolve(verify.argv[1]!)), ...verify.protected_files.map((file) => dirname(resolve(file)))];
  const first = candidates[0]!;
  const prefix = process.platform === 'win32' ? first.toLowerCase() : first;
  if (candidates.some((candidate) => {
    const value = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    return value !== prefix;
  })) return state.task.workspace;
  const suffix = relative(workspace, first);
  if (suffix === '' || isAbsolute(suffix) || suffix === '..' || suffix.startsWith('../') || suffix.startsWith('..\\')) return state.task.workspace;
  return first;
}

export function continueWith(snapshot: Snapshot, message: string, reason: string): Decision {
  const concise = message.length <= 3_000 ? message : `${message.slice(0, 2_700)}\nRead the persisted verification_result and protected baseline for the complete evidence and original protected contents.`;
  const decision = snapshot.c2?.mode === 'legacy'
    ? { action: 'CONTINUE' as const, reason, evidence_ids: [], next_message: concise, external: null }
    : routeInventoryDecision(snapshot, reason, concise);
  return validateDecision(JSON.stringify(decision), snapshot);
}

async function workspaceDigest(state: MainSessionState, store: Store, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const statePath = resolve(store.path);
  const temporaryState = /^\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$/i;
  let visited = 0;
  const walk = async (directory: string): Promise<void> => {
    signal.throwIfAborted();
    const entries = await retryRead('readdir', directory, () => readdir(directory, { withFileTypes: true }), signal);
    for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal.throwIfAborted();
      if (++visited % 16 === 0) await yieldControl(undefined, { signal });
      const path = resolve(directory, item.name);
      const name = relative(state.task.workspace, path).replaceAll('\\', '/');
      if (name === '.codex-supervisor' || name === '.git') continue;
      const lowerPath = name.toLowerCase();
      if (lowerPath === '.scratch/main-session-supervision' || lowerPath.startsWith('.scratch/main-session-supervision/')) continue;
      const lowerName = item.name.toLowerCase();
      const generatedLock = (lowerName === 'lock' || lowerName === 'lock.reclaim' || lowerName.endsWith('.lock') || lowerName.endsWith('.lock.reclaim'))
        && !new Set(['cargo.lock', 'flake.lock', 'module.bazel.lock']).has(lowerName);
      const local = relative(store.directory, path).replaceAll('\\', '/');
      if (relative(statePath, path) === '' || local === 'summary.md' || local === 'events.jsonl'
        || generatedLock || path === `${statePath}.lock` || path === `${statePath}.lock.reclaim`
        || (path.startsWith(statePath) && temporaryState.test(path.slice(statePath.length)))) continue;
      hash.update(name);
      if (item.isSymbolicLink()) hash.update(`link:${await retryRead('readlink', path, () => readlink(path), signal)}`);
      else if (item.isDirectory()) await walk(path);
      else if (item.isFile()) {
        hash.update(await readFileRetry(path, signal));
        await yieldControl(undefined, { signal });
      }
    }
  };
  await walk(state.task.workspace);
  signal.throwIfAborted();
  return hash.digest('hex');
}

async function verifyDone(context: CompletionGateContext): Promise<Decision | null> {
  const { state, store, rpc, signal, snapshot } = context;
  const verify = state.task.verify;
  if (!verify) return null;
  signal.throwIfAborted();
  if (!state.protected_baseline) throw new Error('Missing initial protected baseline; a resumed verifier baseline must never be invented.');
  state.phase = 'VERIFY';
  store.save(state);
  const before = store.protectedChanges(state);
  const workspaceBefore = await workspaceDigest(state, store, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: { exitCode: number | null; stdout: string; stderr: string; timed_out?: boolean };
  const sandboxWorkspace = verificationWorkspace(state);
  if (before.length) result = { exitCode: null, stdout: '', stderr: 'Protected files changed before verification.' };
  else {
    try {
      result = await Promise.race([
        rpc.request<any>('command/exec', { command: verify.argv, cwd: sandboxWorkspace, timeoutMs: verify.timeout_seconds * 1_000, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [sandboxWorkspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Independent verification timeout.')), verify.timeout_seconds * 1_000 + 1_000); }),
      ]);
      if (!result || (result.exitCode !== null && !Number.isInteger(result.exitCode)) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error('Invalid independent verification response; exitCode/stdout/stderr required.');
    } catch (error) {
      signal.throwIfAborted();
      result = { exitCode: null, stdout: '', stderr: (error as Error).message, timed_out: /tim(e|ed)[ -]?out/i.test((error as Error).message) };
      if (result.timed_out) { await rpc.close(); store.event(state, 'verification_terminated', { via: 'owned_app_server_exit', server_process_id: rpc.processId }); }
    } finally { clearTimeout(timer); }
  }
  signal.throwIfAborted();
  const after = store.protectedChanges(state);
  const workspaceChanged = workspaceBefore !== await workspaceDigest(state, store, signal);
  signal.throwIfAborted();
  const passed = result.exitCode === 0 && !before.length && !after.length && !workspaceChanged;
  const evidence = redact({ argv: verify.argv, ...result, protected_before: before, protected_after: after, workspace_changed: workspaceChanged, passed });
  store.event(state, 'verification_result', evidence as Record<string, unknown>);
  if (passed) return null;
  const changed = new Set([...before, ...after].map((file) => file.path));
  const original = state.protected_baseline.filter((file) => changed.has(file.path));
  return continueWith(snapshot, `Independent verification failed. Repair the task and restore changed protected files; keep the original fixed argv. Rerun concise acceptance checks, then prepare to stop. Evidence: ${JSON.stringify(evidence)}. Original protected content (base64): ${JSON.stringify(original)}`, 'The fixed independent completion gate did not pass.');
}

/**
 * Apply the one native Stop completion policy to the judge's decision.
 * CONTINUE and WAIT_EXTERNAL pass through unchanged; DONE is accepted only
 * after the configured fixed verifier and all stability/protection checks.
 * A failed DONE becomes the concrete repair CONTINUE returned by this same
 * seam, so the controller never has a second terminal path to maintain.
 */
export async function completionGate(context: CompletionGateContext, decision: Decision): Promise<Decision> {
  if (decision.action !== 'DONE') return decision;
  return await verifyDone(context) ?? decision;
}
