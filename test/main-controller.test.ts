import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { scheduleNativeRebindPrompt } from '../src/main-session-recovery.js';
import type { MainSessionState } from '../src/main-session.js';
import { routeInventoryDecision } from '../src/planning.js';
import type { Snapshot } from '../src/types.js';

function installed(name: string, transport: unknown = {}, sessionId = name, boundStatus = 0, limits: Record<string, number> = {}, appServer?: Record<string, unknown>, desktopPid?: number, c2Mode = 'legacy') {
  const directory = resolve('runs/main-controller', `${name}-${Date.now()}`);
  const workspace = join(directory, '工作 空间');
  const plugin = join(directory, '插件 安装副本');
  mkdirSync(workspace, { recursive: true });
  cpSync(resolve('plugins/needs-forever'), plugin, { recursive: true });
  const task = join(directory, 'task.json');
  const state = join(workspace, '.codex-supervisor', name, 'state.json');
  const fixture = join(directory, 'host.json');
  const trace = join(directory, 'protocol.jsonl');
  const scenario = join(directory, 'server.json');
  if (appServer) writeFileSync(scenario, JSON.stringify({ trace, ...appServer }));
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, c2: { mode: c2Mode }, goal: 'Three stages', acceptance: [{ id: 'all', text: 'Three stages complete' }], authorization: 'Local files', limits }));
  writeFileSync(fixture, JSON.stringify({ desktop_version: 'simulated', cli_version: 'simulated', transport, ...(desktopPid ? { desktop_pid: desktopPid } : {}), ...(appServer ? { app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), scenario] } : {}) }));
  const control = join(plugin, 'scripts/main-session.mjs');
  const run = (command: string, args: string[] = []) => spawnSync(process.execPath, [control, command, '--state', state, ...args], { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
  const hook = (event: Record<string, unknown>) => spawnSync(process.execPath, [join(plugin, 'scripts/lifecycle.mjs'), '--test-fixture', fixture], { cwd: workspace, env: { ...process.env, PLUGIN_ROOT: plugin }, input: JSON.stringify({ session_id: sessionId, cwd: workspace, turn_id: 'same-turn', ...event }), encoding: 'utf8', timeout: 20_000 });
  const tool = { tool_use_id: 'prepare', tool_input: { command: `node "${control}" prepare --task "${task}" --state "${state}" --test-fixture "${fixture}"` } };
  assert.equal(hook({ ...tool, hook_event_name: 'PreToolUse' }).status, 0);
  const prepared = run('prepare', ['--task', task, '--test-fixture', fixture]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const bound = hook({ ...tool, hook_event_name: 'PostToolUse', tool_response: prepared.stdout });
  assert.equal(bound.status, boundStatus, bound.stderr);
  const setDesktopPid = (pid: number) => writeFileSync(fixture, JSON.stringify({ ...JSON.parse(readFileSync(fixture, 'utf8')), desktop_pid: pid }));
  return { directory, workspace, plugin, task, state, fixture, trace, run, hook, setDesktopPid };
}

test('native C2 admission redacts the entire selected decision before checkpoint and recovery prompt', (t) => {
  const secret = 'sk-abcdefghijklmnop'; // Deliberately fake credential, never a real account value.
  const decision = routeInventoryDecision({} as Snapshot, `Inspect local proof ${secret}`, `Inspect the authorized artifact; remove ${secret} from the report.`);
  decision.route_plan!.candidates[0]!.hypothesis += ` Synthetic test marker ${secret}.`;
  const f = installed('c2-secret-boundary', { decision }, 'c2-secret-boundary', 0, {}, undefined, undefined, 'enforce');
  t.after(() => f.run('pause'));
  const stopped = f.hook({ hook_event_name: 'Stop' });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).reason, decision.next_message.replace(secret, '[REDACTED]'));
  const state = JSON.parse(f.run('status').stdout);
  assert.equal(state.pending_action.message, state.last_decision.route_plan.candidates[0].actions.join('\n'));
  assert.equal(state.recovery_prompt.message, state.pending_action.message);
  for (const path of [f.state, join(f.workspace, '.codex-supervisor', 'c2-secret-boundary', 'events.jsonl')]) assert.equal(readFileSync(path, 'utf8').includes(secret), false, path);
});

