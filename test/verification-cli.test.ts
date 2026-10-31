import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
function scenario(name: string, options: Record<string, unknown> = {}) {
  const directory = resolve('runs/ticket27', `${name}-${Date.now()}`);
  const workspace = resolve(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(resolve(workspace, 'verify.mjs'), "console.log('independent acceptance');\n");
  const trace = resolve(directory, 'protocol.jsonl');
  const task = resolve(directory, 'task.json');
  const state = resolve(directory, 'state.json');
  const config = resolve(directory, 'scenario.json');
  const fixture = resolve(directory, 'fixture.json');
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, goal: 'Complete A1.', acceptance: [{ id: 'A1', text: 'Independent check passes.' }], authorization: 'Local workspace only.', verify: { argv: [process.execPath, 'verify.mjs', 'literal;argument'], timeout_seconds: 2, protected_files: ['verify.mjs'] } }));
  writeFileSync(config, JSON.stringify({ trace, state_file: state, real_judge: true, tool_items: [{ type: 'commandExecution', id: 'check', command: 'check', status: 'completed', exitCode: 0, aggregatedOutput: 'A1 checked.' }], ...options }));
  writeFileSync(fixture, JSON.stringify({ app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), config], real_judge: true }));
  return { directory, workspace, task, state, trace, config, fixture,
    run(command = 'start') { return spawnSync(process.execPath, [resolve('dist/src/cli.js'), command, ...(command === 'start' ? ['--task', task] : []), '--state', state, '--test-fixture', fixture], { encoding: 'utf8', timeout: 20000 }); },
    events() { return readFileSync(resolve(directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)); },
    protocol() { return readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line)); },
  };
}

test('DONE requires the fixed argv independent check in the explicit worker sandbox', () => {
  const fixture = scenario('fixed-argv');
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.state).status, 'DONE');
  const command = fixture.protocol().find((entry) => entry.message?.method === 'command/exec').message.params;
  assert.deepEqual(command.command, [process.execPath, 'verify.mjs', 'literal;argument']);
  assert.equal(command.cwd, fixture.workspace);
  assert.equal(command.timeoutMs, 2000);
  assert.deepEqual(command.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [fixture.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  const verification = fixture.events().find((entry) => entry.type === 'verification_result');
  assert.equal(verification.exitCode, 0);
  assert.equal(verification.passed, true);
  assert.match(verification.stdout, /Fixture late success/);
  const baseline = json(fixture.state).protected_baseline;
  assert.equal(baseline.length, 1);
  assert.match(baseline[0].sha256, /^[a-f0-9]{64}$/);
  const firstSend = fixture.protocol().find((entry) => entry.kind === 'checkpoint_at_send');
  assert.deepEqual(firstSend.state.protected_baseline, baseline);
});

test('T04 nonzero independent output reaches the original worker and only the repaired check can finish', () => {
  const fixture = scenario('nonzero', { verification_results: [{ exitCode: 7, stdout: 'actual failed A1 output', stderr: 'A1 missing result' }, { exitCode: 0, stdout: 'A1 repaired', stderr: '' }] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.state).status, 'DONE');
  assert.equal(json(fixture.state).worker_turn_count, 2);
  const turns = fixture.protocol().filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'worker-from-server');
  assert.match(turns[1].message.params.input[0].text, /actual failed A1 output/);
  assert.match(turns[1].message.params.input[0].text, /A1 missing result/);
  assert.deepEqual(fixture.events().filter((entry) => entry.type === 'verification_result').map((entry) => entry.passed), [false, true]);
});

test('server-side verification timeout returns its actual error to the worker without losing the healthy connection', () => {
  const fixture = scenario('server-timeout', { verification_results: [{ error: { code: -32603, message: 'exec failed: sandbox error: command timed out' } }, { exitCode: 0, stdout: 'A1 repaired', stderr: '' }] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.state).status, 'DONE');
  assert.equal(json(fixture.state).worker_turn_count, 2);
  const turns = fixture.protocol().filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'worker-from-server');
  assert.match(turns[1].message.params.input[0].text, /command timed out/);
  const verification = fixture.events().filter((entry) => entry.type === 'verification_result');
  assert.equal(verification[0].timed_out, true);
  assert.equal(verification[0].exitCode, null);
  assert.equal(fixture.protocol().filter((entry) => entry.message?.method === 'thread/resume').length, 0);
});

test('missing independent stdout or stderr cannot manufacture a successful DONE', () => {
  const fixture = scenario('malformed-result', { verification_results: [{ exitCode: 0 }] });
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.equal(json(fixture.state).phase, 'RECOVERING');
  assert.notEqual(json(fixture.state).status, 'DONE');
  assert.match(result.stderr, /verification response/);
});

test('protected changes before checking refuse DONE and give the original worker exact restoration evidence', () => {
  const original = "console.log('independent acceptance');\n";
  const fixture = scenario('protected-before', { worker_changes: [[{ path: 'verify.mjs', content: 'process.exit(0);' }], [{ path: 'verify.mjs', content: original }]] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.state).status, 'DONE');
  assert.equal(json(fixture.state).worker_turn_count, 2);
  const turns = fixture.protocol().filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'worker-from-server');
  assert.match(turns[1].message.params.input[0].text, /restore/i);
  assert.ok(turns[1].message.params.input[0].text.includes(Buffer.from(original).toString('base64')), 'Worker was not given the original protected content to restore.');
  const results = fixture.events().filter((entry) => entry.type === 'verification_result');
  assert.equal(results[0].passed, false);
  assert.equal(results[0].protected_before.length, 1);
  assert.equal(fixture.protocol().filter((entry) => entry.message?.method === 'command/exec').length, 1, 'Modified verifier was executed.');
});

