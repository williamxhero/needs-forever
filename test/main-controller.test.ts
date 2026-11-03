import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function installed(name: string, transport: unknown = {}, sessionId = name, boundStatus = 0) {
  const directory = resolve('runs/main-controller', `${name}-${Date.now()}`);
  const workspace = join(directory, '工作 空间');
  const plugin = join(directory, '插件 安装副本');
  mkdirSync(workspace, { recursive: true });
  cpSync(resolve('plugins/needs-forever'), plugin, { recursive: true });
  const task = join(directory, 'task.json');
  const state = join(workspace, '.codex-supervisor', name, 'state.json');
  const fixture = join(directory, 'host.json');
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, goal: 'Three stages', acceptance: [{ id: 'all', text: 'Three stages complete' }], authorization: 'Local files', limits: {} }));
  writeFileSync(fixture, JSON.stringify({ desktop_version: 'simulated', cli_version: 'simulated', transport }));
  const control = join(plugin, 'scripts/main-session.mjs');
  const run = (command: string, args: string[] = []) => spawnSync(process.execPath, [control, command, '--state', state, ...args], { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
  const hook = (event: Record<string, unknown>) => spawnSync(process.execPath, [join(plugin, 'scripts/lifecycle.mjs'), '--test-fixture', fixture], { cwd: workspace, env: { ...process.env, PLUGIN_ROOT: plugin }, input: JSON.stringify({ session_id: sessionId, cwd: workspace, turn_id: 'same-turn', ...event }), encoding: 'utf8', timeout: 20_000 });
  const tool = { tool_use_id: 'prepare', tool_input: { command: `node "${control}" prepare --task "${task}" --state "${state}" --test-fixture "${fixture}"` } };
  assert.equal(hook({ ...tool, hook_event_name: 'PreToolUse' }).status, 0);
  const prepared = run('prepare', ['--task', task, '--test-fixture', fixture]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const bound = hook({ ...tool, hook_event_name: 'PostToolUse', tool_response: prepared.stdout });
  assert.equal(bound.status, boundStatus, bound.stderr);
  return { directory, workspace, plugin, state, fixture, run, hook };
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
