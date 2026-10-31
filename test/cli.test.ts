import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cli = resolve('dist/src/cli.js');
const server = resolve('test/fixtures/app-server.mjs');
function run(argv: string[]) {
  return spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', timeout: 15_000 });
}
function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
function snapshotFile(directory: string): string {
  const snapshots = resolve(directory, 'snapshots');
  const files = readdirSync(snapshots);
  assert.equal(files.length, 1);
  return resolve(snapshots, files[0]!);
}

function setup(name: string, options: Record<string, unknown> = {}) {
  const directory = resolve('runs/ticket23', `${name}-${Date.now()}`);
  const workspace = resolve(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const trace = resolve(directory, 'protocol.jsonl');
  const scenario = resolve(directory, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ trace, ...options }));
  const fixture = resolve(directory, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ app_server_argv: [process.execPath, server, scenario], judge: { action: 'WAIT_EXTERNAL', reason: 'Fixture external dependency.', evidence_ids: ['E1'], next_message: '', external: { missing: 'Fixture input.', attempted: ['Known route.'], why_no_other_work: 'No other fixture work.', resume_when: 'Input available.' } } }));
  const taskFile = resolve(directory, 'task.json');
  writeFileSync(taskFile, JSON.stringify({ schema_version: 1, task_id: name, workspace, goal: 'Complete the goal.', acceptance: [{ id: 'A1', text: 'Accepted result.' }], authorization: 'Local work only.' }));
  const stateFile = resolve(directory, 'state.json');
  return { directory, workspace, trace, scenario, fixture, taskFile, stateFile, argv: ['start', '--task', taskFile, '--state', stateFile, '--test-fixture', fixture] };
}

test('server requests preserve string ids and receive deterministic refusals', () => {
  const fixture = setup(`server-requests-${Date.now()}`, { server_requests: [
    { id: 'approval-string-id', method: 'item/commandExecution/requestApproval', params: { approvalId: 'approval-1' } },
    { id: 73, method: 'item/permissions/requestApproval', params: {} },
    { id: 'input-id', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', options: [{ label: 'first', description: 'first' }, { label: 'second', description: 'second' }] }] } },
  ] });
  const result = run(fixture.argv);
  assert.equal(result.status, 0, result.stderr);
  const responses = readFileSync(fixture.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line).message).filter((message) => message && !message.method && ('result' in message));
  assert.ok(responses.some((message) => message.id === 'approval-string-id' && message.result.decision === 'decline'));
  assert.ok(responses.some((message) => message.id === 73 && message.result.scope === 'turn' && Object.keys(message.result.permissions).length === 0));
  assert.ok(responses.some((message) => message.id === 'input-id' && message.result.answers.choice.answers[0] === 'first'));
});

test('start preserves the task and server identities; status reads WAIT_EXTERNAL without launching a server', () => {
  const directory = resolve('runs/ticket23', `initial-${Date.now()}`);
  const workspace = resolve(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const task = { schema_version: 1, task_id: 'fixture-initial', workspace, goal: 'Complete all original stages.', acceptance: [{ id: 'A1', text: 'All stages exist.' }], authorization: 'Only local workspace changes.' };
  const trace = resolve(directory, 'protocol.jsonl');
  const scenario = resolve(directory, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ trace }));
  const fixture = resolve(directory, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ app_server_argv: [process.execPath, server, scenario], judge: { action: 'WAIT_EXTERNAL', reason: 'Fixture external dependency.', evidence_ids: ['E1'], next_message: '', external: { missing: 'Fixture supplied input.', attempted: ['Fixture supplied route.'], why_no_other_work: 'All other fixture work is exhausted.', resume_when: 'Fixture input arrives.' } } }));
  const taskFile = resolve(directory, 'task.json');
  writeFileSync(taskFile, JSON.stringify(task));
  const stateFile = resolve(directory, 'state.json');
  const started = run(['start', '--task', taskFile, '--state', stateFile, '--test-fixture', fixture]);
  assert.equal(started.status, 0, started.stderr);
  const state = json(stateFile);
  assert.equal(state.status, 'WAIT_EXTERNAL');
  assert.equal(state.phase, 'IDLE');
  assert.deepEqual(state.task, { ...task, limits: { max_worker_turns: null, max_minutes: null } });
  assert.equal(state.worker_thread_id, 'worker-from-server');
  assert.equal(state.worker_turn_count, 1);
  assert.equal(state.codex_version, 'codex-cli 0.166.0');
  assert.equal(state.mode, 'simulated');
  assert.deepEqual(state.handled_turn_ids, ['first-turn-from-server']);
  const events = readFileSync(resolve(directory, 'events.jsonl'), 'utf8');
  assert.match(events, /"turn_id":"first-turn-from-server"/);
  assert.match(readFileSync(resolve(directory, 'summary.md'), 'utf8'), /Fixture supplied input/);
  assert.match(readFileSync(snapshotFile(directory), 'utf8'), /Complete all original stages/);
  const before = readFileSync(trace, 'utf8');
  const messages = before.trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.kind === 'request');
  for (const pid of new Set(messages.map((event) => event.pid))) {
    const connection = messages.filter((event) => event.pid === pid);
    assert.equal(connection[0].message.method, 'initialize');
    assert.equal(connection[1].message.method, 'initialized');
    const ids = connection.filter((event) => 'id' in event.message).map((event) => event.message.id);
    assert.equal(new Set(ids).size, ids.length, 'Request IDs must be unique within a connection.');
  }
  const status = run(['status', '--state', stateFile]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, 'WAIT_EXTERNAL');
  assert.equal(readFileSync(trace, 'utf8'), before);
});

