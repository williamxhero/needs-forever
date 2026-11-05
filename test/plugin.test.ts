import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const source = resolve('plugins/needs-forever');
function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
function setup(name: string, options: Record<string, unknown> = {}) {
  const directory = resolve('runs/plugin', `${name}-${Date.now()}`);
  const plugin = join(directory, '插件 安装目录');
  const workspace = join(directory, '任务 空间');
  mkdirSync(workspace, { recursive: true });
  cpSync(source, plugin, { recursive: true });
  const state = join(directory, 'state.json');
  const task = join(directory, 'task.json');
  const fixture = join(directory, 'fixture.json');
  const scenario = join(directory, 'scenario.json');
  const trace = join(directory, 'protocol.jsonl');
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, goal: 'Complete the local result.', acceptance: [{ id: 'A1', text: 'The result is checked.' }], authorization: 'Only this local workspace.', limits: { max_worker_turns: null, max_minutes: null } }));
  writeFileSync(scenario, JSON.stringify({ trace, state_file: state, ...options }));
  writeFileSync(fixture, JSON.stringify({ app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), scenario], judge: { action: 'DONE', reason: 'Fixture acceptance.', evidence_ids: ['E1'], next_message: '', external: null }, recovery_enabled: true, recovery_delays_ms: [0] }));
  const control = join(plugin, 'scripts/control.mjs');
  const run = (command: string, extra: string[] = []) => spawnSync(process.execPath, [control, command, '--state', state, ...extra], { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
  return { directory, plugin, workspace, state, task, fixture, scenario, trace, run,
    start() { return run('start', ['--control-mode', 'independent-worker', '--task', task, '--test-fixture', fixture]); },
    resume() { return run('resume', ['--test-fixture', fixture]); },
  };
}
async function until(condition: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) { if (condition()) return; await delay(100); }
  assert.fail(message);
}

test('plugin ships the exact executable core and resolves all marketplace/skill resources locally', () => {
  const manifest = json(join(source, 'package.json'));
  const legacy = json(join(source, '.codex-plugin/plugin.json'));
  const market = json('.agents/plugins/marketplace.json');
  assert.equal(existsSync(join(source, 'plugin.json')), false, 'The AgentPlugin format suppresses hooks in supported Desktop 0.159.');
  assert.equal(legacy.name, 'needs-forever');
  assert.equal(manifest.version, legacy.version);
  assert.equal(manifest.version, json('package.json').version);
  assert.equal(manifest.version, json('package-lock.json').version);
  assert.equal(manifest.version, json('package-lock.json').packages[''].version);
  assert.equal(resolve(market.plugins[0].source.path), source);
  assert.ok(existsSync(join(source, 'skills/supervise/SKILL.md')));
  for (const [path, hash] of Object.entries(json(join(source, 'runtime/integrity.json')).files)) {
    const contents = readFileSync(join(source, 'runtime', path), 'utf8');
    assert.equal(createHash('sha256').update(contents).digest('hex'), hash);
    assert.equal(contents, readFileSync(resolve('dist', path), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
  }
});

test('installed copy starts in background, pauses durably, resumes the original worker, then completes', async () => {
  const fixture = setup('plugin-pause-resume', { hold_worker: true });
  try {
    const started = fixture.start();
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).launched, true);
    await until(() => existsSync(fixture.state) && json(fixture.state).active_worker_turn_id !== null, 'Worker never started.');
    const threadId = json(fixture.state).worker_thread_id;
    const queried = fixture.run('status');
    assert.equal(queried.status, 0, queried.stderr);
    assert.equal(JSON.parse(queried.stdout).live, true);
    const duplicate = fixture.resume();
    assert.equal(duplicate.status, 1, duplicate.stdout);
    assert.match(duplicate.stderr, /live plugin supervisor/);
    const paused = fixture.run('pause');
    assert.equal(paused.status, 0, paused.stderr);
    assert.equal(JSON.parse(paused.stdout).paused, true);
    assert.equal(json(fixture.state).status, 'PAUSED');
    await until(() => !existsSync(`${fixture.state}.plugin.lock`), 'Plugin lease did not release.');
    const scenario = json(fixture.scenario);
    scenario.hold_worker = false;
    scenario.resume_turns = [{ id: json(fixture.state).active_worker_turn_id, status: 'completed', items: [] }];
    writeFileSync(fixture.scenario, JSON.stringify(scenario));
    const resumed = fixture.resume();
    assert.equal(resumed.status, 0, resumed.stderr);
    await until(() => json(fixture.state).status === 'DONE', 'Resumed worker never completed.');
    assert.equal(json(fixture.state).worker_thread_id, threadId);
    await until(() => json(`${fixture.state}.session.json`).lifecycle === 'exited', 'Host never exited.');
    const final = JSON.parse(fixture.run('status').stdout);
    assert.equal(final.live, false);
    assert.equal(final.recovery_required, false);
    assert.equal(fixture.resume().status, 1, 'DONE must not reopen.');
    const requests = readFileSync(fixture.trace, 'utf8').split('\n').filter((line) => line.includes('"method":"turn/start"'));
    assert.equal(requests.length, 1, 'History completion must not resend work.');
  } finally {
    if (existsSync(fixture.state) && json(fixture.state).status === 'ACTIVE') fixture.run('pause');
  }
});

test('plugin reports failed startup and status never launches a worker', async () => {
  const fixture = setup('plugin-startup-failure');
  const invalid = json(fixture.task); invalid.acceptance = [];
  writeFileSync(fixture.task, JSON.stringify(invalid));
  const result = fixture.start();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /startup failed/);
  assert.equal(existsSync(fixture.trace), false);
  assert.equal(existsSync(fixture.state), false);
  assert.equal(fixture.run('status').status, 1);
  assert.equal(existsSync(fixture.trace), false);
});

test('status distinguishes an orphaned ACTIVE checkpoint from a live supervisor without changing it', () => {
  const fixture = setup('plugin-stale-session');
  const saved = { schema_version: 1, status: 'ACTIVE', phase: 'RECOVERING', task: json(fixture.task), task_version: 3, worker_thread_id: 'saved-worker', retry: { kind: 'network', attempt: 1, next_at: null } };
  writeFileSync(fixture.state, JSON.stringify(saved));
  writeFileSync(`${fixture.state}.session.json`, JSON.stringify({ lifecycle: 'exited', session_id: 'old-session' }));
  const before = readFileSync(fixture.state, 'utf8');
  const result = fixture.run('status');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).live, false);
  assert.equal(JSON.parse(result.stdout).recovery_required, true);
  assert.equal(readFileSync(fixture.state, 'utf8'), before);
  const paused = fixture.run('pause');
  assert.equal(paused.status, 1);
  assert.match(paused.stderr, /No live plugin control handle/);
  assert.equal(readFileSync(fixture.state, 'utf8'), before);
  assert.equal(existsSync(fixture.trace), false);
});
