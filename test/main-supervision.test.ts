import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function setup(name: string, options: Record<string, unknown> = {}, verify = false, stateDirectory = join('.codex-supervisor', name), protectedFiles = ['verify.mjs']) {
  const directory = resolve('runs/main-supervision', `${name}-${Date.now()}`);
  const workspace = join(directory, '工作 空间');
  const plugin = join(directory, '插件 安装副本');
  mkdirSync(workspace, { recursive: true });
  cpSync(resolve('plugins/needs-forever'), plugin, { recursive: true });
  const task = join(directory, 'task.json');
  const state = join(workspace, stateDirectory, 'state.json');
  const fixture = join(directory, 'host.json');
  const scenario = join(directory, 'server.json');
  const trace = join(directory, 'protocol.jsonl');
  writeFileSync(join(workspace, 'verify.mjs'), "console.log('independent acceptance');\n");
  for (const file of protectedFiles.filter((file) => file !== 'verify.mjs')) {
    mkdirSync(dirname(join(workspace, file)), { recursive: true });
    writeFileSync(join(workspace, file), '{"acceptance":"original"}\n');
  }
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, ...(Array.isArray(options.judge_actions) && options.judge_actions.includes('WAIT_EXTERNAL') ? { c2: { mode: 'legacy' } } : {}), goal: 'Three stages', acceptance: [{ id: 'all', text: 'Three stages complete' }], authorization: 'Local files only', ...(verify ? { verify: { argv: [process.execPath, 'verify.mjs', 'literal;argument'], timeout_seconds: 2, protected_files: protectedFiles } } : {}), limits: {} }));
  writeFileSync(scenario, JSON.stringify({ trace, ...options }));
  writeFileSync(fixture, JSON.stringify({ desktop_version: 'simulated', cli_version: 'simulated', app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), scenario] }));
  const control = join(plugin, 'scripts/main-session.mjs');
  const run = (command: string, args: string[] = []) => spawnSync(process.execPath, [control, command, '--state', state, ...args], { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
  const hook = (event: Record<string, unknown>) => spawnSync(process.execPath, [join(plugin, 'scripts/lifecycle.mjs'), '--test-fixture', fixture], { cwd: workspace, env: { ...process.env, PLUGIN_ROOT: plugin }, input: JSON.stringify({ session_id: name, cwd: workspace, turn_id: 'same-turn', ...event }), encoding: 'utf8', timeout: 20_000 });
  const tool = { tool_use_id: 'prepare', tool_input: { command: `node "${control}" prepare --task "${task}" --state "${state}" --test-fixture "${fixture}"` } };
  assert.equal(hook({ ...tool, hook_event_name: 'PreToolUse' }).status, 0);
  const prepared = run('prepare', ['--task', task, '--test-fixture', fixture]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const bound = hook({ ...tool, hook_event_name: 'PostToolUse', tool_response: prepared.stdout });
  assert.equal(bound.status, 0, bound.stderr);
  const status = () => JSON.parse(run('status').stdout);
  const protocol = () => readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const activity = (id: string, output: string) => {
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) {
      const result = hook({ hook_event_name, tool_use_id: id, tool_name: 'functions.exec', tool_input: { cmd: `check ${id}` }, tool_response: { output } });
      assert.equal(result.status, 0, result.stderr);
    }
  };
  const stop = () => { const result = hook({ hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'All complete.' }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  return { directory, workspace, plugin, fixture, state, scenario, run, hook, status, protocol, activity, stop };
}

test('installed Stop creates fresh readonly C for each same-turn stop and confirms only subsequent A tool activity', (t) => {
  const f = setup('fresh-C', { judge_actions: ['CONTINUE', 'CONTINUE'] });
  t.after(() => f.run('pause'));
  assert.equal(f.status().codex_version, 'codex-cli 0.166.0', 'Installed status must retain the independently probed supervisor CLI version.');
  f.activity('phase-one', 'phase-one.txt exists; phases two and three missing.');
  assert.equal(f.stop().decision, 'block');
  assert.equal(f.status().continuation_confirmed, false);
  f.activity('phase-two', 'phase-two.txt now exists; phase three missing.');
  assert.equal(f.status().continuation_confirmed, true);
  assert.equal(f.stop().decision, 'block');
  const state = f.status();
  assert.equal(state.mode, 'simulated');
  assert.equal(state.judge_thread_ids.length, 2);
  assert.notEqual(state.judge_thread_ids[0], state.judge_thread_ids[1]);
  assert.equal(state.last_decision.action, 'CONTINUE');
  const requests = f.protocol().filter((entry) => entry.message?.method);
  assert.equal(requests.filter((entry) => entry.message.method === 'thread/resume').length, 0);
  assert.equal(requests.filter((entry) => entry.message.method === 'thread/start' && entry.message.params.sandbox !== 'read-only').length, 0);
  assert.ok(requests.filter((entry) => entry.message.method === 'turn/start').every((entry) => entry.message.params.threadId.startsWith('judge-')));
  const snapshot = JSON.parse(requests.find((entry) => entry.message.method === 'turn/start').message.params.input[0].text);
  assert.equal(snapshot.task.authorization, 'Local files only');
  assert.equal(snapshot.stop_request.stop_hook_active, true);
  const proof = snapshot.evidence.find((entry: any) => entry.type === 'functionCallOutput');
  assert.equal(proof.source.item_id, 'phase-one');
  assert.match(JSON.stringify(proof.value), /phase-one.txt/);
});

test('assistant completion or blocked wording alone cannot support DONE or WAIT_EXTERNAL', (t) => {
  const f = setup('unsupported-terminal', { judge_actions: ['DONE', 'WAIT_EXTERNAL'] });
  t.after(() => f.run('pause'));
  for (const action of ['DONE', 'WAIT_EXTERNAL']) {
    const reply = f.stop();
    assert.equal(reply.decision, 'block', `${action} without tool evidence was accepted.`);
    assert.match(reply.reason, /structured tool|acceptance/i);
    assert.equal(f.status().status, 'ACTIVE');
    assert.equal(f.status().last_decision.action, 'CONTINUE');
  }
});

test('fixed isolated verifier failure reaches A and a subsequent repaired Stop alone can release the binding', (t) => {
  const f = setup('verifier-repair', { judge_actions: ['DONE', 'DONE'], verification_results: [{ exitCode: 7, stdout: 'actual A1 failure', stderr: 'stage three missing' }, { exitCode: 0, stdout: 'all stages independently checked', stderr: '' }] }, true);
  t.after(() => { if (f.status().live) f.run('pause'); });
  const originalBaseline = f.status().protected_baseline;
  f.activity('check-one', 'Three-stage files checked.');
  const refused = f.stop();
  assert.equal(refused.decision, 'block');
  assert.match(refused.reason, /actual A1 failure/);
  assert.match(refused.reason, /stage three missing/);
  assert.equal(f.status().last_decision.action, 'CONTINUE');
  f.activity('repair', 'Repaired stage three and independently checked all files.');
  assert.deepEqual(f.stop(), {});
  const complete = f.status();
  assert.equal(complete.status, 'DONE');
  assert.equal(complete.binding.status, 'RELEASED');
  assert.equal(complete.pending_action, null);
  assert.deepEqual(complete.protected_baseline, originalBaseline);
  assert.deepEqual(f.stop(), {}, 'Late Stop must not reopen completion.');
  const commands = f.protocol().filter((entry) => entry.message?.method === 'command/exec').map((entry) => entry.message.params);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].command, [process.execPath, 'verify.mjs', 'literal;argument']);
  assert.deepEqual(commands[0].sandboxPolicy, { type: 'workspaceWrite', writableRoots: [f.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  assert.equal(commands[0].timeoutMs, 2_000);
});

test('protected verifier changes refuse DONE before execution and retain original restoration content', (t) => {
  const f = setup('protected-verifier', { judge_actions: ['DONE', 'DONE'] }, true);
  t.after(() => { if (f.status().live) f.run('pause'); });
  const original = readFileSync(join(f.workspace, 'verify.mjs'), 'utf8');
  f.activity('check', 'All outputs checked.');
  writeFileSync(join(f.workspace, 'verify.mjs'), 'process.exit(0);');
  const reply = f.stop();
  assert.equal(reply.decision, 'block');
  assert.match(reply.reason, /Protected files changed before verification/);
  assert.ok(reply.reason.includes(Buffer.from(original).toString('base64')));
  assert.equal(f.protocol().filter((entry) => entry.message?.method === 'command/exec').length, 0);
  writeFileSync(join(f.workspace, 'verify.mjs'), original);
  f.activity('restore', 'Original protected verifier restored and outputs checked.');
  assert.deepEqual(f.stop(), {});
  assert.equal(f.status().status, 'DONE');
});

test('WAIT_EXTERNAL contains independently traceable condition and recovery without a continuation', (t) => {
  const f = setup('external-condition', { judge_actions: ['WAIT_EXTERNAL'] });
  t.after(() => { if (f.status().live) f.run('pause'); });
  f.activity('credential-probe', 'Required service credential absent. Local fallback attempted and unavailable. All other authorized items complete.');
  assert.deepEqual(f.stop(), {});
  const waiting = f.status();
  assert.equal(waiting.status, 'WAIT_EXTERNAL');
  assert.equal(waiting.pending_action, null);
  assert.ok(waiting.last_decision.external.attempted.length);
  assert.ok(waiting.last_decision.external.why_no_other_work);
  assert.ok(waiting.last_decision.external.resume_when);
});

test('long assistant wording cannot crowd independent proof or the full original contract out of the 24k judge snapshot', (t) => {
  const f = setup('bounded-snapshot', { judge_actions: ['DONE'] });
  t.after(() => { if (f.status().live) f.run('pause'); });
  f.activity('independent-check', 'All three stage artifacts independently checked.');
  const result = f.hook({ hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'I completed everything. '.repeat(2_000) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.status().status, 'DONE');
  const turn = f.protocol().find((entry) => entry.message?.method === 'turn/start');
  const raw = turn.message.params.input[0].text;
  const snapshot = JSON.parse(raw);
  assert.ok(raw.length <= 24_000);
  assert.equal(snapshot.task.goal, 'Three stages');
  assert.equal(snapshot.task.acceptance[0].text, 'Three stages complete');
  assert.ok(snapshot.omissions.some((entry: string) => /assistant/.test(entry)));
  assert.ok(snapshot.evidence.some((entry: any) => entry.type === 'functionCallOutput'));
});

test('workspace changes during an otherwise successful fixed check invalidate DONE until a stable recheck', (t) => {
  const f = setup('verification-changed-workspace', { judge_actions: ['DONE', 'DONE'], verification_changes: [[{ path: 'stage-three.txt', content: 'changed while verifier ran' }], []] }, true);
  t.after(() => { if (f.status().live) f.run('pause'); });
  f.activity('before-check', 'All three stages checked before independent verification.');
  const refused = f.stop();
  assert.equal(refused.decision, 'block');
  assert.match(refused.reason, /workspace_changed.*true/);
  assert.equal(f.status().status, 'ACTIVE');
  f.activity('recheck', 'Current stage-three.txt and all other outputs checked after the change.');
  assert.deepEqual(f.stop(), {});
  assert.equal(f.status().status, 'DONE');
});

test('custom checkpoint paths do not make controller heartbeat writes invalidate a stable fixed check', (t) => {
  const f = setup('custom-checkpoint-stable', { judge_actions: ['DONE'], verification_delay_ms: 600 }, true, '.spec33-fixture');
  t.after(() => { if (f.status().live) f.run('pause'); });
  writeFileSync(join(f.workspace, '.spec33-fixture', 'task-output.txt'), 'stable acceptance output');
  f.activity('check-custom', 'All outputs independently checked; task-output.txt is stable.');
  assert.deepEqual(f.stop(), {}, 'B accounting writes in a configured checkpoint location are not task workspace changes.');
  assert.equal(f.status().status, 'DONE');
});

test('task files beside a custom checkpoint still invalidate DONE when they change during verification', (t) => {
  const f = setup('custom-checkpoint-output', { judge_actions: ['DONE', 'DONE'], verification_changes: [[{ path: '.spec33-fixture/task-output.txt', content: 'changed while verifier ran' }], []] }, true, '.spec33-fixture');
  t.after(() => { if (f.status().live) f.run('pause'); });
  f.activity('check-before', 'All task outputs checked before independent verification.');
  assert.match(f.stop().reason, /workspace_changed.*true/);
  assert.equal(f.status().status, 'ACTIVE');
  f.activity('check-after', 'The changed task-output.txt and all other outputs independently rechecked.');
  assert.deepEqual(f.stop(), {});
  assert.equal(f.status().status, 'DONE');
});

test('unprotected UUID-named business JSON beside a custom checkpoint remains in the workspace change gate', (t) => {
  const businessFile = '.spec33-fixture/snapshots/22222222-2222-2222-2222-222222222222.json';
  const f = setup('custom-checkpoint-business-json', { judge_actions: ['DONE', 'DONE'], verification_changes: [[{ path: businessFile, content: '{"business":"changed during verification"}' }], []] }, true, '.spec33-fixture');
  t.after(() => { if (f.status().live) f.run('pause'); });
  mkdirSync(dirname(join(f.workspace, businessFile)), { recursive: true });
  writeFileSync(join(f.workspace, businessFile), '{"business":"original"}');
  f.activity('business-before', 'All task outputs, including business JSON, independently checked.');
  const refused = f.stop();
  assert.equal(refused.decision, 'block', 'A business file change must refuse DONE even when its name resembles a generated snapshot.');
  assert.match(refused.reason, /workspace_changed.*true/);
  assert.equal(f.status().status, 'ACTIVE');
  f.activity('business-after', 'Business JSON and all other outputs independently rechecked after the change.');
  assert.deepEqual(f.stop(), {});
  assert.equal(f.status().status, 'DONE');
});

test('protected files with checkpoint artifact names retain their fixed baseline enforcement', (t) => {
  const protectedArtifact = '.spec33-fixture/snapshots/11111111-1111-1111-1111-111111111111.json';
  const f = setup('custom-checkpoint-protected', { judge_actions: ['DONE', 'DONE'] }, true, '.spec33-fixture', ['verify.mjs', protectedArtifact]);
  t.after(() => { if (f.status().live) f.run('pause'); });
  const original = readFileSync(join(f.workspace, protectedArtifact), 'utf8');
  writeFileSync(join(f.workspace, protectedArtifact), '{"acceptance":"changed"}\n');
  f.activity('protected-changed', 'Task outputs checked.');
  assert.match(f.stop().reason, /Protected files changed before verification/);
  assert.equal(f.protocol().filter((entry) => entry.message?.method === 'command/exec').length, 0);
  writeFileSync(join(f.workspace, protectedArtifact), original);
  f.activity('protected-restored', 'Original protected acceptance content restored and task outputs checked.');
  assert.deepEqual(f.stop(), {});
  assert.equal(f.status().status, 'DONE');
});

test('truncated old tool output requests concise proof but cannot poison a later Stop with new complete evidence', (t) => {
  const f = setup('replace-truncated-proof', { judge_actions: ['DONE', 'DONE'] });
  t.after(() => { if (f.status().live) f.run('pause'); });
  f.activity('oversized-result', 'large result '.repeat(2_000));
  assert.equal(f.stop().decision, 'block');
  assert.equal(f.status().status, 'ACTIVE');
  f.activity('concise-result', 'All three artifacts independently checked: stages one, two and three pass.');
  assert.deepEqual(f.stop(), {});
  assert.equal(f.status().status, 'DONE');
  const snapshots = f.protocol().filter((entry) => entry.message?.method === 'turn/start').map((entry) => JSON.parse(entry.message.params.input[0].text));
  assert.equal(snapshots[0].evidence_complete, false);
  assert.equal(snapshots[1].evidence_complete, true);
  assert.equal(snapshots[1].evidence.some((entry: any) => entry.source?.item_id === 'oversized-result'), false);
});

test('installed pause returns before bounded C cleanup and cleanup failure cannot restart A', async (t) => {
  const f = setup('pause-C-cleanup', { judge_actions: ['CONTINUE'], hold_judge: true, hold_archive: true });
  t.after(() => { if (f.status().status === 'ACTIVE') f.run('pause'); });
  f.activity('before-pause', 'Stage three remains incomplete.');
  const callback = spawn(process.execPath, [join(f.plugin, 'scripts/lifecycle.mjs'), '--test-fixture', f.fixture], { cwd: f.workspace, env: { ...process.env, PLUGIN_ROOT: f.plugin }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; callback.stdout.on('data', (chunk) => { output += chunk; });
  const exited = new Promise<void>((done) => callback.once('exit', () => done()));
  callback.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'pause-C-cleanup', cwd: f.workspace, turn_id: 'same-turn' }));
  for (let i = 0; i < 100 && !f.protocol().some((entry) => entry.message?.method === 'turn/start'); i++) await delay(25);
  const judgeStart = f.protocol().find((entry) => entry.message?.method === 'turn/start');
  assert.ok(judgeStart, 'Pause must cancel an actual started C.');
  const started = Date.now();
  assert.equal(f.run('pause').status, 0);
  assert.ok(Date.now() - started < 2_500, 'Public pause must not await the independent 3-second cleanup deadline.');
  await exited;
  assert.deepEqual(JSON.parse(output), {});
  assert.equal(f.status().status, 'PAUSED');
  const events = () => readFileSync(join(dirname(f.state), 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  for (let i = 0; i < 160 && !events().some((entry) => entry.type === 'judge_archive_failed'); i++) await delay(25);
  assert.ok(events().some((entry) => entry.type === 'judge_archive_failed' && entry.thread_id === judgeStart.message.params.threadId));
  const trace = f.protocol();
  const archives = trace.filter((entry) => entry.message?.method === 'thread/archive');
  assert.deepEqual(archives.map((entry) => entry.message.params.threadId), [judgeStart.message.params.threadId]);
  const cleanup = trace.filter((entry) => entry.pid === archives[0].pid && entry.message?.method);
  assert.deepEqual(cleanup.map((entry) => entry.message.method), ['initialize', 'initialized', 'config/read', 'thread/archive']);
  assert.throws(() => process.kill(judgeStart.pid, 0), 'The interrupted judge server must be gone.');
  assert.throws(() => process.kill(archives[0].pid, 0), 'The timed-out cleanup server must be gone.');
  assert.equal(trace.filter((entry) => entry.message?.method === 'turn/start').length, 1);
  assert.equal(trace.filter((entry) => entry.message?.method === 'thread/resume').length, 0);
  assert.equal(events().some((entry) => entry.type === 'decision' || entry.type === 'send_confirmed'), false);
  assert.equal(f.status().pending_action, null);
  assert.equal(f.status().status, 'PAUSED');
});

for (const phase of ['JUDGE', 'VERIFY']) test(`human input during ${phase === 'JUDGE' ? 'held' : 'delayed'} ${phase} invalidates late success and current evidence must be gathered again`, async (t) => {
  const f = setup(`input-during-${phase}`, { judge_actions: ['DONE', 'DONE'], ...(phase === 'JUDGE' ? { hold_judge_once: true } : { verification_delay_ms: 1_500 }) }, phase === 'VERIFY');
  t.after(() => f.run('pause'));
  f.activity('old-check', 'All three artifacts checked before the new instruction.');
  const callback = spawn(process.execPath, [join(f.plugin, 'scripts/lifecycle.mjs'), '--test-fixture', f.fixture], { cwd: f.workspace, env: { ...process.env, PLUGIN_ROOT: f.plugin }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; callback.stdout.on('data', (chunk) => { output += chunk; });
  const exited = new Promise<void>((done) => callback.once('exit', () => done()));
  callback.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: `input-during-${phase}`, cwd: f.workspace, turn_id: 'same-turn' }));
  for (let i = 0; i < 50 && f.status().phase !== phase; i++) await delay(25);
  assert.equal(f.status().phase, phase);
  if (phase === 'JUDGE') {
    for (let i = 0; i < 200 && !f.protocol().some((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'judge-1'); i++) await delay(25);
    assert.ok(f.protocol().some((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'judge-1'), 'Human input must follow the actual held C start.');
  }
  assert.equal(f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Recheck the current files; keep the original authorization.' }).status, 0);
  await exited; assert.deepEqual(JSON.parse(output), {});
  assert.equal(f.status().status, 'ACTIVE'); assert.equal(f.status().phase, 'WORKER');
  const next = f.stop(); assert.equal(next.decision, 'block', 'Old input-epoch proof cannot establish DONE.');
  const snapshots = f.protocol().filter((entry) => entry.message?.method === 'turn/start').map((entry) => JSON.parse(entry.message.params.input[0].text));
  assert.ok(snapshots.at(-1).recent_instructions.some((entry: any) => entry.source === 'native-human-input' && /Recheck/.test(entry.prompt)));
  assert.equal(snapshots.at(-1).evidence.length, 0);
});

test('a recoverable invalid judgment retries inside the original Stop deadline without turning failure into task completion', (t) => {
  const f = setup('recover-judgment', { judge_actions: ['CONTINUE', 'CONTINUE'], judge_outputs: ['invalid JSON'] });
  t.after(() => f.run('pause'));
  f.activity('remaining', 'Stage three remains incomplete.');
  assert.equal(f.stop().decision, 'block');
  const status = f.status();
  assert.equal(status.status, 'ACTIVE'); assert.equal(status.phase, 'WORKER');
  assert.equal(status.judge_thread_ids.length, 2);
  assert.ok(status.recovery_failures.length >= 1);
  assert.equal(status.retry.kind, null);
});

test('recoverable model errors remove credential canaries from public state and the next supervisor input', (t) => {
  const canary = 'sk-Spec33OnlyFakeCanary000000000000';
  const f = setup('recovery-redaction', { judge_request_once: `temporary-network-${canary}`, judge_actions: ['CONTINUE'] });
  t.after(() => f.run('pause'));
  assert.equal(f.stop().decision, 'block');
  assert.ok(f.status().recovery_failures.length > 0);
  assert.equal(readFileSync(f.state, 'utf8').includes(canary), false);
  assert.equal(f.run('status').stdout.includes(canary), false);
  const inputs = f.protocol().filter((entry) => entry.message?.method === 'turn/start');
  assert.ok(inputs.length >= 2);
  assert.equal(JSON.stringify(inputs.at(-1).message.params.input).includes(canary), false);
});

test('an adapter occurrence accepts one C and delivery while separate identical native invocations each judge', async (t) => {
  const f = setup('adapter-occurrence', { judge_actions: ['CONTINUE'], judge_delay_ms: 500 });
  t.after(() => f.run('pause'));
  const relay = (id: string) => new Promise<any>((done, reject) => {
    const child = spawn(process.execPath, [resolve('test/fixtures/hook-relay.mjs'), f.state, id], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject); child.on('exit', (code) => code ? reject(new Error(stderr)) : done(JSON.parse(stdout)));
  });
  const first = relay('c7c0d493-29bf-4f16-9aa8-aa860756640e');
  await delay(200);
  const duplicate = await relay('c7c0d493-29bf-4f16-9aa8-aa860756640e');
  assert.match(duplicate.error, /occurrence.*(accepted|invalid|replay)/i);
  assert.equal((await first).decision, 'block');
  const delivery = f.status().pending_action.delivery_id;
  const replay = await relay('c7c0d493-29bf-4f16-9aa8-aa860756640e');
  assert.match(replay.error, /occurrence.*(accepted|invalid|replay)/i);
  assert.equal(f.status().judge_thread_ids.length, 1);
  assert.equal(f.status().pending_action.delivery_id, delivery);
  for (let i = 0; i < 3; i++) assert.equal(f.stop().decision, 'block');
  assert.equal(f.status().judge_thread_ids.length, 4);
  f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Use current evidence.' });
  assert.match((await relay('c7c0d493-29bf-4f16-9aa8-aa860756640e')).error, /occurrence.*(accepted|invalid|replay)/i);
  assert.equal(f.run('pause').status, 0);
  const control = join(f.plugin, 'scripts/main-session.mjs');
  const tool = { tool_use_id: 'occurrence-resume', tool_input: { command: `node "${control}" resume --state "${f.state}" --test-fixture "${f.fixture}"` } };
  assert.equal(f.hook({ ...tool, hook_event_name: 'PreToolUse' }).status, 0);
  const resumed = f.run('resume', ['--test-fixture', f.fixture]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(f.hook({ ...tool, hook_event_name: 'PostToolUse', tool_response: resumed.stdout }).status, 0);
  assert.match((await relay('c7c0d493-29bf-4f16-9aa8-aa860756640e')).error, /occurrence.*(accepted|invalid|replay)/i);
  assert.equal(f.status().judge_thread_ids.length, 4);
});

test('released main-session binding leaves later ordinary native lifecycle completely neutral', async () => {
  const f = setup('released-neutral', { judge_actions: ['DONE'] });
  f.activity('all-three-stages', 'Independent evidence for all three completed stages.');
  assert.deepEqual(f.stop(), {});
  for (let attempt = 0; attempt < 50 && f.status().controller.lifecycle !== 'exited'; attempt++) await delay(50);
  const final = f.status();
  assert.equal(final.status, 'DONE');
  assert.equal(final.binding.status, 'RELEASED');
  assert.equal(final.controller.lifecycle, 'exited');
  const bytes = readFileSync(f.state, 'utf8');
  const protocol = readFileSync(join(f.directory, 'protocol.jsonl'), 'utf8');
  for (const hook_event_name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'UserPromptSubmit']) {
    const response = f.hook({ hook_event_name, tool_use_id: 'ordinary-after-done', tool_input: { command: 'git status --short' }, tool_response: 'ordinary output', prompt: 'Continue ordinary chat work.' });
    assert.equal(response.status, 0, response.stderr);
    assert.equal(response.stdout.trim(), '{}');
    assert.equal(response.stderr, '');
  }
  assert.equal(readFileSync(f.state, 'utf8'), bytes);
  assert.equal(readFileSync(join(f.directory, 'protocol.jsonl'), 'utf8'), protocol, 'Released callbacks cannot start B/C or deliver another instruction.');
});