test('start rejects a server policy granting writes outside the configured workspace before running a turn', () => {
  const fixture = setup('unsafe-policy', { sandbox: { type: 'workspaceWrite', writableRoots: [resolve('runs')], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
  const started = run(fixture.argv);
  assert.equal(started.status, 1, 'An expanded writable root must fail startup.');
  assert.match(started.stderr, /policy verification failed/);
  assert.equal(json(fixture.stateFile).worker_turn_count, 0);
  assert.doesNotMatch(readFileSync(fixture.trace, 'utf8'), /"method":"turn\/start"/);
});

test('a second CLI cannot supervise the same task through another state file', async () => {
  const fixture = setup('exclusive-task', { hold_worker: true });
  const first = spawn(process.execPath, [cli, ...fixture.argv], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let firstError = '';
  first.stderr.on('data', (chunk) => { firstError += chunk.toString(); });
  const exited = once(first, 'exit');
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      try { if (json(fixture.stateFile).active_worker_turn_id) break; } catch {}
      assert.ok(Date.now() < deadline && first.exitCode === null, firstError || 'First CLI did not start a worker.');
      await delay(20);
    }
    const alternative = resolve(fixture.directory, 'alternative', 'state.json');
    const argv = fixture.argv.map((value) => value === fixture.stateFile ? alternative : value);
    const second = run(argv);
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /supervisor lock/);
  } finally {
    first.kill('SIGKILL');
    await exited;
    // Ticket #25 owns Ctrl+C and graceful lifecycle. Clean the exact fixture PIDs after force-killing this test process.
    for (const line of readFileSync(fixture.trace, 'utf8').trim().split('\n')) {
      const event = JSON.parse(line);
      if (event.kind === 'spawn') { try { process.kill(event.pid, 'SIGKILL'); } catch {} }
    }
  }
});

test('credential-shaped tool output is redacted before becoming a saved judge input', () => {
  const secret = 'sk-supervisor-fixture-secret-1234567890';
  const fixture = setup('secret-output', { answer: `A command accidentally printed ${secret}. Authorization: Bearer fixture-private-token-12345` });
  const started = run(fixture.argv);
  assert.equal(started.status, 0, started.stderr);
  const snapshot = readFileSync(snapshotFile(fixture.directory), 'utf8');
  assert.ok(!snapshot.includes(secret), 'Saved judge input must not contain an API token.');
  assert.ok(!snapshot.includes('fixture-private-token-12345'), 'Bearer credentials must be removed.');
  assert.match(snapshot, /REDACTED/);
});

test('inherited MCP names are disabled before creating any worker, including names with dots or quotes', () => {
  const fixture = setup('mcp-isolation', { mcp_servers: ['legacy.server', 'quotes"name'] });
  const started = run(fixture.argv);
  assert.equal(started.status, 0, started.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'WAIT_EXTERNAL');
  const trace = readFileSync(fixture.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const workerRequest = trace.find((event) => event.kind === 'request' && event.message.method === 'thread/start');
  assert.ok(workerRequest, 'Isolated app-server must actually create a worker.');
  const events = readFileSync(resolve(fixture.directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.find((event) => event.type === 'connection_verified').disabled_mcp, ['legacy.server', 'quotes"name']);
});

test('the foreground CLI displays the worker reply and the supervisor waiting reason', () => {
  const fixture = setup('foreground-output', { answer: 'Worker produced the first stage artifact.' });
  const started = run(fixture.argv);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /Worker produced the first stage artifact/);
  assert.match(started.stdout, /WAIT_EXTERNAL: Fixture input/);
});

test('server-provided turn identities cannot place snapshot evidence outside the snapshot directory', () => {
  const fixture = setup('snapshot-path', { turn_id: '../escaped' });
  const started = run(fixture.argv);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(existsSync(resolve(fixture.directory, 'escaped.json')), false);
  const files = readdirSync(resolve(fixture.directory, 'snapshots'));
  assert.equal(files.length, 1);
  assert.equal(json(resolve(fixture.directory, 'snapshots', files[0]!)).input.worker_turn_id, '../escaped');
});

test('two early finishes continue the same worker then persist stable simulated DONE with prepared deliveries', () => {
  const fixture = setup('continue-twice');
  const scenario = json(fixture.scenario);
  writeFileSync(fixture.scenario, JSON.stringify({ ...scenario, state_file: fixture.stateFile }));
  const config = json(fixture.fixture);
  config.judge = [
    { action: 'CONTINUE', reason: 'Stage two remains.', evidence_ids: ['E1'], next_message: 'Build stage two.', external: null },
    { action: 'CONTINUE', reason: 'Stage three remains.', evidence_ids: ['E1'], next_message: 'Build stage three.', external: null },
    { action: 'DONE', reason: 'All fixture stages are complete.', evidence_ids: ['E1'], next_message: '', external: null },
  ];
  writeFileSync(fixture.fixture, JSON.stringify(config));
  const started = run(fixture.argv);
  assert.equal(started.status, 0, started.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'DONE');
  assert.equal(state.worker_turn_count, 3);
  assert.deepEqual(state.handled_turn_ids, ['first-turn-from-server', 'turn-2-from-server', 'turn-3-from-server']);
  const trace = readFileSync(fixture.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const sends = trace.filter((entry) => entry.kind === 'request' && entry.message.method === 'turn/start');
  assert.equal(sends.length, 3);
  assert.ok(sends.every((entry) => entry.message.params.threadId === 'worker-from-server'));
  const saved = trace.filter((entry) => entry.kind === 'checkpoint_at_send').map((entry) => entry.state);
  assert.equal(saved.length, 3);
  saved.forEach((checkpoint, index) => {
    const pending = checkpoint.pending_action;
    assert.equal(pending.stage, 'sent');
    assert.equal(pending.target_turn_id, null);
    assert.equal(pending.message, sends[index].message.params.input[0].text);
    assert.match(pending.message, new RegExp(pending.delivery_id));
  });
  const events = readFileSync(resolve(fixture.directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((entry) => entry.type === 'send_confirmed').length, 3);
  assert.equal(readdirSync(resolve(fixture.directory, 'snapshots')).length, 3);
});

test('a correlated started turn progresses to DONE even when turn/start never returns a response', () => {
  const fixture = setup('started-without-response', { response_order: 'missing' });
  const config = json(fixture.fixture);
  config.judge = { action: 'DONE', reason: 'Fixed fixture acceptance.', evidence_ids: ['E1'], next_message: '', external: null };
  writeFileSync(fixture.fixture, JSON.stringify(config));
  const started = run(fixture.argv);
  assert.equal(started.status, 0, started.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'DONE');
  assert.equal(state.worker_turn_count, 1);
});

test('started/completed before response and duplicate/foreign/stale events cannot add work', () => {
  const fixture = setup('reordered-duplicates', { response_order: 'after-completed', duplicate_events: true });
  const config = json(fixture.fixture);
  config.judge = [
    { action: 'CONTINUE', reason: 'Another stage remains.', evidence_ids: ['E1'], next_message: 'Finish the next stage.', external: null },
    { action: 'DONE', reason: 'Fixed fixture complete.', evidence_ids: ['E1'], next_message: '', external: null },
  ];
  writeFileSync(fixture.fixture, JSON.stringify(config));
  const started = run(fixture.argv);
  assert.equal(started.status, 0, started.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'DONE');
  assert.equal(state.worker_turn_count, 2);
  assert.deepEqual(state.handled_turn_ids, ['first-turn-from-server', 'turn-2-from-server']);
  const events = readFileSync(resolve(fixture.directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const confirmed = events.filter((entry) => entry.type === 'send_confirmed');
  assert.deepEqual(confirmed.map((entry) => entry.turn_id), ['first-turn-from-server', 'turn-2-from-server']);
  assert.ok(confirmed.every((entry) => entry.via === 'started+clientId'));
  assert.equal(events.filter((entry) => entry.type === 'decision').length, 2);
  assert.equal(readdirSync(resolve(fixture.directory, 'snapshots')).length, 2);
  const before = readFileSync(fixture.trace, 'utf8');
  assert.equal(run(['status', '--state', fixture.stateFile]).status, 0);
  assert.equal(readFileSync(fixture.trace, 'utf8'), before);
});

test('unknown turn/start outcome preserves the sent delivery in RECOVERING without resending', () => {
  const fixture = setup('unknown-delivery', { disconnect_on_send: true });
  const started = run(fixture.argv);
  assert.equal(started.status, 1);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'ACTIVE');
  assert.equal(state.phase, 'RECOVERING');
  assert.equal(state.worker_turn_count, 0);
  assert.equal(state.pending_action.stage, 'sent');
  assert.equal(state.pending_action.target_turn_id, null);
  const trace = readFileSync(fixture.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.filter((entry) => entry.kind === 'request' && entry.message.method === 'turn/start').length, 1);
  const events = readFileSync(resolve(fixture.directory, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, /"type":"send_confirmed"/);
  assert.match(events, /No resend performed until connection and delivery history reconciliation completes/);
});

test('failed worker terminal never reaches the fixed DONE judge', () => {
  const fixture = setup('failed-terminal', { terminal_status: 'failed' });
  const config = json(fixture.fixture);
  config.judge = { action: 'DONE', reason: 'Must not be used.', evidence_ids: ['E1'], next_message: '', external: null };
  writeFileSync(fixture.fixture, JSON.stringify(config));
  const started = run(fixture.argv);
  assert.equal(started.status, 1);
  assert.match(started.stderr, /Worker turn .* failed/);
  assert.equal(json(fixture.stateFile).phase, 'RECOVERING');
  assert.equal(json(fixture.stateFile).last_decision, null);
  assert.equal(existsSync(resolve(fixture.directory, 'snapshots')), false);
});

test('a late failure for an already confirmed old delivery cannot cancel the next worker', () => {
  const fixture = setup('obsolete-response', { late_error_first: true });
  const config = json(fixture.fixture);
  config.judge = [
    { action: 'CONTINUE', reason: 'Next fixture stage remains.', evidence_ids: ['E1'], next_message: 'Build next stage.', external: null },
    { action: 'DONE', reason: 'Fixed fixture complete.', evidence_ids: ['E1'], next_message: '', external: null },
  ];
  writeFileSync(fixture.fixture, JSON.stringify(config));
  const started = run(fixture.argv);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(json(fixture.stateFile).status, 'DONE');
  assert.equal(json(fixture.stateFile).worker_turn_count, 2);
});

test('judge input is saved while its result is pending and duplicate terminal events do not start another judge', async () => {
  const fixture = setup('pending-judge', { duplicate_events: true });
  const config = json(fixture.fixture);
  config.judge_delay_ms = 500;
  config.judge = { action: 'DONE', reason: 'Fixed fixture complete.', evidence_ids: ['E1'], next_message: '', external: null };
  writeFileSync(fixture.fixture, JSON.stringify(config));
  const child = spawn(process.execPath, [cli, ...fixture.argv], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        const state = json(fixture.stateFile);
        const input = json(snapshotFile(fixture.directory));
        if (state.phase === 'JUDGE' && input.raw_output === null) {
          assert.equal(input.validation, 'pending');
          assert.equal(input.input.worker_turn_id, state.reviewing_turn_id);
          break;
        }
      } catch {}
      assert.ok(Date.now() < deadline && child.exitCode === null, stderr || 'Judge did not expose its saved input.');
      await delay(10);
    }
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(json(fixture.stateFile).status, 'DONE');
    assert.equal(readdirSync(resolve(fixture.directory, 'snapshots')).length, 1);
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } }
});

test('T08 simulated worker pause is saved before interrupting its owned turn', () => {
  const fixture = setup('pause-worker', { hold_worker: true, pause_after_ms: 80 });
  writeFileSync(fixture.scenario, JSON.stringify({ ...json(fixture.scenario), state_file: fixture.stateFile }));
  const result = run(fixture.argv);
  assert.equal(result.status, 0, result.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'PAUSED');
  assert.equal(state.task_version, 2);
  assert.equal(state.pause_reason, 'user');
  assert.equal(state.pending_action, null);
  assert.equal(state.retry.next_at, null);
  assert.ok(state.elapsed_active_seconds > 0);
  const trace = readFileSync(fixture.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.find((entry) => entry.kind === 'checkpoint_at_interrupt').state.status, 'PAUSED');
});

test('T08 simulated delayed judge success cannot overwrite durable PAUSED', () => {
  const fixture = setup('pause-judge', { pause_after_ms: 80 });
  writeFileSync(fixture.fixture, JSON.stringify({ ...json(fixture.fixture), judge_delay_ms: 250, judge_ignores_cancellation: true, judge: { action: 'DONE', reason: 'Late fixture success.', evidence_ids: ['E1'], next_message: '', external: null } }));
  const result = run(fixture.argv);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.stateFile).status, 'PAUSED');
  assert.equal(json(fixture.stateFile).last_decision, null);
  assert.match(readFileSync(resolve(fixture.directory, 'events.jsonl'), 'utf8'), /stale_judge_result_ignored/);
});

test('T08 simulated verification is interrupted after PAUSED and cannot mark DONE', () => {
  const fixture = setup('pause-verification', { pause_after_ms: 100, verification_delay_ms: 300 });
  writeFileSync(fixture.taskFile, JSON.stringify({ ...json(fixture.taskFile), verify: { argv: ['fixture-verification'], timeout_seconds: 10, protected_files: [] } }));
  writeFileSync(fixture.fixture, JSON.stringify({ ...json(fixture.fixture), simulate_verification: true, judge: { action: 'DONE', reason: 'Fixed fixture success.', evidence_ids: ['E1'], next_message: '', external: null } }));
  const result = run(fixture.argv);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.stateFile).status, 'PAUSED');
  const events = readFileSync(resolve(fixture.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /fixture_verification_started/);
  assert.match(events, /stale_verification_result_ignored/);
  assert.doesNotMatch(events, /verification_passed/);
});

