import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { judgeInstructions } from '../src/judge.js';

function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
function jsonl(path: string): any[] { return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []; }
function scenario(name: string, options: Record<string, unknown> = {}) {
  const directory = resolve('runs/ticket26', `${name}-${Date.now()}`);
  const workspace = resolve(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const trace = resolve(directory, 'protocol.jsonl');
  const task = resolve(directory, 'task.json');
  const state = resolve(directory, 'state.json');
  const config = resolve(directory, 'scenario.json');
  const fixture = resolve(directory, 'fixture.json');
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, ...(Array.isArray(options.judge_actions) && options.judge_actions.includes('WAIT_EXTERNAL') ? { c2: { mode: 'legacy' } } : {}), goal: 'Produce the accepted local result.', acceptance: [{ id: 'A1', text: 'The result is checked.' }], authorization: 'Local workspace only; no network.' }));
  writeFileSync(config, JSON.stringify({ trace, state_file: state, real_judge: true, ...options }));
  writeFileSync(fixture, JSON.stringify({ app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), config], real_judge: true }));
  return { directory, workspace, task, state, trace, config, fixture, run() { return spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'start', '--task', task, '--state', state, '--test-fixture', fixture], { encoding: 'utf8', timeout: 15000 }); }, events() { return jsonl(resolve(directory, 'events.jsonl')); }, protocol() { return jsonl(trace); }, snapshots() { return readdirSync(resolve(directory, 'snapshots')).map((name) => json(resolve(directory, 'snapshots', name))); } };
}

function runningScenario(fixture: ReturnType<typeof scenario>, t: TestContext) {
  const child = spawn(process.execPath, [resolve('dist/src/cli.js'), 'start', '--task', fixture.task, '--state', fixture.state, '--test-fixture', fixture.fixture], { windowsHide: true, stdio: 'pipe' });
  let stderr = '', settled = false;
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', (code) => { settled = true; done(code); }); });
  t.after(async () => {
    if (settled) return;
    child.stdin.write('\u0003');
    const abort = new AbortController();
    try { await Promise.race([exited, delay(5_000, undefined, { signal: abort.signal })]); }
    finally { abort.abort(); if (!settled) child.kill(); }
  });
  const until = async (condition: () => boolean, description: string) => {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline && !settled) await delay(25);
    assert.ok(condition(), `${description}; stderr=${stderr}`);
  };
  return { until, exited, get settled() { return settled; }, get stderr() { return stderr; } };
}

test('judge prompt states the terminal next_message contract', () => {
  assert.match(judgeInstructions, /WAIT_EXTERNAL, next_message MUST be exactly the empty string/);
  assert.match(judgeInstructions, /Only CONTINUE may have a nonempty next_message/);
  assert.match(judgeInstructions, /If any original acceptance item is incomplete and the authorization covers local workspace work, you MUST choose CONTINUE/);
  assert.match(judgeInstructions, /WAIT_EXTERNAL is allowed only when the snapshot contains a concrete, necessary external condition/);
  assert.match(judgeInstructions, /configured verifier is a supervisor-owned gate executed after DONE/);
  assert.match(judgeInstructions, /result is not required in the judge snapshot/);
  assert.match(judgeInstructions, /provider is unavailable, rate-limited, degraded, credential-blocked/);
  assert.match(judgeInstructions, /authorized alternative provider, local cache or artifact/);
  assert.match(judgeInstructions, /MUST choose CONTINUE and put the concrete alternative action in next_message/);
  assert.match(judgeInstructions, /Only after the authorized alternatives have been explicitly checked/);
});

test('real judge boundary continues the original worker then completes with fresh archived read-only judges', () => {
  const fixture = scenario('fresh-judges', { judge_actions: ['CONTINUE', 'DONE'], tool_items: [{ type: 'commandExecution', id: 'check', command: 'check-result', exitCode: 0, status: 'completed', aggregatedOutput: 'A1 passes.' }] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.state).status, 'DONE');
  assert.equal(json(fixture.state).worker_turn_count, 2);
  const starts = fixture.protocol().filter((entry) => entry.message?.method === 'thread/start');
  assert.deepEqual(starts.map((entry) => entry.message.params.sandbox), ['workspace-write', 'read-only', 'read-only']);
  const judges = json(fixture.state).judge_thread_ids;
  assert.deepEqual(judges, ['judge-1', 'judge-2']);
  assert.deepEqual(fixture.protocol().filter((entry) => entry.message?.method === 'thread/archive').map((entry) => entry.message.params.threadId), judges);
  const turns = fixture.protocol().filter((entry) => entry.message?.method === 'turn/start');
  assert.equal(turns.filter((entry) => entry.message.params.threadId === 'worker-from-server').length, 2);
  assert.ok(turns.filter((entry) => entry.message.params.threadId.startsWith('judge-')).every((entry) => entry.message.params.outputSchema?.additionalProperties === false && entry.message.params.sandboxPolicy.type === 'readOnly'));
  assert.ok(fixture.snapshots().every((entry) => entry.validation === 'valid' && typeof entry.raw_output === 'string'));
});

