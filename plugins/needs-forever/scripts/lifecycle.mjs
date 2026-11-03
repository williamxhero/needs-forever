#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { inspectHookHost } from '../runtime/src/hook-host.js';
import { handleLifecycle } from '../runtime/src/lifecycle.js';
import { redact } from '../runtime/src/redact.js';

// Native hook stdin/stdout is the public transport. No application protocol is
// inferred from terminal text or transcript files.
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--test-fixture')) throw new Error('Only an explicit external --test-fixture FILE is supported.');
  const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('Hook input exceeds 1 MiB.');
  }
  const input = JSON.parse(data);
  const host = inspectHookHost(pluginRoot, args[1]);
  handleLifecycle(input, host, pluginRoot);
  // Ticket #35 adds synchronous B dispatch. Until then, no internal request
  // envelope may leak into the host's decision-only stdout protocol.
  console.log('{}');
} catch (error) {
  console.error(String(redact(error.message)));
  process.exitCode = 1;
}