test('explicit resume uses saved task and worker identity, and DONE cannot reopen', () => {
  const fixture = setup('explicit-resume');
  assert.equal(run(fixture.argv).status, 0);
  writeFileSync(fixture.taskFile, JSON.stringify({ ...json(fixture.taskFile), goal: 'Unapproved changed file.' }));
  writeFileSync(fixture.scenario, JSON.stringify({ ...json(fixture.scenario), turn_id: 'resumed-turn' }));
  writeFileSync(fixture.fixture, JSON.stringify({ ...json(fixture.fixture), judge: { action: 'DONE', reason: 'Fixed fixture complete.', evidence_ids: ['E1'], next_message: '', external: null } }));
  const argv = ['resume', '--state', fixture.stateFile, '--test-fixture', fixture.fixture];
  const resumed = run(argv);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'DONE');
  assert.equal(state.task_version, 2);
  assert.equal(state.task.goal, 'Complete the goal.');
  assert.equal(state.worker_turn_count, 2);
  const trace = readFileSync(fixture.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.filter((entry) => entry.message?.method === 'thread/start').length, 1);
  assert.equal(trace.find((entry) => entry.message?.method === 'thread/resume').message.params.threadId, 'worker-from-server');
  const before = readFileSync(fixture.trace, 'utf8');
  assert.equal(run(argv).status, 1);
  assert.equal(readFileSync(fixture.trace, 'utf8'), before);
});

