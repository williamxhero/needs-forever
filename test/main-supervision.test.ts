import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function setup(name: string, options: Record<string, unknown> = {}, verify = false) {
  const directory = resolve('runs/main-supervision', `${name}-${Date.now()}`);
  const workspace = join(directory, '工作 空间');
  const plugin = join(directory, '插件 安装副本');
  mkdirSync(workspace, { recursive: true });
  cpSync(resolve('plugins/needs-forever'), plugin, { recursive: true });
  const task = join(directory, 'task.json');
  const state = join(workspace, '.codex-supervisor', name, 'state.json');
  const fixture = join(directory, 'host.json');
  const scenario = join(directory, 'server.json');
  const trace = join(directory, 'protocol.jsonl');
  writeFileSync(join(workspace, 'verify.mjs'), "console.log('independent acceptance');\n");
  writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: name, workspace, goal: 'Three stages', acceptance: [{ id: 'all', text: 'Three stages complete' }], authorization: 'Local files only', ...(verify ? { verify: { argv: [process.execPath, 'verify.mjs', 'literal;argument'], timeout_seconds: 2, protected_files: ['verify.mjs'] } } : {}), limits: {} }));
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
  return { directory, workspace, state, scenario, run, hook, status, protocol, activity, stop };
}

test('installed Stop creates fresh readonly C for each same-turn stop and confirms only subsequent A tool activity', (t) => {
  const f = setup('fresh-C', { judge_actions: ['CONTINUE', 'CONTINUE'] });
  t.after(() => f.run('pause'));
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
