import type { Decision, Snapshot } from './types.js';
import { setTimeout as delay } from 'node:timers/promises';

export interface Judge { judge(snapshot: Snapshot, signal?: AbortSignal): Promise<Decision> }

export class FixtureJudge implements Judge {
  private index = 0;
  constructor(private readonly decision: Decision | Decision[], private readonly delayMs = 0, private readonly ignoreCancellation = false) {}
  async judge(_snapshot: Snapshot, signal?: AbortSignal): Promise<Decision> {
    if (this.delayMs) await delay(this.delayMs, undefined, signal && !this.ignoreCancellation ? { signal } : undefined);
    const result = Array.isArray(this.decision) ? this.decision[this.index++] : this.decision;
    if (!result) throw new Error('Fixed judge fixture exhausted; no completion is inferred.');
    return structuredClone(result);
  }
}

export class UnavailableJudge implements Judge {
  async judge(_snapshot: Snapshot): Promise<Decision> {
    throw new Error('Real judge is not implemented in S1. Use --test-fixture only for simulated acceptance; S2 supplies the live judge.');
  }
}
