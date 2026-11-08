#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { registeredStatePaths, readJson } from '../runtime/src/main-session.js';
import { inspectHookHost } from '../runtime/src/hook-host.js';
import { controlIntent } from '../runtime/src/control-intent.js';
import { handleLifecycle } from '../runtime/src/lifecycle.js';
import { redact } from '../runtime/src/redact.js';
import { boundStateForEvent, dispatchBoundLifecycle, launchController } from '../runtime/src/main-controller.js';

async function forwardAdapterEvent(input, pluginRoot) {
  try {
    const manifestPath = process.env.NF_DAEMON_MANIFEST || resolve(homedir(), '.needs-forever', 'daemon.json');
    const tokenPath = process.env.NF_DAEMON_TOKEN_PATH || resolve(homedir(), '.needs-forever', 'daemon.token');
    const token = process.env.NF_DAEMON_TOKEN || readFileSync(tokenPath, 'utf8').trim();
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const url = process.env.NF_DAEMON_URL || 'http://127.0.0.1:8790';
    let taskId = typeof input.nf_task_id === 'string' ? input.nf_task_id : typeof input.task_id === 'string' ? input.task_id : null;
    if (!taskId && typeof input.cwd === 'string') {
      for (const statePath of registeredStatePaths(input.cwd)) {
        try {
          const state = readJson(statePath);
          if (state?.main_session_id === input.session_id || state?.binding?.expected_main_session_id === input.session_id) { taskId = state.task_id; break; }
        } catch { /* Ignore an atomically replaced checkpoint. */ }
      }
    }
    if (!taskId || !token || !manifest) return;
    const payload = { hook_event_name: input.hook_event_name ?? null, tool_name: input.tool_name ?? null, stop_reason: input.stop_reason ?? input.STOP_REASON ?? null };
    const eventType = input.hook_event_name === 'Stop' ? 'stop' : input.hook_event_name === 'SessionStart' ? 'session_start' : input.hook_event_name === 'UserPromptSubmit' ? 'user_prompt' : input.hook_event_name === 'Interrupt' ? 'interrupt' : input.hook_event_name === 'PreToolUse' ? 'pre_tool' : input.hook_event_name === 'PostToolUse' ? 'post_tool' : 'register';
    const envelope = { schema_version: 1, provider: 'codex', host_instance_id: String(process.pid), session_id: input.session_id, task_id: taskId, workspace: input.cwd, event_type: eventType, occurrence_id: randomUUID(), issued_at: new Date().toISOString(), turn_id: typeof input.turn_id === 'string' ? input.turn_id : null, bundle_sha256: createHash('sha256').update(readFileSync(new URL('../runtime/integrity.json', import.meta.url))).digest('hex'), payload };
    await fetch(`${url}/api/events`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
  } catch {
    // The adapter is best-effort. Native lifecycle handling remains the
    // authoritative path when the daemon is unavailable.
  }
}

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
  await forwardAdapterEvent(input, pluginRoot);
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
