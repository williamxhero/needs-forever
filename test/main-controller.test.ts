import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function installed(name: string, transport: unknown = {}, sessionId = name, boundStatus = 0, limits: Record<string, number> = {}, appServer?: Record<string, unknown>, desktopPid?: number) {
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
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, goal: 'Three stages', acceptance: [{ id: 'all', text: 'Three stages complete' }], authorization: 'Local files', limits }));
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

test('native host restart requires explicit same-A resume and never replays a prior direction', async (t) => {
  const f = installed('host-restarted', { decision: { action: 'CONTINUE', next_message: 'Original direction' } }, 'host-restarted', 0, {}, undefined, process.pid);
  t.after(() => f.run('pause'));
  f.hook({ hook_event_name: 'Stop' });
  const original = JSON.parse(f.run('status').stdout);
  assert.equal(f.hook({ hook_event_name: 'SessionStart' }).status, 0);
  assert.equal(JSON.parse(f.run('status').stdout).phase, 'WORKER', 'A same-Desktop SessionStart does not masquerade as a host restart.');
  f.setDesktopPid(process.ppid);
  assert.equal(f.hook({ hook_event_name: 'SessionStart' }).status, 0);
  const recovering = JSON.parse(f.run('status').stdout);
  assert.equal(recovering.phase, 'RECOVERING');
  assert.equal(recovering.live, true, 'A reachable B cannot stand in for native host readiness.');
  assert.deepEqual(JSON.parse(f.hook({ hook_event_name: 'Stop' }).stdout), {});
  const control = join(f.plugin, 'scripts/main-session.mjs');
  const tool = { tool_use_id: 'host-resume', tool_input: { command: `node "${control}" resume --state "${f.state}" --test-fixture "${f.fixture}"` } };
  f.setDesktopPid(process.pid);
  f.hook({ ...tool, hook_event_name: 'PreToolUse' });
  const resumed = f.run('resume', ['--test-fixture', f.fixture]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(f.hook({ ...tool, hook_event_name: 'PostToolUse', tool_response: resumed.stdout }).status, 0);
  const after = JSON.parse(f.run('status').stdout);
  assert.equal(after.live, true);
  assert.notEqual(after.run_generation, original.run_generation);
  assert.equal(after.pending_action, null);
  assert.equal(after.recovery_history.at(-1).pending_action.delivery_id, original.pending_action.delivery_id);
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