test('judge outputs with unknown fields, references or illegal action combinations never finish the task', () => {
  const base = { action: 'DONE', reason: 'A1 checked.', evidence_ids: ['E1'], next_message: '', external: null };
  const cases = [
    { ...base, extra: 'Unrecognized instruction.' },
    { ...base, evidence_ids: ['E999'] },
    { ...base, next_message: 'Unexpected next action.' },
    { ...base, external: { missing: 'Unexpected' } },
    { ...base, action: 'CONTINUE', next_message: '' },
    { ...base, action: 'WAIT_EXTERNAL', external: { missing: 'Credential.', attempted: [], why_no_other_work: 'None.', resume_when: 'Provided.' } },
  ];
  for (const [index, decision] of cases.entries()) {
    const fixture = scenario(`invalid-output-${index}`, { judge_output: JSON.stringify(decision) });
    const result = fixture.run();
    assert.equal(result.status, 1, `Illegal output accepted: ${JSON.stringify(decision)}`);
    assert.equal(json(fixture.state).phase, 'RECOVERING');
    assert.equal(json(fixture.state).last_decision, null);
    assert.equal(fixture.snapshots()[0].validation, 'invalid');
    assert.equal(fixture.protocol().filter((entry) => entry.message?.method === 'thread/archive').length, 1);
  }
});

test('worker claims alone cannot prove DONE or an external dependency', () => {
  for (const action of ['DONE', 'WAIT_EXTERNAL']) {
    const fixture = scenario(`claims-${action}`, { judge_actions: [action], answer: 'Everything is finished, or blocked forever; trust me.' });
    const result = fixture.run();
    assert.equal(result.status, 1, 'Worker claims were accepted as independent proof.');
    assert.equal(json(fixture.state).last_decision, null);
    assert.match(result.stderr, /independent evidence/);
  }
});

test('bounded snapshots preserve the contract, real sources, recent instructions and failures while explicitly omitting large output', () => {
  const fixture = scenario('bounded-snapshot', { judge_actions: ['CONTINUE', 'CONTINUE', 'CONTINUE'], tool_items: [
    { type: 'commandExecution', id: 'verbose', command: 'verbose-check', status: 'completed', exitCode: 0, aggregatedOutput: 'Huge output. '.repeat(6000) },
    { type: 'commandExecution', id: 'failed', command: 'missing-credential-check', status: 'failed', exitCode: 1, aggregatedOutput: 'Required credential is absent.' },
    { type: 'fileChange', id: 'change', status: 'completed', changes: [{ path: 'result.txt', kind: { type: 'add' }, diff: '+Result' }] },
    { type: 'plan', id: 'plan', text: 'Check credential then finish remaining A1.' },
  ] });
  const task = json(fixture.task);
  task.goal += ' Complete original stages. '.repeat(80);
  task.authorization += ' Never request external permissions.';
  task.limits = { max_worker_turns: 3, max_minutes: null };
  writeFileSync(fixture.task, JSON.stringify(task));
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const snapshots = fixture.snapshots().map((entry) => entry.input).sort((a, b) => a.worker_turn_id.localeCompare(b.worker_turn_id));
  assert.equal(snapshots.length, 3);
  const last = snapshots.find((entry) => entry.worker_turn_id === 'turn-3-from-server');
  for (const snapshot of snapshots) {
    assert.ok(JSON.stringify(snapshot).length <= 24000, 'Judge input exceeded its default budget.');
    assert.equal(snapshot.task.goal, task.goal);
    assert.deepEqual(snapshot.task.acceptance, task.acceptance);
    assert.equal(snapshot.task.authorization, task.authorization);
    assert.ok(snapshot.omissions.length > 0);
    assert.equal(snapshot.evidence_complete, false);
    assert.ok(snapshot.evidence.some((entry: any) => entry.value.command === 'missing-credential-check' && entry.value.aggregatedOutput === 'Required credential is absent.'));
    const sources = new Set(fixture.events().map((event) => event.event_id));
    assert.ok(snapshot.evidence.every((entry: any) => sources.has(entry.source.event_id)));
  }
  assert.equal(last.recent_instructions.length, 2);
  assert.ok(last.recent_instructions.every((entry: any) => entry.result && entry.turn_id));
  assert.match(JSON.stringify(last.plan), /remaining A1/);
  assert.equal(last.repeated_failure.investigate, true);
  assert.match(last.repeated_failure.instruction, /different/);
});

