import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

function setup(name: string, neutralPaths = false) {
  const directory = resolve('runs/main-session', `${name}-${Date.now()}`);
  const plugin = join(directory, '插件 安装目录');
  const workspace = join(directory, '任务 空间');
  mkdirSync(workspace, { recursive: true });
  cpSync(resolve('plugins/needs-forever'), plugin, { recursive: true });
  const task = join(directory, 'task.json');
  const state = join(workspace, '.codex-supervisor', neutralPaths ? 'task-state' : name, 'state.json');
  const fixture = join(directory, 'host-fixture.json');
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, goal: 'Complete three phases.', acceptance: [{ id: 'A1', text: 'All three phases are independently checked.' }], authorization: 'Local workspace only.', limits: { max_worker_turns: null, max_minutes: null } }));
  writeFileSync(fixture, JSON.stringify({ desktop_version: 'simulated-desktop', cli_version: 'simulated-cli' }));
  const control = join(plugin, 'scripts/main-session.mjs');
  const run = (command: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [control, command, '--state', state, ...extra], { cwd: workspace, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20_000 });
  return { directory, plugin, workspace, task, state, fixture, control, run };
}

function hook(f: ReturnType<typeof setup>, event: Record<string, unknown>, simulated = true) {
  return spawnSync(process.execPath, [join(f.plugin, 'scripts/lifecycle.mjs'), ...(simulated ? ['--test-fixture', f.fixture] : [])], {
    cwd: f.workspace, encoding: 'utf8', timeout: 20_000, input: JSON.stringify({ session_id: 'host-main-session', cwd: f.workspace, turn_id: 'host-turn', model: 'host-model', ...event }),
    env: { ...process.env, PLUGIN_ROOT: f.plugin },
  });
}