test('cumulative turn limit pauses before another send and resume requires an increased or removed limit', () => {
  const fixture = setup('turn-limit');
  writeFileSync(fixture.taskFile, JSON.stringify({ ...json(fixture.taskFile), limits: { max_worker_turns: 1, max_minutes: null } }));
  writeFileSync(fixture.fixture, JSON.stringify({ ...json(fixture.fixture), judge: { action: 'CONTINUE', reason: 'More authorized work.', evidence_ids: ['E1'], next_message: 'Finish next stage.', external: null } }));
  const result = run(fixture.argv);
  assert.equal(result.status, 0, result.stderr);
  const paused = json(fixture.stateFile);
  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.pause_reason, 'user_limit');
  assert.equal(paused.worker_turn_count, 1);
  const argv = ['resume', '--state', fixture.stateFile, '--test-fixture', fixture.fixture];
  const before = readFileSync(fixture.trace, 'utf8');
  assert.equal(run(argv).status, 1);
  assert.equal(readFileSync(fixture.trace, 'utf8'), before);
  writeFileSync(fixture.taskFile, JSON.stringify({ ...json(fixture.taskFile), limits: { max_worker_turns: 2, max_minutes: null } }));
  writeFileSync(fixture.fixture, JSON.stringify({ ...json(fixture.fixture), judge: { action: 'DONE', reason: 'Fixture done.', evidence_ids: ['E1'], next_message: '', external: null } }));
  writeFileSync(fixture.scenario, JSON.stringify({ ...json(fixture.scenario), turn_id: 'after-limit-turn' }));
  const resumed = run([...argv, '--task', fixture.taskFile]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(json(fixture.stateFile).worker_turn_count, 2);
  assert.ok(json(fixture.stateFile).elapsed_active_seconds >= paused.elapsed_active_seconds);
});

