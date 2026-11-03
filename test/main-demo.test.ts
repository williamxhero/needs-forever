import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('prepared Desktop demo uses installed main-session control and preserves a fixed failing acceptance gate', () => {
  const directory = resolve('runs/main-demo', String(Date.now()));
  const plugin = resolve(directory, '插件 安装目录');
  cpSync(resolve('plugins/needs-forever'), plugin, { recursive: true });
  const prepared = spawnSync(process.execPath, ['scripts/prepare-main-session-demo.mjs', '--directory', directory, '--plugin', plugin], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const receipt = JSON.parse(prepared.stdout);
  assert.deepEqual(receipt.command.slice(0, 3), [process.execPath, resolve(plugin, 'scripts/control.mjs'), 'start']);
  assert.equal(receipt.live_desktop_acceptance, 'not_run');
  const task = JSON.parse(readFileSync(receipt.task_file, 'utf8'));
  assert.match(task.goal, /all three stages/);
  const verification = () => spawnSync(task.verify.argv[0], task.verify.argv.slice(1), { cwd: receipt.workspace, encoding: 'utf8' });
  assert.equal(verification().status, 1);
  assert.equal(spawnSync(process.execPath, ['unavailable-route.mjs'], { cwd: receipt.workspace }).status, 23);
  for (const [name, data] of Object.entries({ 'stage1.json': { stage: 1, value: 'alpha' }, 'stage2.json': { stage: 2, value: 'alpha-beta' }, 'final.json': { stage: 3, value: 'alpha-beta-gamma' } })) writeFileSync(resolve(receipt.workspace, name), JSON.stringify(data));
  assert.equal(verification().status, 0);
  const started = spawnSync(receipt.command[0], receipt.command.slice(1), { cwd: receipt.workspace, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).control_mode, 'main-session');
  assert.equal(JSON.parse(started.stdout).binding.status, 'PENDING_NATIVE_HOOK');
});
