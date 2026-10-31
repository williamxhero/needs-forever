import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { platform, release } from 'node:os';

// Run npm run build before this entry. Test code drives the real public CLI;
// app-server responses and model decisions are explicitly simulated.
const directory = resolve(process.argv[2] ?? `runs/ticket27-exit/${Date.now()}`);
mkdirSync(directory, { recursive: true });
mkdirSync(resolve('runs/ticket27'), { recursive: true });
const before = new Set(readdirSync(resolve('runs/ticket27')));
const started = new Date().toISOString();
const args = ['--test', '--test-reporter=tap', 'dist/test/cli.test.js', 'dist/test/judge-cli.test.js', 'dist/test/verification-cli.test.js'];
const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, windowsHide: true });
const normalize = (text) => text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n');
writeFileSync(resolve(directory, 'tests.tap'), normalize(result.stdout ?? ''));
writeFileSync(resolve(directory, 'stderr.txt'), normalize(result.stderr ?? ''));
const samples = readdirSync(resolve('runs/ticket27')).filter((entry) => !before.has(entry));
for (const sample of samples) cpSync(resolve('runs/ticket27', sample), resolve(directory, 'samples', sample), { recursive: true });
const report = { mode: 'simulated', codex_version: 'codex-cli 0.166.0 (fixture protocol)', system: `${platform()} ${release()}`, node: process.version, command: [process.execPath, ...args], started_at: started, finished_at: new Date().toISOString(), verdict: result.status === 0 ? 'PASS' : 'FAIL', exit_code: result.status, tests: Number(/# tests (\d+)/.exec(result.stdout ?? '')?.[1] ?? 0), passed: Number(/# pass (\d+)/.exec(result.stdout ?? '')?.[1] ?? 0), samples, live: 'not_run; actual model acceptance T01-T05 is a coordinating S2 gate', coverage: ['S1 regression', '#26 judge regression', 'T04 nonzero repair', 'fixed argv and explicit sandbox', 'protected baseline before worker', 'before/during/missing protection', 'resume keeps baseline and saved argv', 'PAUSED wins', 'actual timeout RPC response', 'hung command owned-server termination and exact idle-worker resume', 'malformed verification result rejected'] };
writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ directory, mode: report.mode, verdict: report.verdict, tests: report.tests, passed: report.passed }));
process.exitCode = result.status === 0 ? 0 : 1;
