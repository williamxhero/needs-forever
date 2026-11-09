#!/usr/bin/env node
import { deliverMainSessionRecoveryPrompt } from '../dist/src/main-session-recovery.js';
import { redact } from '../dist/src/redact.js';

const [statePath, ...args] = process.argv.slice(2);
const fixturePath = args.length === 2 && args[0] === '--test-fixture' ? args[1] : undefined;
if (!statePath || (args.length && !fixturePath)) throw new Error('Recovery prompt requires a state path and optional fixture.');
try {
  await deliverMainSessionRecoveryPrompt(statePath, fixturePath);
} catch (error) {
  process.stderr.write(`${String(redact(error instanceof Error ? error.message : String(error)))}\n`);
  process.exitCode = 1;
}