test('installed main-session preparation stays pending without native identity despite guessed session environment', () => {
  const f = setup('pending-native-identity');
  const prepared = f.run('prepare', ['--task', f.task], { CODEX_THREAD_ID: 'guessed-session', CODEX_SESSION_ID: 'guessed-session' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const status = f.run('status');
  assert.equal(status.status, 0, status.stderr);
  const value = JSON.parse(status.stdout);
  assert.equal(value.control_mode, 'main-session');
  assert.equal(value.main_session_id, null);
  assert.equal(value.status, 'PAUSED');
  assert.equal(value.binding.status, 'PENDING_NATIVE_HOOK');
  assert.equal(value.host.hook_effective, false);
  assert.equal(value.task_version, 1);
  assert.equal(value.worker_thread_id, null);
  assert.match(value.recovery_condition.message, /native.*hook/i);
  assert.equal(existsSync(`${f.state}.session.json`), false, 'Preparation must not create another worker host.');
});

test('pause while native binding is pending prevents a late binding receipt from activating supervision', () => {
  const f = setup('pause-pending-binding');
  const tool = { tool_use_id: 'prepare-pending', tool_input: { command: `node "${f.control}" prepare --task "${f.task}" --state "${f.state}" --test-fixture "${f.fixture}"` } };
  assert.equal(hook(f, { ...tool, hook_event_name: 'PreToolUse' }).status, 0);
  const prepared = f.run('prepare', ['--task', f.task, '--test-fixture', f.fixture]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(f.run('pause').status, 0);
  try {
    assert.equal(hook(f, { ...tool, hook_event_name: 'PostToolUse', tool_response: prepared.stdout }).status, 0);
    const state = JSON.parse(f.run('status').stdout);
    assert.equal(state.status, 'PAUSED'); assert.equal(state.pause_reason, 'user'); assert.equal(state.live, false);
  } finally { f.run('pause'); }
});

test('concurrent installed preparations in one workspace retain every independent A registration', async (t) => {
  const f = setup('parallel-index');
  const entries = Array.from({ length: 4 }, (_, index) => {
    const task = join(f.directory, `task-${index}.json`); const state = join(f.workspace, '.codex-supervisor', `task-${index}`, 'state.json');
    writeFileSync(task, JSON.stringify({ ...JSON.parse(readFileSync(f.task, 'utf8')), task_id: `task-${index}` }));
    const session_id = `parallel-A-${f.directory}-${index}`;
    const tool = { tool_use_id: `prepare-${index}`, tool_input: { command: `node "${f.control}" prepare --task "${task}" --state "${state}" --test-fixture "${f.fixture}"` } };
    assert.equal(hook(f, { ...tool, session_id, hook_event_name: 'PreToolUse' }).status, 0);
    t.after(() => spawnSync(process.execPath, [f.control, 'pause', '--state', state], { cwd: f.workspace, encoding: 'utf8', timeout: 10_000 }));
    return { task, state, session_id, tool };
  });
  const outputs = await Promise.all(entries.map((entry) => new Promise<string>((done, reject) => {
    const child = spawn(process.execPath, [f.control, 'prepare', '--task', entry.task, '--state', entry.state, '--test-fixture', f.fixture], { cwd: f.workspace, windowsHide: true });
    let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? done(stdout) : reject(new Error(stderr)));
  })));
  for (const [index, entry] of entries.entries()) {
    assert.equal(hook(f, { ...entry.tool, session_id: entry.session_id, hook_event_name: 'PostToolUse', tool_response: outputs[index] }).status, 0);
    const result = spawnSync(process.execPath, [f.control, 'status', '--state', entry.state], { cwd: f.workspace, encoding: 'utf8', timeout: 10_000 });
    const state = JSON.parse(result.stdout); assert.equal(state.main_session_id, entry.session_id); assert.equal(state.live, true);
  }
});

test('binding accepts neutral task filenames and Code Mode tool input without recording unrelated callbacks', (t) => {
  const f = setup('code-mode-binding', true);
  t.after(() => f.run('pause'));
  const unrelated = hook(f, { hook_event_name: 'PreToolUse', tool_use_id: 'ordinary-call', tool_input: { command: 'git status --short' } });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(existsSync(join(f.workspace, '.codex-supervisor')), false, 'Unsupervised ordinary chats must not create observation artifacts.');
  const code = `text(await tools.exec_command(${JSON.stringify({ cmd: `node "${f.control}" prepare --task "${f.task}" --state "${f.state}" --test-fixture "${f.fixture}"` })}));`;
  const tool = { tool_use_id: 'code-call', tool_name: 'functions.exec', tool_input: { code } };
  assert.equal(hook(f, { ...tool, hook_event_name: 'PreToolUse' }).status, 0);
  const prepared = f.run('prepare', ['--task', f.task, '--test-fixture', f.fixture]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(hook(f, { ...tool, hook_event_name: 'PostToolUse', tool_response: { content: [{ text: prepared.stdout }] } }).status, 0);
  assert.equal(JSON.parse(f.run('status').stdout).main_session_id, 'host-main-session');
});

test('structured host callback binds only the matching preparation and keeps fixture evidence simulated', (t) => {
  const f = setup('correlated-native-binding');
  t.after(() => f.run('pause'));
  const command = `node "${f.control}" prepare --task "${f.task}" --state "${f.state}" --test-fixture "${f.fixture}"`;
  const tool = { tool_use_id: 'prepare-tool-call', tool_name: 'Bash', tool_input: { command } };
  const before = hook(f, { ...tool, hook_event_name: 'PreToolUse' });
  assert.equal(before.status, 0, before.stderr);
  const prepared = f.run('prepare', ['--task', f.task, '--test-fixture', f.fixture]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const unrelated = hook(f, { ...tool, tool_use_id: 'different-tool-call', hook_event_name: 'PostToolUse', tool_response: prepared.stdout });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(JSON.parse(f.run('status').stdout).main_session_id, null);
  const bound = hook(f, { ...tool, hook_event_name: 'PostToolUse', tool_response: { stdout: prepared.stdout } });
  assert.equal(bound.status, 0, bound.stderr);
  const state = JSON.parse(f.run('status').stdout);
  assert.equal(state.main_session_id, 'host-main-session');
  assert.equal(state.binding.status, 'BOUND');
  assert.equal(state.host.source, 'simulated');
  assert.equal(state.mode, 'simulated');
  assert.equal(state.host.hook_effective, false, 'A fixture can never establish native hook effectiveness.');
  assert.equal(state.host.desktop_version, 'simulated-desktop');
  assert.equal(state.host.cli_version, 'simulated-cli');
  assert.equal(state.status, 'ACTIVE', 'The correlated callback automatically starts B; its liveness is separate from actual continuation.');
  assert.equal(state.live, true);
});

test('bound Stop callback records distinct attempt identities without subagent recursion or foreign-session activity', (t) => {
  const f = setup('bound-stop-envelope');
  t.after(() => f.run('pause'));
  const tool = { tool_use_id: 'prepare-call', tool_input: { command: `node "${f.control}" prepare --task "${f.task}" --state "${f.state}" --test-fixture "${f.fixture}"` } };
  assert.equal(hook(f, { ...tool, hook_event_name: 'PreToolUse' }).status, 0);
  const prepared = f.run('prepare', ['--task', f.task, '--test-fixture', f.fixture]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(hook(f, { ...tool, hook_event_name: 'PostToolUse', tool_response: prepared.stdout }).status, 0);
  const stop = { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Phase one done. Bearer example-secret-value' };
  assert.deepEqual(JSON.parse(hook(f, { ...stop, agent_id: 'child-agent' }).stdout), {});
  assert.deepEqual(JSON.parse(hook(f, { ...stop, session_id: 'different-session' }).stdout), {});
  assert.equal(JSON.parse(f.run('status').stdout).last_stop, undefined);
  const first = hook(f, stop);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), {}, 'A missing supervisor adapter must retain recovery rather than invent a direction.');
  const initial = JSON.parse(f.run('status').stdout);
  assert.equal(initial.last_stop.session_id, 'host-main-session');
  assert.equal(initial.last_stop.task_id, 'bound-stop-envelope');
  assert.equal(initial.last_stop.task_version, 1);
  assert.equal(initial.last_stop.run_generation, initial.run_generation);
  assert.equal(initial.last_stop.turn_id, 'host-turn');
  assert.equal(initial.last_stop.mode, 'simulated');
  assert.match(initial.last_stop.stop_attempt_id, /^[a-z0-9-]+$/i);
  assert.equal(initial.host.hook_effective, false);
  assert.equal(hook(f, { ...stop, stop_hook_active: true }).status, 0);
  const second = JSON.parse(f.run('status').stdout);
  assert.notEqual(second.last_stop.stop_attempt_id, initial.last_stop.stop_attempt_id, 'A genuine later Stop in the same turn must not be suppressed.');
  assert.equal(second.last_stop.stop_hook_active, true);
  assert.equal(readFileSync(f.state, 'utf8').includes('example-secret-value'), false);
  assert.equal(hook(f, { ...stop, turn_id: undefined }).status, 0, 'Older host payloads need not provide a turn_id.');
  assert.equal(JSON.parse(f.run('status').stdout).last_stop.turn_id, null);
});

test('Windows native hook command resolves the installed package in a path with spaces and Chinese characters', { skip: process.platform !== 'win32' }, () => {
  const f = setup('windows-hook-command');
  const config = JSON.parse(readFileSync(join(f.plugin, 'hooks/hooks.json'), 'utf8'));
  const handler = config.hooks.Stop[0].hooks[0];
  const invoked = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${handler.commandWindows ?? handler.command}"`], {
    windowsVerbatimArguments: true, windowsHide: true, cwd: f.workspace, encoding: 'utf8', timeout: 20_000,
    input: JSON.stringify({ session_id: 'unbound-session', cwd: f.workspace, hook_event_name: 'Stop', stop_hook_active: false }),
    env: { ...process.env, PLUGIN_ROOT: f.plugin },
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.deepEqual(JSON.parse(invoked.stdout), {});
  assert.equal(existsSync(join(f.workspace, '.codex-supervisor')), false);
});
