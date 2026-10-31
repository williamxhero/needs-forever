import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { platform, release } from 'node:os';

// Run npm run build first; this entry records the public CLI behavior tests.
const directory = resolve(process.argv[2] ?? `runs/ticket26-exit/${Date.now()}`);
mkdirSync(directory, { recursive: true });
mkdirSync(resolve('runs/ticket26'), { recursive: true });
const before = new Set(readdirSync(resolve('runs/ticket26')));
const startedAt = new Date().toISOString();
const args = ['--test', '--test-reporter=tap', 'dist/test/cli.test.js', 'dist/test/judge-cli.test.js'];
const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
writeFileSync(resolve(directory, 'tests.tap'), result.stdout ?? '');
writeFileSync(resolve(directory, 'stderr.txt'), result.stderr ?? '');
const created = readdirSync(resolve('runs/ticket26')).filter((entry) => !before.has(entry));
const samples = created.filter((entry) => ['fresh-judges-', 'bounded-snapshot-', 'external-wait-', 'streamed-items-', 'judge-timeout-', 'pause-real-judge-'].some((prefix) => entry.startsWith(prefix)));
const receipts = [];
for (const sample of samples) {
  const source = resolve('runs/ticket26', sample);
  const target = resolve(directory, sample);
  mkdirSync(resolve(target, 'snapshots'), { recursive: true });
  for (const file of ['state.json', 'events.jsonl', 'summary.md', 'protocol.jsonl']) copyFileSync(resolve(source, file), resolve(target, file));
  for (const file of readdirSync(resolve(source, 'snapshots'))) copyFileSync(resolve(source, 'snapshots', file), resolve(target, 'snapshots', file));
  const state = JSON.parse(readFileSync(resolve(source, 'state.json'), 'utf8'));
  receipts.push({ source, sample: target, status: state.status, phase: state.phase, worker_thread_id: state.worker_thread_id, judge_thread_ids: state.judge_thread_ids, worker_turn_count: state.worker_turn_count });
}
const report = { mode: 'simulated', codex_version: 'codex-cli 0.166.0 (fixture protocol)', os: `${platform()} ${release()}`, node: process.version, command: [process.execPath, ...args], started_at: startedAt, finished_at: new Date().toISOString(), verdict: result.status === 0 ? 'PASS' : 'FAIL', status: result.status, error: result.error?.message ?? null, tests: Number(/# tests (\d+)/.exec(result.stdout ?? '')?.[1] ?? 0), passed: Number(/# pass (\d+)/.exec(result.stdout ?? '')?.[1] ?? 0), samples: receipts, live: 'not_run; S2 live T01-T05 belongs to the coordinating acceptance after tickets #27/#28' };
writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ directory, verdict: report.verdict, tests: report.tests, passed: report.passed }));
process.exitCode = result.status === 0 ? 0 : 1;
