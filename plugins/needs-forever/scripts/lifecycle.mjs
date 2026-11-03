#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { inspectHookHost } from '../runtime/src/hook-host.js';
import { handleLifecycle } from '../runtime/src/lifecycle.js';
import { redact } from '../runtime/src/redact.js';
import { boundStateForEvent, dispatchBoundLifecycle, launchController } from '../runtime/src/main-controller.js';

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
  const existing = boundStateForEvent(input, pluginRoot, Boolean(args[1]));
  if (existing) {
    console.log(JSON.stringify(await dispatchBoundLifecycle(existing, input)));
  } else {
    const host = inspectHookHost(pluginRoot, args[1]);
    const result = handleLifecycle(input, host, pluginRoot);
    if (result.bound) await launchController(result.state_path, pluginRoot, args[1]);
    console.log('{}');
  }
} catch (error) {
  console.error(String(redact(error.message)));
  process.exitCode = 1;
}
