import type { Decision, Snapshot } from './types.js';

export interface Judge { judge(snapshot: Snapshot): Promise<Decision> }

export class FixtureJudge implements Judge {
  constructor(private readonly decision: Decision) {}
  async judge(_snapshot: Snapshot): Promise<Decision> { return structuredClone(this.decision); }
}

export class UnavailableJudge implements Judge {
  async judge(_snapshot: Snapshot): Promise<Decision> {
    throw new Error('Real judge is not implemented in S1. Use --test-fixture only for simulated acceptance; S2 supplies the live judge.');
  }
}