test('ACTIVE time is checkpointed while waiting and the explicit total-time limit pauses a running worker', async () => {
  const fixture = setup('time-limit', { hold_worker: true });
  writeFileSync(fixture.taskFile, JSON.stringify({ ...json(fixture.taskFile), limits: { max_worker_turns: null, max_minutes: 0.02 } }));
  const child = spawn(process.execPath, [cli, ...fixture.argv], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 3000;
    while (true) {
      try { const state = json(fixture.stateFile); if (state.status === 'ACTIVE' && state.elapsed_active_seconds > 0.1) break; } catch {}
      assert.ok(Date.now() < deadline, 'ACTIVE elapsed time was not checkpointed.');
      await delay(20);
    }
    const [code] = await exited;
    assert.equal(code, 0);
    const state = json(fixture.stateFile);
    assert.equal(state.status, 'PAUSED');
    assert.equal(state.pause_reason, 'user_limit');
    assert.ok(state.elapsed_active_seconds >= 1.2);
    assert.equal(run(['resume', '--state', fixture.stateFile, '--test-fixture', fixture.fixture]).status, 1);
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } }
});

test('explicit resume preserves an unknown sent delivery and never blindly replays it', () => {
  const fixture = setup('unknown-resume', { disconnect_on_send_once: true });
  assert.equal(run(fixture.argv).status, 1);
  const pending = json(fixture.stateFile).pending_action;
  const resumed = run(['resume', '--state', fixture.stateFile, '--test-fixture', fixture.fixture]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'WAIT_EXTERNAL');
  assert.equal(state.phase, 'IDLE');
  assert.equal(state.pending_action, null);
  assert.equal(state.task_version, 2);
  const events = readFileSync(resolve(fixture.directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === 'send_reconciled_absent' && event.delivery_id === pending.delivery_id).length, 1);
  assert.equal(events.filter((event) => event.type === 'send_confirmed').length, 1);
  const trace = readFileSync(fixture.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.filter((entry) => entry.message?.method === 'turn/start').length, 2);
});

