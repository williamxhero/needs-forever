import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? `runs/ticket27-demo/${Date.now()}`);
const prepared = spawnSync(process.execPath, [resolve('scripts/prepare-s2-demo.mjs'), directory], { encoding: 'utf8' });
assert.equal(prepared.status, 0, prepared.stderr);
const entry = JSON.parse(prepared.stdout);
const config = resolve(directory, 'scenario.json');
const fixture = resolve(directory, 'fixture.json');
writeFileSync(config, JSON.stringify({ trace: resolve(directory, 'protocol.jsonl'), state_file: entry.state_file, real_judge: true, judge_actions: ['CONTINUE', 'CONTINUE', 'DONE'],
  worker_commands: [[[process.execPath, 'unavailable-route.mjs']]],
  worker_changes: [
    [{ path: 'stage1.json', content: JSON.stringify({ stage: 1, value: 'alpha' }) }],
    [{ path: 'stage2.json', content: JSON.stringify({ stage: 2, value: 'alpha-beta' }) }],
    [{ path: 'final.json', content: JSON.stringify({ stage: 3, value: 'alpha-beta-gamma' }) }],
  ],
  tool_items: [{ type: 'fileChange', id: 'stage-file', status: 'completed', changes: [{ path: 'stage artifact', kind: { type: 'add' }, diff: 'fixture performed this stage' }] }], execute_verification: true, verification_delay_ms: 0,
}));
writeFileSync(fixture, JSON.stringify({ app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), config], real_judge: true }));
const command = [...entry.command, '--test-fixture', fixture];
const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 20000, windowsHide: true });
writeFileSync(resolve(directory, 'console.txt'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
assert.equal(result.status, 0, result.stderr);
const state = JSON.parse(readFileSync(entry.state_file, 'utf8'));
assert.equal(state.status, 'DONE');
assert.equal(state.worker_turn_count, 3);
const events = readFileSync(resolve(directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.deepEqual(events.filter((event) => event.type === 'decision').map((event) => event.decision.action), ['CONTINUE', 'CONTINUE', 'DONE']);
const verification = events.find((event) => event.type === 'verification_result');
assert.equal(verification.passed, true);
assert.match(verification.stdout, /All three independent stage checks PASS/);
const report = { mode: 'simulated', verdict: 'PASS', directory, command, worker_thread_id: state.worker_thread_id, worker_turns: state.worker_turn_count, decisions: ['CONTINUE', 'CONTINUE', 'DONE'], independent_verification: verification, actual_local_subprocesses: 'Deliberately failing route and the protected fixed-argv verifier ran as actual Node subprocesses inside the simulated JSONL boundary.', limits: 'Worker/judge protocol and decisions are simulated; replacement server does not enforce the real Codex sandbox. This does not satisfy live T01-T05.' };
writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ directory, mode: report.mode, verdict: report.verdict, worker_turns: state.worker_turn_count }));
