#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { reconcileRecoveryTick } from '../runtime/src/recovery-coordinator.js';

const statePath = process.argv[2];
if (!statePath) throw new Error('Recovery coordinator requires a state path.');
const interval = Math.max(100, Number(process.argv[3] ?? 250));
let stopping = false;
const stop = () => { stopping = true; };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

while (!stopping && existsSync(statePath)) {
  let snapshot;
  try { snapshot = JSON.parse(readFileSync(statePath, 'utf8')); } catch { await new Promise((resolve) => setTimeout(resolve, interval)); continue; }
  if (snapshot.status === 'DONE' || snapshot.status === 'PAUSED' || snapshot.recovery_plan?.status === 'cancelled') break;
  try {
    const result = reconcileRecoveryTick(statePath);
    if (result.waitingNative) {
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
}
