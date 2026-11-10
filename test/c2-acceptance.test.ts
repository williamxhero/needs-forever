import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('self-contained C2 runtime executes a concrete B0QI alternate and waits only after real route exclusions', () => {
  const directory = resolve('runs/ticket54', `acceptance-${Date.now()}`);
  const result = spawnSync(process.execPath, ['scripts/verify-c2-acceptance.mjs', '--runtime', 'plugins/needs-forever/runtime', '--directory', directory], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(resolve(directory, 'report.json'), 'utf8'));
  assert.equal(report.mode, 'simulated-planner-actual-local-execution');
  assert.equal(report.success.selected_route, 'local-b0qi-artifact');
  assert.deepEqual(report.success.decisions, ['CONTINUE', 'DONE']);
  assert.equal(report.success.verified_rows, 2);
  assert.equal(report.exhausted.before_exclusions_rejected, true);
  assert.equal(report.exhausted.final_action, 'WAIT_EXTERNAL');
  assert.equal(report.repetition.equivalent_third_attempt_rejected, true);
  assert.equal(report.blind_tushare_retry_rejected, true);
});
