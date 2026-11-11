#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { reconcileRecoveryTick } from '../runtime/src/recovery-coordinator.js';
import { driveNativeRecovery } from '../runtime/src/main-session-recovery.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const statePath = process.argv[2];
if (!statePath) throw new Error('Recovery coordinator requires a state path.');
const interval = Math.max(100, Number(process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 250));
const fixtureFlag = process.argv.indexOf('--test-fixture');
const fixturePath = fixtureFlag >= 0 ? process.argv[fixtureFlag + 1] : undefined;
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
  if (snapshot.status === 'DONE' || snapshot.status === 'INTERRUPTED' || (snapshot.status === 'PAUSED' && (snapshot.phase !== 'RECOVERING' || snapshot.pause_reason || !snapshot.main_session_id)) || snapshot.recovery_plan?.status === 'cancelled') break;
  try {
    const result = reconcileRecoveryTick(statePath);
    const promptDue = snapshot.recovery_prompt && Date.parse(snapshot.recovery_prompt.due_at ?? '') <= Date.now();
    if (result.waitingNative || promptDue) {
      try {
        driveNativeRecovery(statePath, pluginRoot, fixturePath);
      } catch { /* The next tick retries after an interrupted checkpoint. */ }
      // Native A is the only authority that can produce the next B. Ordinary
      // continuation prompts also use this watchdog: an active-writer race is
      // deferred with a persisted due_at and must be retried automatically.
      const nextPromptAt = snapshot.recovery_prompt ? Date.parse(snapshot.recovery_prompt.due_at ?? '') : NaN;
      const wait = Number.isFinite(nextPromptAt) ? Math.max(100, Math.min(interval, nextPromptAt - Date.now())) : interval;
      await new Promise((resolve) => setTimeout(resolve, wait));
    } else {
      const nextPromptAt = snapshot.recovery_prompt ? Date.parse(snapshot.recovery_prompt.due_at ?? '') : NaN;
      const retryAt = result.nextRetryAt ? Date.parse(result.nextRetryAt) : NaN;
      const candidates = [nextPromptAt, retryAt].filter(Number.isFinite);
      const due = candidates.length ? Math.max(0, Math.min(...candidates) - Date.now()) : interval;
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