test('resume reconciles an interrupted sent delivery into one new continuation', () => {
  const fixture = setup('resume-interrupted', { disconnect_on_send_once: true });
  assert.equal(run(fixture.argv).status, 1);
  const pending = json(fixture.stateFile).pending_action;
  writeFileSync(fixture.scenario, JSON.stringify({ trace: fixture.trace, resume_turns: [{ id: 'first-turn-from-server', status: 'interrupted', items: [{ type: 'userMessage', clientId: pending.delivery_id }] }] }));
  const resumed = run(['resume', '--state', fixture.stateFile, '--test-fixture', fixture.fixture]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'WAIT_EXTERNAL');
  assert.equal(state.pending_action, null);
  const events = readFileSync(resolve(fixture.directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === 'worker_history_interrupted').length, 1);
  assert.equal(events.filter((event) => event.type === 'send_confirmed').length, 1);
  const trace = readFileSync(fixture.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const sends = trace.filter((entry) => entry.message?.method === 'turn/start');
  assert.equal(sends.length, 2);
  assert.notEqual(sends[0].message.params.clientUserMessageId, sends[1].message.params.clientUserMessageId);
});

test('resume records a failed sent delivery and enters unified recovery without confirming it', () => {
  const fixture = setup('resume-failed', { disconnect_on_send_once: true });
  assert.equal(run(fixture.argv).status, 1);
  const pending = json(fixture.stateFile).pending_action;
  writeFileSync(fixture.scenario, JSON.stringify({ trace: fixture.trace, resume_turns: [{ id: 'first-turn-from-server', status: 'failed', error: { message: 'Worker process exited with code 17.' }, items: [{ type: 'userMessage', clientId: pending.delivery_id }] }] }));
  const resumed = run(['resume', '--state', fixture.stateFile, '--test-fixture', fixture.fixture]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'WAIT_EXTERNAL');
  assert.equal(state.pending_action, null);
  const events = readFileSync(resolve(fixture.directory, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === 'worker_history_failed').length, 1);
  assert.equal(events.filter((event) => event.type === 'worker_history_failed_continuation').length, 1);
  assert.equal(events.filter((event) => event.type === 'send_confirmed').length, 1);
});

test('resume reviews the saved completed worker turn without adding another worker round', () => {
  const fixture = setup('resume-completed', { hold_worker: true, pause_after_ms: 80 });
  assert.equal(run(fixture.argv).status, 0);
  writeFileSync(fixture.scenario, JSON.stringify({ trace: fixture.trace, resume_turns: [{ id: 'first-turn-from-server', status: 'completed', items: [] }] }));
  writeFileSync(fixture.fixture, JSON.stringify({ ...json(fixture.fixture), judge: { action: 'DONE', reason: 'Completed while interrupt raced.', evidence_ids: ['E1'], next_message: '', external: null } }));
  const result = run(['resume', '--state', fixture.stateFile, '--test-fixture', fixture.fixture]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.stateFile).status, 'DONE');
  assert.equal(json(fixture.stateFile).worker_turn_count, 1);
  const trace = readFileSync(fixture.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.filter((entry) => entry.message?.method === 'turn/start').length, 1);
});