test('streamed completed items supply worker evidence and judge JSON when terminal turns have no items', () => {
  const fixture = scenario('streamed-items', { stream_items: true, tool_items: [{ type: 'commandExecution', id: 'check', command: 'check-result', exitCode: 0, status: 'completed', aggregatedOutput: 'A1 passes.' }] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.state).status, 'DONE');
  const snapshot = fixture.snapshots()[0];
  assert.match(result.stdout, /Only fixture stage completed/);
  assert.equal(snapshot.validation, 'valid');
  const evidence = snapshot.input.evidence.find((entry: any) => entry.type === 'commandExecution');
  const source = fixture.events().find((entry) => entry.event_id === evidence.source.event_id);
  assert.equal(source.method, 'item/completed');
  assert.equal(source.params.item.id, 'check');
});

for (const acknowledged of [false, true]) test(`a timed out known C with ${acknowledged ? 'confirmed' : 'unconfirmed'} turn terminates and is archived without another model`, async (t) => {
  const fixture = scenario(`judge-timeout-${acknowledged ? 'confirmed' : 'unconfirmed'}`, { hold_judge: true, mcp_servers: ['boundary.example'], ...(acknowledged ? {} : { judge_start_response_delay_ms: 2_000 }) });
  writeFileSync(fixture.fixture, JSON.stringify({ ...json(fixture.fixture), judge_timeout_ms: 1_000 }));
  const running = runningScenario(fixture, t);
  await running.until(() => fixture.protocol().some((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'judge-1'), 'The known C turn request must reach the held external fixture');
  await running.until(() => fixture.events().some((entry) => entry.type === 'judge_terminated'), 'The actual judge deadline must terminate its owned call');
  const terminated = fixture.events().find((entry) => entry.type === 'judge_terminated');
  assert.equal(terminated.thread_id, 'judge-1');
  assert.equal(terminated.turn_id, acknowledged ? 'judge-turn-1' : null);
  await running.until(() => running.settled, 'The bounded archival cleanup must finish after cancellation');
  assert.equal(await running.exited, 1, running.stderr);
  assert.match(running.stderr, /judge.*timeout/i);
  assert.equal(json(fixture.state).phase, 'RECOVERING');
  assert.equal(json(fixture.state).last_decision, null);
  assert.equal(fixture.protocol().filter((entry) => entry.message?.params?.sandbox === 'read-only').length, 1);
  const pid = fixture.protocol().findLast((entry) => entry.kind === 'spawn').pid;
  assert.throws(() => process.kill(pid, 0));
  assert.ok(fixture.events().some((entry) => entry.type === 'judge_terminated'));
  const trace = fixture.protocol();
  const archives = trace.filter((entry) => entry.message?.method === 'thread/archive');
  assert.deepEqual(archives.map((entry) => entry.message.params.threadId), ['judge-1'], 'The cancelled C must be archived even after its owned connection exits.');
  const cleanupPid = archives[0].pid;
  const cleanupRequests = trace.filter((entry) => entry.pid === cleanupPid && entry.message?.method);
  assert.deepEqual(cleanupRequests.map((entry) => entry.message.method), ['initialize', 'initialized', 'config/read', 'thread/archive']);
  // C belongs to the connection that created its readonly thread, regardless
  // of whether turn/start was acknowledged before cancellation.
  const owner = trace.find((entry) => entry.message?.method === 'thread/start' && entry.message.params.sandbox === 'read-only');
  assert.ok(owner, 'The original C creation request must be recorded.');
  const ownerPid = owner.pid;
  assert.notEqual(cleanupPid, ownerPid);
  const cleanupSpawn = trace.find((entry) => entry.kind === 'spawn' && entry.pid === cleanupPid);
  assert.deepEqual(cleanupSpawn.argv, trace.find((entry) => entry.kind === 'spawn' && entry.pid === ownerPid).argv, 'Cleanup must preserve the guarded features and disabled MCP configuration.');
  assert.equal(cleanupSpawn.cwd, fixture.workspace);
  assert.throws(() => process.kill(ownerPid, 0));
  assert.ok(fixture.events().some((entry) => entry.type === 'judge_archived' && entry.thread_id === 'judge-1'));
  assert.equal(trace.filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'judge-1').length, 1);
  assert.equal(trace.filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'worker-from-server').length, 1);
});

