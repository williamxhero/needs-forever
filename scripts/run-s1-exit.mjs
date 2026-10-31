import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { platform, release } from 'node:os';

const directory = resolve(process.argv[2] ?? `runs/ticket25/exit-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const normalized = (value) => `${value.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trimEnd()}\n`;
const save = (name, value) => writeFileSync(resolve(directory, name), normalized(value), 'utf8');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', resolve('dist/test/cli.test.js')], { encoding: 'utf8', timeout: 120000, windowsHide: true });
save('tests.stdout.txt', result.stdout ?? '');
save('tests.stderr.txt', result.stderr ?? '');
const passed = [...(result.stdout ?? '').matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1]);
const checks = {
  T01: ['two early finishes'], T02: ['two early finishes'], T05: ['two early finishes', 'explicit resume uses'],
  T07: ['started/completed before response', 'a late failure for an already confirmed', 'T08 simulated delayed judge'],
  T08: ['T08 simulated worker', 'T08 simulated delayed judge', 'T08 simulated verification'],
  T14: ['cumulative turn limit', 'ACTIVE time is checkpointed'],
  status_and_task: ['start preserves the task'], task_lock: ['a second CLI'],
  original_worker_resume: ['explicit resume uses', 'resume reviews the saved'],
  prepared_before_send: ['two early finishes'], unknown_send_guard: ['unknown turn/start outcome', 'explicit resume preserves an unknown'],
  cumulative_crash_checkpoint: ['explicit resume reclaims'],
};
const report = {
  mode: 'simulated', created_at: new Date().toISOString(), codex_protocol_baseline: 'codex-cli 0.166.0',
  platform: { os: platform(), release: release(), node: process.version },
  command: [process.execPath, '--test', '--test-reporter=tap', resolve('dist/test/cli.test.js')],
  exit_code: result.status, passed_tests: passed.length,
  checks: Object.fromEntries(Object.entries(checks).map(([name, prefixes]) => [name, { mode: 'simulated', result: result.status === 0 && prefixes.every((prefix) => passed.some((name_) => name_.startsWith(prefix))) ? 'PASS' : 'FAIL', tests: passed.filter((name_) => prefixes.some((prefix) => name_.startsWith(prefix))) }])),
  later_scope: Object.fromEntries(['T03', 'T04', 'T06', 'T09', 'T10', 'T11', 'T12_full_history_reconciliation', 'T13', 'T15', 'S2_live_judge', 'S2_protected_verification', 'S3_recovery', 'main_merge_cleanup_push_and_issue_closure'].map((name) => [name, 'not_run'])),
  samples: [],
};
const sourceRoot = resolve('runs/ticket23');
for (const prefix of ['continue-twice-', 'pause-worker-', 'pause-judge-', 'pause-verification-', 'crash-resume-', 'unknown-resume-']) {
  const run = readdirSync(sourceRoot).filter((name) => name.startsWith(prefix)).sort().at(-1);
  if (!run) throw new Error(`Missing actual CLI run ${prefix}.`);
  const source = resolve(sourceRoot, run);
  const target = resolve(directory, prefix.slice(0, -1));
  mkdirSync(target, { recursive: true });
  for (const name of ['state.json', 'events.jsonl', 'summary.md', 'protocol.jsonl', 'task.json', 'scenario.json', 'fixture.json']) {
    writeFileSync(resolve(target, name), normalized(readFileSync(resolve(source, name), 'utf8')), 'utf8');
  }
  const snapshots = resolve(source, 'snapshots');
  try {
    mkdirSync(resolve(target, 'snapshots'), { recursive: true });
    for (const file of readdirSync(snapshots)) if (statSync(resolve(snapshots, file)).isFile()) writeFileSync(resolve(target, 'snapshots', file), normalized(readFileSync(resolve(snapshots, file), 'utf8')), 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = JSON.parse(readFileSync(resolve(target, 'state.json'), 'utf8'));
  report.samples.push({ path: relative(directory, target), original_run: source, task_id: state.task_id, worker_thread_id: state.worker_thread_id, status: state.status, phase: state.phase, worker_turn_count: state.worker_turn_count });
}
save('report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ evidence_directory: directory, exit_code: result.status, passed_tests: passed.length, checks: report.checks }, null, 2));
if (result.status !== 0 || Object.values(report.checks).some((check) => check.result !== 'PASS')) process.exitCode = 1;