test('a missing protected verifier is refused until the original worker restores it', () => {
  const fixture = scenario('protected-missing', { worker_changes: [[{ path: 'verify.mjs', remove: true }], [{ path: 'verify.mjs', content: "console.log('independent acceptance');\n" }]] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const failed = fixture.events().find((entry) => entry.type === 'verification_result' && !entry.passed);
  assert.equal(failed.protected_before[0].actual_sha256, null);
  assert.equal(json(fixture.state).status, 'DONE');
  assert.equal(json(fixture.state).worker_turn_count, 2);
});

test('a protected change during a successful check invalidates it and requires restoration before DONE', () => {
  const fixture = scenario('protected-during', { verification_changes: [[{ path: 'verify.mjs', content: 'process.exit(0);' }]], worker_changes: [[], [{ path: 'verify.mjs', content: "console.log('independent acceptance');\n" }]] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const results = fixture.events().filter((entry) => entry.type === 'verification_result');
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[0].protected_before.length, 0);
  assert.equal(results[0].protected_after.length, 1);
  assert.equal(results[0].passed, false);
  assert.equal(results[1].passed, true);
  assert.equal(json(fixture.state).status, 'DONE');
});

test('resume retains the original protected baseline and saved argv after the input file and verifier change', () => {
  const original = "console.log('independent acceptance');\n";
  const fixture = scenario('baseline-resume', { hold_worker: true, pause_after_ms: 30 });
  const paused = fixture.run();
  assert.equal(paused.status, 0, paused.stderr);
  const baseline = json(fixture.state).protected_baseline;
  writeFileSync(resolve(fixture.workspace, 'verify.mjs'), 'process.exit(0);');
  const originalTask = json(fixture.task);
  writeFileSync(fixture.task, JSON.stringify({ ...originalTask, verify: { argv: ['AI-replacement'], timeout_seconds: 1, protected_files: [] } }));
  writeFileSync(fixture.config, JSON.stringify({ ...json(fixture.config), hold_worker: false, pause_after_ms: undefined, resume_turns: [{ id: 'first-turn-from-server', status: 'interrupted', items: [] }], worker_changes: [[], [], [{ path: 'verify.mjs', content: original }]] }));
  const resumed = fixture.run('resume');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(json(fixture.state).protected_baseline, baseline);
  assert.equal(json(fixture.state).status, 'DONE');
  const commands = fixture.protocol().filter((entry) => entry.message?.method === 'command/exec');
  assert.ok(commands.every((entry) => JSON.stringify(entry.message.params.command) === JSON.stringify(originalTask.verify.argv)));
  assert.ok(fixture.events().some((entry) => entry.type === 'verification_result' && entry.protected_before.length === 1 && !entry.passed));
});

test('PAUSED is durable before independent cancellation and a late successful check cannot set DONE', () => {
  const fixture = scenario('pause-independent', { pause_after_ms: 100, verification_delay_ms: 350 });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const state = json(fixture.state);
  assert.equal(state.status, 'PAUSED');
  assert.equal(state.task_version, 2);
  assert.ok(fixture.protocol().some((entry) => entry.message?.method === 'command/exec'));
  assert.ok(fixture.events().some((entry) => entry.type === 'stale_verification_result_ignored'));
  assert.ok(!fixture.events().some((entry) => entry.type === 'verification_result' && entry.passed));
  assert.throws(() => process.kill(fixture.protocol().findLast((entry) => entry.kind === 'spawn').pid, 0));
});

test('a hung independent call ends its owned server and resumes the exact idle worker before sending failure evidence', () => {
  const fixture = scenario('hung-verification', { hold_verification_indices: [0], verification_delay_ms: 0 });
  const task = json(fixture.task);
  task.verify.timeout_seconds = 0.05;
  writeFileSync(fixture.task, JSON.stringify(task));
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.state).status, 'DONE');
  assert.equal(json(fixture.state).worker_turn_count, 2);
  const trace = fixture.protocol();
  const resumed = trace.find((entry) => entry.message?.method === 'thread/resume');
  assert.equal(resumed.message.params.threadId, 'worker-from-server');
  assert.equal(trace.filter((entry) => entry.message?.method === 'thread/start' && entry.message.params.sandbox === 'workspace-write').length, 1);
  const oldServer = trace.find((entry) => entry.message?.method === 'command/exec').pid;
  assert.throws(() => process.kill(oldServer, 0));
  const stopped = fixture.events().findIndex((entry) => entry.type === 'verification_terminated');
  const nextSend = fixture.events().findIndex((entry) => entry.type === 'send_prepared' && entry.source_turn_id !== null);
  assert.ok(stopped >= 0 && nextSend > stopped);
  assert.ok(fixture.events().some((entry) => entry.type === 'verification_result' && entry.timed_out && !entry.passed));
});
