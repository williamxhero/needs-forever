#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
import { runController } from '../runtime/src/main-controller.js';
import { redact } from '../runtime/src/redact.js';
const [state, ...args] = process.argv.slice(2);
try {
  if (!state || (args.length && (args.length !== 2 || args[0] !== '--test-fixture'))) throw new Error('Controller requires a state path and optional fixture.');
  await runController(state, fileURLToPath(new URL('../', import.meta.url)), args[1]);
} catch (error) {
  process.send?.({ error: String(redact(error.message)) });
  if (process.connected) process.disconnect();
  appendFileSync(`${state}.controller.log`, String(redact(error.stack)) + '\n');
  process.exitCode = 1;
}