test('explicit resume reclaims only a dead supervisor lock and preserves checkpointed time after a crash', async () => {
  const fixture = setup('crash-resume', { hold_worker: true });
  const child = spawn(process.execPath, [cli, ...fixture.argv], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  let checkpoint;
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try { const state = json(fixture.stateFile); if (state.active_worker_turn_id && state.elapsed_active_seconds > 0.35) { checkpoint = state; break; } } catch {}
      assert.ok(Date.now() < deadline, 'No active crash checkpoint.');
      await delay(20);
    }
  } finally {
    child.kill('SIGKILL');
    await exited;
    for (const line of readFileSync(fixture.trace, 'utf8').trim().split('\n')) {
      const event = JSON.parse(line);
      if (event.kind === 'spawn') { try { process.kill(event.pid, 'SIGKILL'); } catch {} }
    }
  }
  writeFileSync(fixture.scenario, JSON.stringify({ trace: fixture.trace, resume_turns: [{ id: 'first-turn-from-server', status: 'completed', items: [] }] }));
  writeFileSync(fixture.fixture, JSON.stringify({ ...json(fixture.fixture), judge: { action: 'DONE', reason: 'Recovered fixture history.', evidence_ids: ['E1'], next_message: '', external: null } }));
  const resumed = run(['resume', '--state', fixture.stateFile, '--test-fixture', fixture.fixture]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const state = json(fixture.stateFile);
  assert.equal(state.status, 'DONE');
  assert.equal(state.worker_turn_count, 1);
  assert.ok(state.elapsed_active_seconds >= checkpoint.elapsed_active_seconds);
});

test('ACTIVE resume rejects changed goal or authorization before altering the saved contract', () => {
  const fixture = setup('active-contract-change', { disconnect_on_send: true });
  assert.equal(run(fixture.argv).status, 1);
  const checkpoint = readFileSync(fixture.stateFile, 'utf8');
  const trace = readFileSync(fixture.trace, 'utf8');
  const original = json(fixture.taskFile);
  for (const replacement of [{ ...original, goal: 'A different goal.' }, { ...original, authorization: 'Reduced permissions.' }]) {
    writeFileSync(fixture.taskFile, JSON.stringify(replacement));
    const resumed = run(['resume', '--state', fixture.stateFile, '--task', fixture.taskFile, '--test-fixture', fixture.fixture]);
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, /durable PAUSED/);
    assert.equal(readFileSync(fixture.stateFile, 'utf8'), checkpoint);
    assert.equal(readFileSync(fixture.trace, 'utf8'), trace);
  }
});
