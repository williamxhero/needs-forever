#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { registeredStatePaths, readJson } from '../runtime/src/main-session.js';
import { inspectHookHost } from '../runtime/src/hook-host.js';
import { controlIntent } from '../runtime/src/control-intent.js';
import { handleLifecycle } from '../runtime/src/lifecycle.js';
import { redact } from '../runtime/src/redact.js';
import { boundStateForEvent, dispatchBoundLifecycle, launchController } from '../runtime/src/main-controller.js';

// Native hook stdin/stdout is the public transport. No application protocol is
// inferred from terminal text or transcript files.
try {
  // Stamp before reading stdin so a delayed callback cannot masquerade as a
  // fresh receipt after armNativeRebind rotates the generation.
  const nativeReceipt = { occurrence_id: randomUUID(), issued_at: new Date().toISOString() };
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--test-fixture')) throw new Error('Only an explicit external --test-fixture FILE is supported.');
  const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('Hook input exceeds 1 MiB.');
  }
  const input = JSON.parse(data);
  if (input.agent_id != null || input.agent_type != null || input.agent_transcript_path != null) { console.log('{}'); process.exit(0); }
  const existing = boundStateForEvent(input, pluginRoot, Boolean(args[1]));
  if (existing) {
    const host = input.hook_event_name === 'SessionStart' ? inspectHookHost(pluginRoot, args[1]) : null;
    console.log(JSON.stringify(await dispatchBoundLifecycle(existing, input, pluginRoot, createHash('sha256').update(readFileSync(new URL('../runtime/integrity.json', import.meta.url))).digest('hex'), host?.desktop_pid)));
  } else {
    const preparation = input.hook_event_name === 'PreToolUse' && controlIntent(input.tool_input, pluginRoot) !== null;
    const pending = typeof input.cwd === 'string' && registeredStatePaths(input.cwd).some((path) => {
      if (!existsSync(path)) return false;
      const binding = readJson(path).binding;
      if (binding?.status !== 'PENDING_NATIVE_HOOK') return false;
      if (input.hook_event_name === 'PostToolUse') return true;
      return ['rebind', 'resume'].includes(binding.operation) && ['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name);
    });
    if (!preparation && !pending) { console.log('{}'); process.exit(0); }
    const host = inspectHookHost(pluginRoot, args[1]);
    const result = handleLifecycle(input, host, pluginRoot, undefined, nativeReceipt);
    if (result.bound) await launchController(result.state_path, pluginRoot, args[1]);
    console.log('{}');
  }
} catch (error) {
  console.error(String(redact(error.message)));
  process.exitCode = 1;
}