test('terminated judge archive rejection or timeout is bounded and never restarts a model or infers completion', async (t) => {
  for (const options of [{ archive_failure: true }, { hold_archive: true }]) {
    const fixture = scenario(`judge-cleanup-${Object.keys(options)[0]}`, { hold_judge: true, ...options });
    writeFileSync(fixture.fixture, JSON.stringify({ ...json(fixture.fixture), judge_timeout_ms: 1_000 }));
    const running = runningScenario(fixture, t);
    await running.until(() => fixture.protocol().some((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'judge-1'), 'The held C must start before testing cleanup failure');
    await running.until(() => fixture.events().some((entry) => entry.type === 'judge_terminated' && entry.thread_id === 'judge-1'), 'The known C must terminate on its deadline');
    await running.until(() => running.settled, 'Cleanup rejection or timeout must settle within its independent deadline');
    assert.equal(await running.exited, 1, running.stderr);
    assert.match(running.stderr, /judge.*timeout/i);
    assert.equal(json(fixture.state).phase, 'RECOVERING');
    assert.equal(json(fixture.state).last_decision, null);
    const requests = fixture.protocol().filter((entry) => entry.message?.method);
    assert.deepEqual(requests.filter((entry) => entry.message.method === 'thread/archive').map((entry) => entry.message.params.threadId), ['judge-1']);
    assert.equal(requests.filter((entry) => entry.message.method === 'thread/start').length, 2);
    assert.equal(requests.filter((entry) => entry.message.method === 'turn/start').length, 2);
    assert.equal(requests.filter((entry) => entry.message.method === 'thread/resume').length, 0);
    assert.ok(fixture.events().some((entry) => entry.type === 'judge_archive_failed' && entry.thread_id === 'judge-1' && typeof entry.error === 'string'));
    if ('hold_archive' in options) assert.match(String(fixture.events().find((entry) => entry.type === 'judge_archive_failed')?.error), /cleanup deadline exceeded/);
    assert.equal(fixture.events().some((entry) => entry.type === 'judge_archived'), false);
    for (const entry of fixture.protocol().filter((entry) => entry.kind === 'spawn' && entry.argv.includes('app-server'))) assert.throws(() => process.kill(entry.pid, 0));
  }
});

test('T06 WAIT_EXTERNAL cites an actual failed route, stays idle and notifies once despite duplicates', () => {
  const fixture = scenario('external-wait', { judge_actions: ['WAIT_EXTERNAL'], duplicate_events: true, tool_items: [{ type: 'commandExecution', id: 'credential-check', command: 'check-local-credential', status: 'failed', exitCode: 1, aggregatedOutput: 'The required user-supplied credential is absent.' }] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const state = json(fixture.state);
  assert.equal(state.status, 'WAIT_EXTERNAL');
  assert.equal(state.phase, 'IDLE');
  assert.equal(state.pending_action, null);
  assert.equal(state.retry.next_at, null);
  assert.equal(state.worker_turn_count, 1);
  assert.equal(fixture.events().filter((entry) => entry.type === 'decision').length, 1);
  assert.equal((result.stdout.match(/WAIT_EXTERNAL:/g) ?? []).length, 1);
  assert.match(state.last_decision.external.resume_when, /supplies credential/);
  const before = readFileSync(fixture.trace, 'utf8');
  const status = spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'status', '--state', fixture.state], { encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).status, 'WAIT_EXTERNAL');
  assert.equal(readFileSync(fixture.trace, 'utf8'), before);
});

test('fences, appended text and a second JSON object are rejected with the exact raw output retained', () => {
  const decision = JSON.stringify({ action: 'CONTINUE', reason: 'Gather proof.', evidence_ids: [], next_message: 'Run the independent check.', external: null });
  for (const [index, output] of [`\x60\x60\x60json\n${decision}\n\x60\x60\x60`, `${decision}\nAll done.`, `${decision}\n${decision}`].entries()) {
    const fixture = scenario(`extra-text-${index}`, { judge_output: output });
    const result = fixture.run();
    assert.equal(result.status, 1);
    assert.equal(json(fixture.state).last_decision, null);
    assert.equal(fixture.snapshots()[0].raw_output, output);
    assert.equal(fixture.snapshots()[0].validation, 'invalid');
  }
});

test('judge policy expansion prevents its turn and archive failure cannot invalidate an otherwise valid decision', () => {
  const unsafe = scenario('judge-policy', { judge_sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
  const denied = unsafe.run();
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /readOnly\/never policy/);
  assert.equal(unsafe.protocol().filter((entry) => entry.message?.method === 'turn/start').length, 1);
  const cleanup = scenario('archive-failure', { archive_failure: true, tool_items: [{ type: 'commandExecution', id: 'check', command: 'check', status: 'completed', exitCode: 0, aggregatedOutput: 'A1 passes.' }] });
  const accepted = cleanup.run();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(json(cleanup.state).status, 'DONE');
  assert.ok(cleanup.events().some((entry) => entry.type === 'judge_archive_failed'));
});

test('PAUSED wins over a real judge that is in flight and the owned judge connection terminates', () => {
  const fixture = scenario('pause-real-judge', { pause_when_judge_started: true, hold_judge: true, tool_items: [{ type: 'commandExecution', id: 'check', command: 'check', status: 'completed', exitCode: 0, aggregatedOutput: 'A1 passes.' }] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const state = json(fixture.state);
  assert.equal(state.status, 'PAUSED');
  assert.equal(state.task_version, 2);
  assert.equal(state.last_decision, null);
  const trace = fixture.protocol();
  assert.ok(trace.some((entry) => entry.message?.params?.threadId === 'judge-1' && entry.message?.method === 'turn/start'));
  const ownerPid = trace.find((entry) => entry.message?.method === 'thread/start' && entry.message.params.sandbox === 'read-only').pid;
  const cleanupPid = trace.find((entry) => entry.message?.method === 'thread/archive' && entry.message.params.threadId === 'judge-1').pid;
  assert.notEqual(cleanupPid, ownerPid);
  assert.throws(() => process.kill(ownerPid, 0));
  assert.throws(() => process.kill(cleanupPid, 0));
  assert.ok(fixture.events().some((entry) => entry.type === 'judge_terminated' && entry.thread_id === 'judge-1' && entry.turn_id === 'judge-turn-1'));
  assert.ok(fixture.events().some((entry) => entry.type === 'stale_judge_result_ignored'));
  assert.deepEqual(trace.filter((entry) => entry.message?.method === 'thread/archive').map((entry) => entry.message.params.threadId), ['judge-1']);
  assert.equal(trace.filter((entry) => entry.message?.method === 'turn/start').length, 2, 'PAUSED cannot launch another model.');
  assert.equal(trace.filter((entry) => entry.message?.method === 'thread/resume').length, 0);
});

test('only the expected judge turn can supply the result even if a foreign completion arrives first', () => {
  const fixture = scenario('judge-turn-gate', { wrong_judge_turn: true, tool_items: [{ type: 'commandExecution', id: 'check', command: 'check', status: 'completed', exitCode: 0, aggregatedOutput: 'A1 passes.' }] });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(fixture.state).status, 'DONE');
  assert.equal(json(fixture.state).last_decision.reason, 'A1 evidence checked.');
});

test('truncated tool output cannot be used to infer either terminal decision', () => {
  for (const action of ['DONE', 'WAIT_EXTERNAL']) {
    const fixture = scenario(`truncated-${action}`, { judge_actions: [action], tool_items: [{ type: 'commandExecution', id: 'large-check', command: 'inspect-result', status: 'completed', exitCode: 0, aggregatedOutput: 'Ambiguous output. '.repeat(3000) }] });
    const result = fixture.run();
    assert.equal(result.status, 1);
    assert.equal(json(fixture.state).last_decision, null);
    assert.equal(fixture.snapshots()[0].input.evidence_complete, false);
    assert.match(result.stderr, /truncated evidence/);
  }
});

test('an uncertain judge turn start terminates the old connection before entering recovery', () => {
  const fixture = scenario('judge-send-error', { judge_send_error: true });
  const result = fixture.run();
  assert.equal(result.status, 1);
  const events = fixture.events();
  const stopped = events.findIndex((entry) => entry.type === 'judge_terminated');
  const recovering = events.findIndex((entry) => entry.type === 'recovery_required');
  assert.ok(stopped >= 0 && recovering > stopped, 'Recovery began before old judge termination was established.');
  assert.equal(json(fixture.state).last_decision, null);
});

test('connection failure during a judge result wait preserves the actual error and ends the old call', () => {
  const fixture = scenario('judge-disconnect', { judge_disconnect: true });
  const result = fixture.run();
  assert.equal(result.status, 1, 'Judge did not settle after its connection exited.');
  assert.match(result.stderr, /app-server exited/);
  assert.equal(json(fixture.state).phase, 'RECOVERING');
  assert.equal(json(fixture.state).last_decision, null);
});
