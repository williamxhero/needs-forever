#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { reconcileRecoveryTick } from '../runtime/src/recovery-coordinator.js';
import { scheduleNativeRebindPrompt } from '../runtime/src/main-session-recovery.js';
import { Store } from '../runtime/src/store.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const statePath = process.argv[2];
if (!statePath) throw new Error('Recovery coordinator requires a state path.');
const interval = Math.max(100, Number(process.argv[3] ?? 250));
const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const leasePath = `${statePath}.recovery-coordinator.lock`;
let leaseFd;
try {
  leaseFd = openSync(leasePath, 'wx', 0o600);
  writeFileSync(leaseFd, JSON.stringify({ pid: process.pid, state_path: statePath, started_at: new Date().toISOString() }));
  closeSync(leaseFd);
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
  try {
    const existing = JSON.parse(readFileSync(leasePath, 'utf8'));
    if (Number.isInteger(existing.pid)) {
      try { process.kill(existing.pid, 0); process.exit(0); }
      catch (probe) { if (probe?.code !== 'ESRCH') process.exit(0); }
    }
    unlinkSync(leasePath);
    leaseFd = openSync(leasePath, 'wx', 0o600);
    writeFileSync(leaseFd, JSON.stringify({ pid: process.pid, state_path: statePath, started_at: new Date().toISOString() }));
    closeSync(leaseFd);
  } catch { process.exit(0); }
}
let stopping = false;
const stop = () => { stopping = true; };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

try { while (!stopping && existsSync(statePath)) {
  let snapshot;
  try { snapshot = JSON.parse(readFileSync(statePath, 'utf8')); } catch { await new Promise((resolve) => setTimeout(resolve, interval)); continue; }
  if (snapshot.status === 'DONE' || snapshot.status === 'PAUSED' || snapshot.recovery_plan?.status === 'cancelled') break;
  try {
    const result = reconcileRecoveryTick(statePath);
    if (result.waitingNative) {
      try {
        const current = JSON.parse(readFileSync(statePath, 'utf8'));
        const prompt = current.recovery_prompt;
        const dueAt = prompt?.kind === 'native_rebind' ? Date.parse(prompt.due_at) : NaN;
        if (prompt?.kind === 'native_rebind' && Number.isFinite(dueAt) && dueAt + 30_000 <= Date.now() && current.binding?.status === 'PENDING_NATIVE_HOOK' && current.binding?.operation === 'rebind') {
          delete current.recovery_prompt;
          const store = new Store(statePath);
          store.save(current);
          store.event(current, 'main_session_recovery_prompt_retry_scheduled', { reason: 'native lifecycle receipt did not arrive before the recovery prompt deadline.' });
        }
        scheduleNativeRebindPrompt(statePath, pluginRoot, undefined, current, current.recovery_plan?.reason?.message ?? '原始 A 的监督绑定已失效。');
      } catch { /* The next tick retries after an interrupted checkpoint. */ }
      // Native A is the only authority that can produce the next B. Polling
      // remains bounded and quiet while it waits for that real receipt.
      await new Promise((resolve) => setTimeout(resolve, interval));
    } else {
      const due = result.nextRetryAt ? Math.max(0, Date.parse(result.nextRetryAt) - Date.now()) : interval;
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, Math.max(100, due))));
    }
  } catch {
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
} } finally {
  try {
    const owner = JSON.parse(readFileSync(leasePath, 'utf8'));
    if (owner.pid === process.pid) unlinkSync(leasePath);
  } catch { /* The lease was already reclaimed or the state was removed. */ }
}
