import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { routeInventoryDecision } from '../../dist/src/planning.js';

const scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const trace = (value) => appendFileSync(scenario.trace, `${JSON.stringify(value)}\n`);
trace({ kind: 'spawn', argv: process.argv.slice(3), pid: process.pid, cwd: process.cwd() });
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.166.0');
  process.exit(0);
}
if (scenario.fail_startup_once && !scenario.startup_consumed) {
  scenario.startup_consumed = true;
  writeFileSync(process.argv[2], JSON.stringify(scenario));
  process.exit(1);
}
// 0.166.0 -c dotted override paths split literal dots; quoting a segment does
// not implement TOML quoted-key semantics. Such a path creates an invalid server.
if (process.argv.some((value) => value.startsWith('mcp_servers."'))) {
  console.error('invalid transport in quoted MCP override');
  process.exit(1);
}
let initialized = false;
const history = readFileSync(scenario.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
let turns = history.filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'worker-from-server').length;
let judges = history.filter((entry) => entry.message?.method === 'thread/start' && entry.message.params.sandbox === 'read-only').length;
const judgeThreads = new Set();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  trace({ kind: 'request', pid: process.pid, message });
  if (!message.method && ('result' in message || 'error' in message)) continue;
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex-cli/0.166.0', platformFamily: 'windows', platformOs: 'windows' } });
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (!initialized) {
    send({ id: message.id, error: { code: -32600, message: 'initialize handshake missing' } });
  } else if (message.method === 'config/read') {
    const overrides = process.argv.slice(3).filter((value) => !value.startsWith('-'));
    const config = { features: {}, mcp_servers: {}, web_search: 'disabled', ...(scenario.model ? { model: scenario.model, model_provider: scenario.model_provider ?? 'OpenAI' } : {}) };
    for (const value of overrides) {
      const match = /^features\.([\w_]+)=false$/.exec(value);
      if (match) config.features[match[1]] = false;
    }
    for (const name of scenario.mcp_servers ?? []) {
      config.mcp_servers[name] = { enabled: overrides.some((value) => value.startsWith('mcp_servers=') && value.includes(`${JSON.stringify(name)}={enabled=false}`)) ? false : true };
    }
    send({ id: message.id, result: { config, origins: {}, layers: null } });
  } else if (message.method === 'hooks/list') {
    const names = ['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop', 'interrupt'];
    const sourcePath = resolve(scenario.plugin_root ?? '.', 'hooks/hooks.json');
    send({ id: message.id, result: { data: [{ hooks: names.map(eventName => ({ eventName, sourcePath, enabled: true, trustStatus: scenario.recovery_hook_trust ?? 'trusted' })) }] } });
  } else if (message.method === 'thread/read') {
    const threadId = scenario.main_session_thread_id ?? 'worker-from-server';
    const status = scenario.thread_read_status ?? 'active';
    const turns = scenario.thread_read_turns ?? scenario.resume_turns ?? [];
    send({ id: message.id, result: { thread: { id: threadId, status: { type: status }, turns: message.params.includeTurns === false ? [] : turns } } });
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    const judge = message.params.sandbox === 'read-only';
    const threadId = judge ? `judge-${++judges}` : (scenario.main_session_thread_id ?? 'worker-from-server');
    if (judge) judgeThreads.add(threadId);
    const historyTurns = scenario.reconcile_turns ?? scenario.resume_turns ?? [];
    send({ id: message.id, result: {
      thread: { id: threadId, turns: message.method === 'thread/resume' ? historyTurns : [] }, cwd: message.params.cwd,
      approvalPolicy: scenario.approval_policy ?? 'never',
      sandbox: judge ? scenario.judge_sandbox ?? { type: 'readOnly', networkAccess: false } : scenario.sandbox ?? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      ...(message.method === 'thread/resume' && scenario.turns_backwards_cursor ? { turnsBackwardsCursor: scenario.turns_backwards_cursor } : {}),
    } });
  } else if (message.method === 'thread/turns/list') {
    const pageIndex = Number(message.params.cursor ?? 0);
    const page = scenario.turn_pages?.[pageIndex] ?? { data: scenario.resume_turns ?? [], nextCursor: null };
    send({ id: message.id, result: { data: page.data ?? [], nextCursor: page.nextCursor ?? null, backwardsCursor: page.backwardsCursor ?? null } });
  } else if (message.method === 'thread/archive') {
    if (scenario.hold_archive) continue;
    send(scenario.archive_failure ? { id: message.id, error: { code: -32000, message: 'Archive fixture failure' } } : { id: message.id, result: {} });
  } else if (message.method === 'thread/unsubscribe') {
    if (scenario.unsubscribe_disconnect) process.exit(0);
    else if (scenario.unsubscribe_error) send({ id: message.id, error: { code: -32000, message: 'Thread unsubscribe fixture failure.' } });
    else send({ id: message.id, result: {} });
  } else if (message.method === 'turn/start') {
    if (scenario.native_recovery_hook && !judgeThreads.has(message.params.threadId)) {
      const hook = scenario.native_recovery_hook;
      const result = spawnSync(process.execPath, [resolve(hook.plugin, 'scripts/lifecycle.mjs'), '--test-fixture', hook.fixture], {
        cwd: hook.workspace, env: { ...process.env, PLUGIN_ROOT: hook.plugin }, encoding: 'utf8', timeout: 15000,
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: message.params.threadId, cwd: hook.workspace, turn_id: 'recovered-native-turn', prompt: message.params.input[0].text }),
      });
      trace({ kind: 'native_recovery_hook', status: result.status, stderr: result.stderr });
    }
    if (judgeThreads.has(message.params.threadId)) {
      const turnId = `judge-turn-${judges}`;
      if (scenario.judge_stderr) console.error(String(scenario.judge_stderr));
      if (scenario.judge_request_once && !scenario.judge_request_consumed) {
        scenario.judge_request_consumed = true;
        writeFileSync(process.argv[2], JSON.stringify(scenario));
        send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
        send({ id: 'malicious-request', method: scenario.judge_request_once, params: {} }); continue;
      }
      if (scenario.judge_send_error) { send({ id: message.id, error: { code: -32000, message: 'Judge send outcome is uncertain.' } }); continue; }
      const acknowledgeJudge = () => {
        send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
        if (scenario.pause_when_judge_started) send({ method: 'supervisor/test/pause', params: {} });
      };
      if (scenario.judge_start_response_delay_ms) setTimeout(acknowledgeJudge, scenario.judge_start_response_delay_ms);
      else acknowledgeJudge();
      if (scenario.judge_disconnect) process.exit(0);
      const snapshot = JSON.parse(message.params.input[0].text);
      const action = scenario.judge_actions?.[judges - 1] ?? 'DONE';
      const decision = action === 'CONTINUE' && snapshot.c2?.mode !== 'legacy' ? routeInventoryDecision(snapshot, 'A1 evidence checked.') : { action, reason: 'A1 evidence checked.', evidence_ids: snapshot.evidence.map((entry) => entry.id), next_message: action === 'CONTINUE' ? 'Check the remaining acceptance result.' : '', external: action === 'WAIT_EXTERNAL' ? { missing: 'Required credential.', attempted: ['Checked local credentials.'], why_no_other_work: 'The only remaining item requires the credential.', resume_when: 'User supplies credential.' } : null };
      if (scenario.judge_cite_current_proof && decision.route_plan) {
        decision.reason += ' Preserve the independently observed proof while checking the original acceptance.'.repeat(70);
        decision.evidence_ids = snapshot.evidence.map(entry => entry.id);
        decision.diagnosis.evidence_ids = [...decision.evidence_ids];
        decision.route_plan.candidates[0].evidence_ids = [...decision.evidence_ids];
      }
      if (scenario.judge_check_current_proof && decision.route_plan) {
        const route = decision.route_plan.candidates[0];
        route.evidence_ids = snapshot.evidence.map(entry => entry.id);
        route.discriminating_check = route.evidence_ids.length ? { description: 'Read concise independent inventory facts.', evidence_ids: [...route.evidence_ids] } : null;
        route.hypothesis_id = `inventory-after-${snapshot.c2.ledger.attempts.length}-attempts`;
      }
      const artifact = scenario.judge_select_observed_artifact && snapshot.c2?.catalog.entries.find((entry) => !entry.inventory_only && entry.resource.kind === 'artifact' && entry.status === 'observed');
      if (action === 'CONTINUE' && artifact && decision.route_plan) {
        const route = decision.route_plan.candidates[0];
        Object.assign(route, { route_id: artifact.route_id, resource: artifact.resource, operation: artifact.operation, status: 'observed', evidence_ids: artifact.evidence.map((proof) => proof.id), actions: [`Read ${artifact.resource.id} and verify the required result.`] });
        decision.route_plan.selected_route_id = artifact.route_id;
        decision.route_plan.selection_reason = 'B independently observed the source-linked local alternative.';
        decision.route_plan.single_route_reason = 'Only this task-relevant artifact is independently observed; other providers remain unverified.';
        decision.next_message = route.actions.join('\n');
      }
      const api = scenario.judge_select_observed_api && snapshot.c2?.catalog.entries.find((entry) => entry.resource.kind === 'api' && entry.status === 'observed');
      if (action === 'CONTINUE' && api && decision.route_plan) {
        const route = decision.route_plan.candidates[0];
        Object.assign(route, { route_id: api.route_id, resource: api.resource, operation: api.operation, status: 'observed', evidence_ids: api.evidence.map((proof) => proof.id), actions: [`Use the verified read-only API ${api.resource.id} and verify the required result.`] });
        decision.route_plan.selected_route_id = api.route_id;
        decision.route_plan.single_route_reason = 'This is the sole observed API alternative; configured names prove no other provider.';
        decision.next_message = route.actions.join('\n');
      }
      const judgeOutput = scenario.judge_outputs?.[judges - 1] ?? scenario.judge_output;
      const judgeItem = { type: 'agentMessage', id: 'judge-output', text: judgeOutput ?? JSON.stringify(decision), phase: 'final_answer' };
      if (scenario.wrong_judge_turn) send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'unrelated-judge-turn', status: 'completed', items: [{ ...judgeItem, text: '{"action":"DONE"}' }] } } });
      if (scenario.stream_items) send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId, item: judgeItem } });
      const finishJudge = () => send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'completed', items: scenario.stream_items ? [] : [judgeItem] } } });
      const holdThisJudge = scenario.hold_judge || (scenario.hold_judge_once && judges === 1) || judges <= (scenario.hold_judge_until ?? 0);
      if (!holdThisJudge) { if (scenario.judge_delay_ms) setTimeout(finishJudge, scenario.judge_delay_ms); else finishJudge(); }
      continue;
    }
    // Recovery tests can model Codex's -32600 active-writer race: history is
    // idle at thread/resume time, then the original A claims the writer before
    // NF's turn/start reaches the host.  The production helper must defer the
    // same delivery id and retry with bounded backoff.
    const recoveryText = String(message.params.input?.[0]?.text ?? '');
    const recoveryMatch = String(scenario.recovery_active_writer_match ?? 'NF 自动恢复绑定');
    if ((scenario.recovery_active_writer_once || scenario.recovery_active_writer_always) && (scenario.recovery_active_writer_always || !scenario.recovery_active_writer_consumed) && recoveryText.includes(recoveryMatch)) {
      scenario.recovery_active_writer_consumed = true;
      writeFileSync(process.argv[2], JSON.stringify(scenario));
      send({ id: message.id, error: { code: -32600, message: 'already has an active writer' } });
      continue;
    }
    turns++;
    const workspace = scenario.state_file ? JSON.parse(readFileSync(scenario.state_file, 'utf8')).task.workspace : message.params.cwd;
    const commandItems = (scenario.worker_commands?.[turns - 1] ?? []).map((argv, index) => {
      const result = spawnSync(argv[0], argv.slice(1), { cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 5000 });
      return { type: 'commandExecution', id: `worker-command-${turns}-${index}`, command: JSON.stringify(argv), status: result.status === 0 ? 'completed' : 'failed', exitCode: result.status, aggregatedOutput: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    });
    for (const url of scenario.worker_probe_urls?.[turns - 1] ?? []) {
      const state = JSON.parse(readFileSync(scenario.state_file, 'utf8'));
      const argv = [...(state.route_probe?.argv_prefix ?? [process.execPath, resolve('dist/src/cli.js'), 'route-probe', '--state', scenario.state_file]), '--url', url];
      const result = spawnSync(argv[0], argv.slice(1), { cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 5000 });
      commandItems.push({ type: 'commandExecution', id: `http-probe-${turns}`, command: JSON.stringify(argv), status: result.status === 0 ? 'completed' : 'failed', exitCode: result.status, aggregatedOutput: `${result.stdout ?? ''}${result.stderr ?? ''}` });
    }
    for (const change of scenario.worker_changes?.[turns - 1] ?? []) {
      const file = resolve(message.params.cwd ?? JSON.parse(readFileSync(scenario.state_file, 'utf8')).task.workspace, change.path);
      if (change.remove) unlinkSync(file);
      else writeFileSync(file, change.content);
    }
    const turnId = scenario.turn_id ?? (turns === 1 ? 'first-turn-from-server' : `turn-${turns}-from-server`);
    if (scenario.state_file) trace({ kind: 'checkpoint_at_send', state: JSON.parse(readFileSync(scenario.state_file, 'utf8')) });
    if (scenario.disconnect_on_send || (scenario.disconnect_on_send_once && !scenario.disconnect_consumed)) {
      if (scenario.disconnect_on_send_once) {
        scenario.disconnect_consumed = true;
        writeFileSync(process.argv[2], JSON.stringify(scenario));
      }
      process.exit(0);
    }
    const response = () => send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (scenario.late_error_first && turns === 1) setTimeout(() => send({ id: message.id, error: { code: -32000, message: 'Late obsolete request failure after actual start.' } }), 10);
    else if (!scenario.response_order) response();
    if (scenario.duplicate_events) {
      send({ method: 'turn/started', params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'inProgress', items: [] } } });
      send({ method: 'turn/completed', params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'completed', items: [] } } });
      // A same-thread unrelated started/input pair must not confirm this delivery.
      send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'unrelated-turn', status: 'inProgress', items: [] } } });
      send({ method: 'item/started', params: { threadId: message.params.threadId, turnId: 'unrelated-turn', item: { type: 'userMessage', id: 'old-input', clientId: 'obsolete-delivery', content: [] } } });
      if (turns > 1 && !scenario.real_judge) send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'first-turn-from-server', status: 'completed', items: [] } } });
    }
    if (!scenario.suppress_worker_confirmation) send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (scenario.thread_closed_after_ms !== undefined) setTimeout(() => send({ method: 'thread/closed', params: { threadId: message.params.threadId } }), scenario.thread_closed_after_ms);
    (scenario.server_requests ?? []).forEach((request, index) => setTimeout(() => send({ id: request.id ?? `server-request-${turns}-${index}`, method: request.method, params: { ...(request.params ?? {}), threadId: message.params.threadId, turnId } }), index * 15));
    if (!scenario.suppress_worker_confirmation) send({ method: 'item/started', params: { threadId: message.params.threadId, turnId, item: { type: 'userMessage', id: `input-${turns}`, clientId: message.params.clientUserMessageId, content: message.params.input } } });
    if (scenario.pause_after_ms !== undefined) setTimeout(() => send({ method: 'supervisor/test/pause', params: {} }), scenario.pause_after_ms);
    if (!scenario.hold_worker) {
      const terminalStatus = scenario.terminal_statuses?.[turns - 1] ?? scenario.terminal_status ?? 'completed';
      const terminalError = scenario.terminal_errors?.[turns - 1] ?? scenario.terminal_error;
      const completedTurn = { id: turnId, status: terminalStatus, items: [...scenario.tool_items ?? [], ...commandItems, { type: 'agentMessage', id: 'answer-1', text: scenario.answer ?? 'Only fixture stage completed.' }] };
      if (terminalError) completedTurn.error = terminalError;
      const completed = { method: 'turn/completed', params: { threadId: message.params.threadId, turn: completedTurn } };
      if (scenario.stream_items) { for (const item of completed.params.turn.items) send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId, item } }); completed.params.turn.items = []; }
      if (scenario.late_error_first && turns > 1) setTimeout(() => send(completed), 80);
      else if (scenario.server_requests?.length) setTimeout(() => send(completed), 120);
      else if (scenario.worker_completion_delay_ms) setTimeout(() => send(completed), scenario.worker_completion_delay_ms);
      else send(completed);
      if (scenario.duplicate_events) { send(completed); send(completed); }
    }
    if (scenario.response_order === 'after-completed') setTimeout(response, 30);
    if (scenario.response_order === 'missing') setTimeout(() => process.exit(0), 1000);
  } else if (message.method === 'command/exec') {
    const index = readFileSync(scenario.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.message?.method === 'command/exec').length - 1;
    const executed = scenario.execute_verification ? spawnSync(message.params.command[0], message.params.command.slice(1), { cwd: message.params.cwd, encoding: 'utf8', windowsHide: true, timeout: message.params.timeoutMs }) : null;
    const outcome = executed ? { exitCode: executed.status, stdout: executed.stdout ?? '', stderr: executed.stderr ?? '' } : scenario.verification_results?.[index] ?? { exitCode: 0, stdout: 'Fixture late success.', stderr: '' };
    for (const change of scenario.verification_changes?.[index] ?? []) writeFileSync(resolve(message.params.cwd, change.path), change.content);
    if (scenario.pause_when_verification_started) send({ method: 'supervisor/test/pause', params: {} });
    if (!scenario.hold_verification && !scenario.hold_verification_indices?.includes(index)) setTimeout(() => send(outcome.error ? { id: message.id, error: outcome.error } : { id: message.id, result: outcome }), scenario.verification_delay_ms ?? 300);
  } else if (message.method === 'turn/interrupt') {
    if (scenario.state_file) trace({ kind: 'checkpoint_at_interrupt', state: JSON.parse(readFileSync(scenario.state_file, 'utf8')) });
    send({ id: message.id, result: {} });
    if (message.params.threadId.startsWith('judge-')) send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted', items: [] } } });
  } else {
    send({ id: message.id, error: { code: -32601, message: 'Not supported by fixture' } });
  }
}