test('installed native Stop ingests the actual paired tool result before choosing a source-linked artifact', (t) => {
  const f = installed('c2-native-inventory', {}, 'c2-native-inventory', 0, {}, { judge_actions: ['CONTINUE', 'CONTINUE'], judge_select_observed_artifact: true }, undefined, 'enforce');
  t.after(() => f.run('pause'));
  assert.equal(JSON.parse(f.hook({ hook_event_name: 'Stop' }).stdout).decision, 'block');
  mkdirSync(join(f.workspace, 'cache'), { recursive: true });
  writeFileSync(join(f.workspace, 'cache', 'result.csv'), 'date,close\n2026-11-09,17\n');
  const inventory = { nf_route_inventory: { schema_version: 1, task_id: 'c2-native-inventory', task_version: 1, routes: [{ route_id: 'native-cache', resource: { kind: 'artifact', id: 'cache/result.csv' }, operation: 'read-local-artifact' }] } };
  const tool = { tool_use_id: 'actual-inventory', tool_name: 'exec_command', tool_input: { command: 'node bounded-inventory.js' } };
  assert.equal(f.hook({ ...tool, hook_event_name: 'PreToolUse' }).status, 0);
  const result = spawnSync(process.execPath, ['-e', 'console.log(process.argv[1])', JSON.stringify(inventory)], { cwd: f.workspace, encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0);
  assert.equal(f.hook({ ...tool, hook_event_name: 'PostToolUse', tool_response: { stdout: result.stdout, exitCode: result.status } }).status, 0);
  const stopped = f.hook({ hook_event_name: 'Stop' });
  assert.deepEqual(JSON.parse(stopped.stdout), { decision: 'block', reason: 'Read cache/result.csv and verify the required result.' });
  const state = JSON.parse(f.run('status').stdout);
  assert.equal(state.route_catalog.entries.find((entry: any) => entry.route_id === 'native-cache')?.status, 'observed');
  assert.equal(state.pending_action.route_id, 'native-cache');
  assert.equal(state.recovery_prompt.route_id, 'native-cache');
  assert.equal(state.route_execution.route.route_id, 'native-cache');
});

test('installed bound main session automatically owns an independent B and synchronous Stop returns direction without claiming execution', (t) => {
  const f = installed('automatic-B', { decision: { action: 'CONTINUE', next_message: 'Implement phase two and check phase-two.txt.' } });
  t.after(() => f.run('pause'));
  const initial = JSON.parse(f.run('status').stdout);
  assert.equal(initial.live, true, 'Binding must automatically launch the controller.');
  assert.equal(initial.status, 'ACTIVE');
  assert.equal(initial.worker_thread_id, null);
  assert.notEqual(initial.controller.pid, process.pid);
  const stopped = f.hook({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout), { decision: 'block', reason: 'Implement phase two and check phase-two.txt.' });
  const status = JSON.parse(f.run('status').stdout);
  assert.equal(status.host.hook_effective, false);
  assert.equal(status.pending_action.stage, 'sent');
  assert.equal(status.continuation_confirmed, false);
  assert.equal(status.stop_transport.outcome, 'returned');
  assert.equal(status.stop_transport.request.session_id, 'automatic-B');
  assert.equal(status.mode, 'simulated');
});

test('NF automatically delivers a returned CONTINUE prompt when original A stays idle', async (t) => {
  const f = installed('automatic-recovery-prompt', { decision: { action: 'CONTINUE', next_message: 'Continue the authorized task.' } }, 'automatic-recovery-prompt', 0, {}, { main_session_thread_id: 'automatic-recovery-prompt' });
  t.after(() => f.run('pause'));
  const stopped = f.hook({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.deepEqual(JSON.parse(stopped.stdout), { decision: 'block', reason: 'Continue the authorized task.' });
  await delay(4_500);
  const events = readFileSync(join(f.workspace, '.codex-supervisor', 'automatic-recovery-prompt', 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const types = events.map((event) => event.type);
  assert.ok(types.includes('main_session_recovery_prompt_scheduled'));
  assert.ok(types.includes('main_session_recovery_prompt_attempted'));
  assert.ok(types.includes('main_session_recovery_prompt_sent'));
  assert.ok(types.includes('main_session_recovery_prompt_acknowledged'));
  const recoverySend = readFileSync(f.trace, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'automatic-recovery-prompt');
  assert.ok(recoverySend, 'NF must send through the original A thread identity.');
});

test('a manual pause cancels the pending NF recovery prompt before delivery', async (t) => {
  const f = installed('recovery-prompt-pause', { decision: { action: 'CONTINUE', next_message: 'This must not be delivered after pause.' } }, 'recovery-prompt-pause', 0, {}, { main_session_thread_id: 'recovery-prompt-pause' });
  t.after(() => f.run('pause'));
  assert.deepEqual(JSON.parse(f.hook({ hook_event_name: 'Stop' }).stdout), { decision: 'block', reason: 'This must not be delivered after pause.' });
  assert.equal(f.run('pause').status, 0);
  await delay(3_500);
  const events = readFileSync(join(f.workspace, '.codex-supervisor', 'recovery-prompt-pause', 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(events.some((event) => event.type === 'main_session_recovery_prompt_attempted'), false);
});

test('installed Stop deadline invalidates delayed direction and retains an explicit recovery checkpoint', (t) => {
  const f = installed('deadline-B', { timeout_ms: 30, delay_ms: 250, decision: { action: 'CONTINUE', next_message: 'This late direction must never reach A.' } });
  t.after(() => f.run('pause'));
  const stopped = f.hook({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout), {});
  const status = JSON.parse(f.run('status').stdout);
  assert.equal(status.phase, 'RECOVERING');
  assert.equal(status.stop_transport.outcome, 'unknown');
  assert.equal(status.pending_action, null);
  assert.match(status.recovery_condition.message, /deadline/i);
  assert.equal(status.recovery_required, true);
});

test('a second task cannot own the same main session and its failed startup remains diagnosable', (t) => {
  const session = `unique-session-${Date.now()}`;
  const first = installed('lease-first', {}, session);
  t.after(() => first.run('pause'));
  const second = installed('lease-second', {}, session, 1);
  const failed = JSON.parse(second.run('status').stdout);
  assert.equal(failed.live, false);
  assert.equal(failed.phase, 'RECOVERING');
  assert.match(failed.recovery_condition.message, /lease/i);
  const stillOwned = JSON.parse(first.run('status').stdout);
  assert.equal(stillOwned.live, true);
  assert.equal(stillOwned.main_session_id, session);
});

test('an installed state rejects a second B without disturbing its owned controller', (t) => {
  const f = installed('task-lease');
  t.after(() => f.run('pause'));
  const before = JSON.parse(f.run('status').stdout);
  const duplicate = spawnSync(process.execPath, [join(f.plugin, 'scripts/controller.mjs'), f.state, '--test-fixture', f.fixture], { cwd: f.workspace, encoding: 'utf8', timeout: 20_000 });
  assert.equal(duplicate.status, 1);
  const after = JSON.parse(f.run('status').stdout);
  assert.equal(after.live, true);
  assert.equal(after.controller.id, before.controller.id);
  assert.equal(after.controller.pid, before.controller.pid);
});

test('disconnecting the owned hook before judgment invalidates late output instead of replaying it', async (t) => {
  const f = installed('disconnected-hook', { delay_ms: 5_000, decision: { action: 'CONTINUE', next_message: 'Late direction' } });
  t.after(() => f.run('pause'));
  const callback = spawn(process.execPath, [join(f.plugin, 'scripts/lifecycle.mjs'), '--test-fixture', f.fixture], { cwd: f.workspace, env: { ...process.env, PLUGIN_ROOT: f.plugin }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  const exited = new Promise<void>((done) => callback.once('exit', () => done()));
  callback.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'disconnected-hook', cwd: f.workspace, turn_id: 'same-turn', stop_hook_active: false }));
  let pending: any;
  for (let i = 0; i < 30; i++) {
    pending = JSON.parse(f.run('status').stdout);
    if (pending.stop_transport?.outcome === 'pending') break;
    await delay(25);
  }
  assert.equal(pending.stop_transport?.outcome, 'pending');
  callback.kill(); // This handle is the exact hook process created by this test.
  await exited;
  let status: any;
  for (let i = 0; i < 30; i++) {
    status = JSON.parse(f.run('status').stdout);
    if (status.stop_transport?.outcome === 'unknown') break;
    await delay(25);
  }
  assert.equal(status.stop_transport.outcome, 'unknown');
  assert.equal(status.phase, 'RECOVERING');
  assert.equal(status.pending_action, null);
  assert.match(status.last_error, /disconnected/i);
});

test('native Interrupt persists PAUSED before canceling a delayed judgment and cannot return its late direction', async (t) => {
  const f = installed('interrupt-precedence', { delay_ms: 3_000, decision: { action: 'CONTINUE', next_message: 'Obsolete direction' } });
  t.after(() => f.run('pause'));
  const callback = spawn(process.execPath, [join(f.plugin, 'scripts/lifecycle.mjs'), '--test-fixture', f.fixture], { cwd: f.workspace, env: { ...process.env, PLUGIN_ROOT: f.plugin }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  callback.stdout.on('data', (chunk) => { output += chunk; });
  const exited = new Promise<void>((done) => callback.once('exit', () => done()));
  callback.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'interrupt-precedence', cwd: f.workspace, turn_id: 'turn-one' }));
  for (let i = 0; i < 40 && JSON.parse(f.run('status').stdout).phase !== 'JUDGE'; i++) await delay(25);
  const started = Date.now();
  assert.equal(f.hook({ hook_event_name: 'Interrupt' }).status, 0);
  assert.ok(Date.now() - started < 3_000, 'Interrupt must not wait for judgment.');
  assert.equal(JSON.parse(f.run('status').stdout).status, 'PAUSED');
  await exited;
  assert.deepEqual(JSON.parse(output), {});
  const saved = JSON.parse(f.run('status').stdout);
  assert.equal(saved.status, 'PAUSED');
  assert.equal(saved.pending_action, null);
});

test('a newer human prompt cancels old judgment while a later Stop in the same turn can still be supervised', async (t) => {
  const f = installed('input-precedence', {}, 'input-precedence', 0, {}, { hold_judge_once: true, judge_actions: ['CONTINUE', 'CONTINUE'] });
  t.after(() => f.run('pause'));
  const callback = spawn(process.execPath, [join(f.plugin, 'scripts/lifecycle.mjs'), '--test-fixture', f.fixture], { cwd: f.workspace, env: { ...process.env, PLUGIN_ROOT: f.plugin }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; callback.stdout.on('data', (chunk) => { output += chunk; });
  const exited = new Promise<void>((done) => callback.once('exit', () => done()));
  callback.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'input-precedence', cwd: f.workspace, turn_id: 'same-turn' }));
  const protocol = () => readFileSync(f.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  for (let i = 0; i < 200 && !protocol().some((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'judge-1'); i++) await delay(25);
  assert.ok(protocol().some((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'judge-1'), 'The first C must actually be started and held before the human input is submitted.');
  assert.equal(JSON.parse(f.run('status').stdout).phase, 'JUDGE');
  assert.equal(f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Use the local alternative, within the same authorization.' }).status, 0);
  await exited;
  assert.deepEqual(JSON.parse(output), {});
  const status = JSON.parse(f.run('status').stdout);
  assert.equal(status.status, 'ACTIVE');
  assert.equal(status.input_epoch, 1);
  assert.match(status.latest_human_input.prompt, /local alternative/);
  assert.equal(status.pending_action, null);
  assert.equal(JSON.parse(f.hook({ hook_event_name: 'Stop', stop_hook_active: true }).stdout).decision, 'block');
  assert.equal(JSON.parse(f.run('status').stdout).worker_turn_count, 1);
});

test('explicit resume preserves original A and cumulative evidence, requiring a fresh same-A native receipt', async (t) => {
  const f = installed('resume-same-A', { decision: { action: 'CONTINUE', next_message: 'Continue current work' } });
  t.after(() => f.run('pause'));
  f.hook({ hook_event_name: 'Stop' });
  const before = JSON.parse(f.run('status').stdout);
  assert.equal(f.run('pause').status, 0);
  await delay(100);
  const control = join(f.plugin, 'scripts/main-session.mjs');
  const tool = { tool_use_id: 'resume-new', tool_input: { command: `node "${control}" resume --state "${f.state}" --test-fixture "${f.fixture}"` } };
  assert.equal(f.hook({ ...tool, hook_event_name: 'PreToolUse' }).status, 0);
  const prepared = f.run('resume', ['--test-fixture', f.fixture]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(f.hook({ ...tool, hook_event_name: 'PostToolUse', session_id: 'foreign-A', tool_response: prepared.stdout }).status, 0);
  assert.equal(JSON.parse(f.run('status').stdout).live, false);
  assert.equal(f.hook({ ...tool, hook_event_name: 'PostToolUse', tool_response: prepared.stdout }).status, 0);
  const resumed = JSON.parse(f.run('status').stdout);
  assert.equal(resumed.live, true);
  assert.equal(resumed.main_session_id, before.main_session_id);
  assert.notEqual(resumed.run_generation, before.run_generation);
  assert.equal(resumed.worker_turn_count, before.worker_turn_count);
  assert.ok(resumed.elapsed_active_seconds >= before.elapsed_active_seconds);
  assert.equal(resumed.pending_action, null);
  assert.equal(resumed.continuation_confirmed, false);
  assert.equal(JSON.parse(f.hook({ hook_event_name: 'Stop' }).stdout).decision, 'block');
});

test('plugin start defaults to main-session and core CLI cannot mutate that checkpoint as a legacy worker', () => {
  const f = installed('default-route');
  try {
    const before = JSON.parse(f.run('status').stdout);
    const status = spawnSync(process.execPath, [join(f.plugin, 'scripts/control.mjs'), 'status', '--state', f.state], { cwd: f.workspace, encoding: 'utf8', timeout: 10_000 });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).control_mode, 'main-session');
    const wrong = spawnSync(process.execPath, [join(f.plugin, 'runtime/src/cli.js'), 'resume', '--state', f.state], { cwd: f.workspace, encoding: 'utf8', timeout: 10_000 });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /main-session/);
    assert.equal(JSON.parse(f.run('status').stdout).run_generation, before.run_generation);
    const task = join(f.directory, 'another-task.json'); const state = join(f.workspace, '.codex-supervisor', 'another-task', 'state.json');
    writeFileSync(task, JSON.stringify({ ...JSON.parse(readFileSync(f.task, 'utf8')), task_id: 'another-task' }));
    const started = spawnSync(process.execPath, [join(f.plugin, 'scripts/control.mjs'), 'start', '--task', task, '--state', state, '--test-fixture', f.fixture], { cwd: f.workspace, encoding: 'utf8', timeout: 10_000 });
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).control_mode, 'main-session');
    assert.equal(JSON.parse(started.stdout).binding.status, 'PENDING_NATIVE_HOOK');
  } finally { f.run('pause'); }
});

test('foreign and stale generation Stop events do not replace a returned direction', (t) => {
  const f = installed('deduplicated-stop', { decision: { action: 'CONTINUE', next_message: 'Only one eligible direction' } });
  t.after(() => f.run('pause'));
  const first = f.hook({ hook_event_name: 'Stop', event_id: 'stop-unique-one' });
  assert.equal(JSON.parse(first.stdout).decision, 'block');
  const before = JSON.parse(f.run('status').stdout);
  for (const event of [{ session_id: 'foreign-session' }, { run_generation: 'obsolete' }]) {
    assert.deepEqual(JSON.parse(f.hook({ hook_event_name: 'Stop', ...event }).stdout), {});
    assert.equal(JSON.parse(f.run('status').stdout).pending_action.delivery_id, before.pending_action.delivery_id);
  }
  assert.equal(JSON.parse(f.hook({ hook_event_name: 'Stop', event_id: 'stop-unique-two', stop_hook_active: true }).stdout).decision, 'block');
  assert.notEqual(JSON.parse(f.run('status').stdout).pending_action.delivery_id, before.pending_action.delivery_id);
});

test('native host restart automatically rebinds the same A without a manual resume', async (t) => {
  const f = installed('host-restarted', { decision: { action: 'CONTINUE', next_message: 'Original direction' } }, 'host-restarted', 0, {}, undefined, process.pid);
  t.after(() => f.run('pause'));
  const original = JSON.parse(f.run('status').stdout);
  assert.equal(f.hook({ hook_event_name: 'SessionStart' }).status, 0);
  assert.equal(JSON.parse(f.run('status').stdout).phase, 'WORKER', 'A same-Desktop SessionStart does not change the active state.');
  f.setDesktopPid(process.ppid);
  assert.equal(f.hook({ hook_event_name: 'SessionStart' }).status, 0);
  const rebound = JSON.parse(f.run('status').stdout);
  assert.equal(rebound.status, 'ACTIVE');
  assert.equal(rebound.phase, 'WORKER');
  assert.equal(rebound.live, true);
  assert.equal(rebound.binding.status, 'BOUND');
  assert.equal(rebound.controller.lifecycle, 'running');
  assert.equal(rebound.host.desktop_pid, process.ppid);
  assert.notEqual(rebound.run_generation, original.run_generation);
  assert.deepEqual(JSON.parse(f.hook({ hook_event_name: 'Stop', run_generation: original.run_generation }).stdout), {});
  assert.deepEqual(JSON.parse(f.hook({ hook_event_name: 'Stop' }).stdout), { decision: 'block', reason: 'Original direction' });
});

test('automatic native rebind rotates the generation and rejects stale lifecycle events', async (t) => {
  const f = installed('automatic-native-rebind', { decision: { action: 'CONTINUE', next_message: 'Original direction must not replay.' } }, 'automatic-native-rebind', 0, {}, undefined, process.pid);
  t.after(() => f.run('pause'));
  const before = JSON.parse(f.run('status').stdout);
  f.setDesktopPid(process.ppid);
  assert.equal(f.hook({ hook_event_name: 'SessionStart' }).status, 0);
  const rebound = JSON.parse(f.run('status').stdout);
  assert.equal(rebound.binding.status, 'BOUND');
  assert.equal(rebound.status, 'ACTIVE');
  assert.equal(rebound.phase, 'WORKER');
  assert.equal(rebound.controller.lifecycle, 'running');
  assert.notEqual(rebound.run_generation, before.run_generation);
  assert.deepEqual(JSON.parse(f.hook({ hook_event_name: 'UserPromptSubmit', run_generation: before.run_generation, prompt: 'stale lifecycle' }).stdout), {});
  assert.equal(JSON.parse(f.run('status').stdout).run_generation, rebound.run_generation);
  assert.deepEqual(JSON.parse(f.hook({ hook_event_name: 'Stop' }).stdout), { decision: 'block', reason: 'Original direction must not replay.' });
});

test('native rebind recovery automatically prompts the original A instead of waiting forever', async (t) => {
  const f = installed('native-rebind-prompt', {}, 'native-rebind-prompt', 0, {}, { main_session_thread_id: 'native-rebind-prompt' });
  t.after(() => f.run('pause'));
  const before = JSON.parse(f.run('status').stdout) as MainSessionState;
  assert.equal(f.run('pause').status, 0);
  const pending = {
    ...before,
    status: 'ACTIVE', phase: 'RECOVERING', controller: undefined,
    run_generation: 'rebind-generation',
    binding: { ...before.binding, status: 'PENDING_NATIVE_HOOK', operation: 'rebind', expected_run_generation: 'rebind-generation', armed_at: new Date().toISOString() },
    recovery_condition: { kind: 'native_rebind', message: 'Binding expired.', resume_when: 'A native receipt.' },
    recovery_parent: { stop_attempt_id: 'stop-parent-001', turn_id: 'turn-parent-001' },
    recovery_plan: { ...(before.recovery_plan ?? { owner: null, generation: 'rebind-generation', task_version: before.task_version, attempt: 0, next_retry_at: null, reason: { kind: 'native_rebind', message: 'Binding expired.', resume_when: 'A native receipt.' }, status: 'waiting_native', cancellation_boundary: null }), owner: null, generation: 'rebind-generation', status: 'waiting_native' },
  } as unknown as MainSessionState;
  writeFileSync(f.state, `${JSON.stringify(pending)}\n`);
  assert.equal(scheduleNativeRebindPrompt(f.state, f.plugin, f.fixture, pending, 'Binding expired.'), true);
  const deadline = Date.now() + 4_000;
  let events: any[] = [];
  while (Date.now() < deadline) {
    try { events = readFileSync(join(f.workspace, '.codex-supervisor', 'native-rebind-prompt', 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { /* child has not created the file yet */ }
    if (events.some((event) => event.type === 'main_session_recovery_prompt_acknowledged')) break;
    await delay(25);
  }
  assert.ok(events.some((event) => event.type === 'main_session_recovery_prompt_scheduled'));
  assert.ok(events.some((event) => event.type === 'main_session_recovery_prompt_sent'));
  assert.ok(events.some((event) => event.type === 'main_session_recovery_prompt_acknowledged'));
  const scheduled = events.find((event) => event.type === 'main_session_recovery_prompt_scheduled');
  const sent = events.find((event) => event.type === 'main_session_recovery_prompt_sent');
  const acknowledged = events.find((event) => event.type === 'main_session_recovery_prompt_acknowledged');
  assert.equal(scheduled.stop_attempt_id, 'stop-parent-001');
  assert.equal(scheduled.turn_id, 'turn-parent-001');
  assert.equal(sent.stop_attempt_id, 'stop-parent-001');
  assert.equal(sent.turn_id, 'turn-parent-001');
  assert.equal(acknowledged.stop_attempt_id, 'stop-parent-001');
  assert.equal(acknowledged.turn_id, 'turn-parent-001');
});

test('legacy pending resume checkpoints migrate to automatic rebind on the next original-A lifecycle event', async (t) => {
  const f = installed('legacy-pending-resume', { decision: { action: 'CONTINUE', next_message: 'Continue after migrated rebind.' } });
  t.after(() => f.run('pause'));
  assert.equal(f.run('pause').status, 0);
  const resumed = f.run('resume', ['--test-fixture', f.fixture]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const pending = JSON.parse(f.run('status').stdout);
  assert.equal(pending.status, 'PAUSED');
  assert.equal(pending.binding.status, 'PENDING_NATIVE_HOOK');
  assert.equal(pending.binding.operation, 'resume');
  assert.equal(f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Original A resumed normally.' }).status, 0);
  assert.equal(JSON.parse(f.run('status').stdout).binding.status, 'PENDING_NATIVE_HOOK');
  assert.equal(f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Original A emitted a fresh lifecycle receipt.' }).status, 0);
  let rebound: any;
  for (let attempt = 0; attempt < 80; attempt++) {
    rebound = JSON.parse(f.run('status').stdout);
    if (rebound.controller?.lifecycle === 'running' && rebound.status === 'ACTIVE') break;
    await delay(25);
  }
  assert.equal(rebound.binding.status, 'BOUND');
  assert.equal(rebound.controller.lifecycle, 'running');
  assert.equal(rebound.recovery_plan.status, 'running');
  assert.ok(rebound.recovery_plan.generation);
});

test('foreign and late native rebind receipts cannot wake a paused or completed task', async (t) => {
  const f = installed('rebind-boundaries', { decision: { action: 'CONTINUE', next_message: 'Continue once.' } }, 'rebind-boundaries', 0, {}, undefined, process.pid);
  t.after(() => f.run('pause'));
  f.setDesktopPid(process.ppid);
  assert.equal(f.hook({ hook_event_name: 'SessionStart' }).status, 0);
  const rebound = JSON.parse(f.run('status').stdout);
  assert.equal(rebound.binding.status, 'BOUND');
  assert.equal(rebound.phase, 'WORKER');
  assert.deepEqual(JSON.parse(f.hook({ hook_event_name: 'SessionStart', session_id: 'foreign-A' }).stdout), {});
  assert.equal(JSON.parse(f.run('status').stdout).binding.status, 'BOUND');
  assert.equal(f.run('pause').status, 0);
  assert.deepEqual(JSON.parse(f.hook({ hook_event_name: 'SessionStart' }).stdout), {});
  assert.equal(JSON.parse(f.run('status').stdout).status, 'PAUSED');
  await delay(50);
});

test('a lifecycle receipt issued before armNativeRebind is rejected when run_generation is omitted', async (t) => {
  const f = installed('stale-receipt-fence', { decision: { action: 'CONTINUE', next_message: 'Continue once.' } }, 'stale-receipt-fence', 0, {}, undefined, process.pid);
  t.after(() => f.run('pause'));
  const callback = spawn(process.execPath, [join(f.plugin, 'scripts/lifecycle.mjs'), '--test-fixture', f.fixture], { cwd: f.workspace, env: { ...process.env, PLUGIN_ROOT: f.plugin }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  await delay(150);
  f.setDesktopPid(process.ppid);
  assert.equal(f.hook({ hook_event_name: 'SessionStart' }).status, 0);
  callback.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'stale-receipt-fence', cwd: f.workspace, prompt: 'delayed callback' }));
  await new Promise<void>((resolve) => callback.once('exit', () => resolve()));
  const rebound = JSON.parse(f.run('status').stdout);
  assert.equal(rebound.binding.status, 'BOUND');
  assert.equal(rebound.controller?.lifecycle, 'running');
  assert.equal(f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'fresh callback' }).status, 0);
  assert.equal(JSON.parse(f.run('status').stdout).binding.status, 'BOUND');
});

test('a second installed plugin package cannot dispatch callbacks to the first package controller', (t) => {
  const f = installed('plugin-package-isolation', { decision: { action: 'CONTINUE', next_message: 'Continue from the owning package.' } });
  t.after(() => f.run('pause'));
  const first = JSON.parse(f.run('status').stdout);
  assert.equal(first.live, true);
  const otherPlugin = join(f.directory, 'other-plugin');
  cpSync(f.plugin, otherPlugin, { recursive: true });
  const foreign = spawnSync(process.execPath, [join(otherPlugin, 'scripts/lifecycle.mjs'), '--test-fixture', f.fixture], {
    cwd: f.workspace,
    env: { ...process.env, PLUGIN_ROOT: otherPlugin },
    input: JSON.stringify({ session_id: 'plugin-package-isolation', cwd: f.workspace, hook_event_name: 'Stop', turn_id: 'same-turn' }),
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(foreign.status, 0, foreign.stderr);
  assert.deepEqual(JSON.parse(foreign.stdout), {});
  const afterForeign = JSON.parse(f.run('status').stdout);
  assert.equal(afterForeign.phase, 'WORKER');
  assert.equal(afterForeign.live, true);
  assert.equal(afterForeign.last_stop, undefined);
  const owned = f.hook({ hook_event_name: 'Stop' });
  assert.equal(owned.status, 0, owned.stderr);
  assert.deepEqual(JSON.parse(owned.stdout), { decision: 'block', reason: 'Continue from the owning package.' });
});

test('explicit cumulative turn and ACTIVE time limits pause durably without inventing a hidden limit', async (t) => {
  const turns = installed('limit-turn', { decision: { action: 'CONTINUE', next_message: 'Beyond the user limit' } }, 'limit-turn', 0, { max_worker_turns: 1 });
  t.after(() => turns.run('pause'));
  assert.deepEqual(JSON.parse(turns.hook({ hook_event_name: 'Stop' }).stdout), {});
  const stopped = JSON.parse(turns.run('status').stdout);
  assert.equal(stopped.status, 'PAUSED'); assert.equal(stopped.pause_reason, 'user_limit'); assert.equal(stopped.worker_turn_count, 1);
  await delay(100);
  const refused = turns.run('resume', ['--test-fixture', turns.fixture]);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /Cumulative user_limit/);
  const timed = installed('limit-time', {}, 'limit-time', 0, { max_minutes: 0.02 });
  t.after(() => timed.run('pause'));
  await delay(1400);
  const time = JSON.parse(timed.run('status').stdout);
  assert.equal(time.status, 'PAUSED'); assert.equal(time.pause_reason, 'user_limit'); assert.ok(time.elapsed_active_seconds >= 1.2);
});
