import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('isolated installed-package discovery reports untrusted hooks without claiming native effectiveness', () => {
  const directory = resolve('runs/install-discovery', String(Date.now()));
  const candidate = resolve(directory, 'candidate');
  mkdirSync(candidate, { recursive: true });
  cpSync('.agents', resolve(candidate, '.agents'), { recursive: true });
  cpSync('plugins/needs-forever', resolve(candidate, 'plugins/needs-forever'), { recursive: true });
  const report = resolve(directory, 'probe');
  const run = spawnSync(process.execPath, ['scripts/verify-plugin-install.mjs', '--candidate', candidate, '--directory', report, '--codex-argv', JSON.stringify([process.execPath, resolve('test/fixtures/install-host.mjs')])], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  const evidence = JSON.parse(readFileSync(resolve(report, 'install.json'), 'utf8'));
  assert.equal(evidence.discovery_pass, true);
  assert.equal(evidence.native_effectiveness, 'not_run');
  assert.equal(evidence.human_trust_required, true);
  assert.equal(evidence.hooks.length, 6);
  assert.equal(evidence.package_matches_candidate, true);
  assert.equal(evidence.initialize.codexHome, resolve(report, 'codex-home'));
});
