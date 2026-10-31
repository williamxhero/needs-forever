import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const trace = (value) => appendFileSync(scenario.trace, `${JSON.stringify(value)}\n`);
trace({ kind: 'spawn', argv: process.argv.slice(3), pid: process.pid });
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.166.0');
  process.exit(0);
}
// 0.166.0 -c dotted override paths split literal dots; quoting a segment does
// not implement TOML quoted-key semantics. Such a path creates an invalid server.
if (process.argv.some((value) => value.startsWith('mcp_servers."'))) {
  console.error('invalid transport in quoted MCP override');
  process.exit(1);
}
let initialized = false;
let turns = 0;
let judges = 0;
const judgeThreads = new Set();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  trace({ kind: 'request', pid: process.pid, message });
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex-cli/0.166.0', platformFamily: 'windows', platformOs: 'windows' } });
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (!initialized) {
    send({ id: message.id, error: { code: -32600, message: 'initialize handshake missing' } });
  } else if (message.method === 'config/read') {
    const overrides = process.argv.slice(3).filter((value) => !value.startsWith('-'));
    const config = { features: {}, mcp_servers: {}, web_search: 'disabled' };
    for (const value of overrides) {
      const match = /^features\.([\w_]+)=false$/.exec(value);
      if (match) config.features[match[1]] = false;
    }
    for (const name of scenario.mcp_servers ?? []) {
      config.mcp_servers[name] = { enabled: overrides.some((value) => value.startsWith('mcp_servers=') && value.includes(`${JSON.stringify(name)}={enabled=false}`)) ? false : true };
    }
    send({ id: message.id, result: { config, origins: {}, layers: null } });
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    const judge = message.params.sandbox === 'read-only';
    const threadId = judge ? `judge-${++judges}` : 'worker-from-server';
    if (judge) judgeThreads.add(threadId);
    send({ id: message.id, result: {
      thread: { id: threadId, turns: message.method === 'thread/resume' ? scenario.resume_turns ?? [] : [] }, cwd: message.params.cwd,
      approvalPolicy: scenario.approval_policy ?? 'never',
      sandbox: judge ? scenario.judge_sandbox ?? { type: 'readOnly', networkAccess: false } : scenario.sandbox ?? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    } });
  } else if (message.method === 'thread/archive') {
    send(scenario.archive_failure ? { id: message.id, error: { code: -32000, message: 'Archive fixture failure' } } : { id: message.id, result: {} });
  } else if (message.method === 'turn/start') {
    if (judgeThreads.has(message.params.threadId)) {
      const turnId = `judge-turn-${judges}`;
      if (scenario.judge_send_error) { send({ id: message.id, error: { code: -32000, message: 'Judge send outcome is uncertain.' } }); continue; }
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      if (scenario.judge_disconnect) process.exit(0);
      const snapshot = JSON.parse(message.params.input[0].text);
      const action = scenario.judge_actions?.[judges - 1] ?? 'DONE';
      const decision = { action, reason: 'A1 evidence checked.', evidence_ids: snapshot.evidence.map((entry) => entry.id), next_message: action === 'CONTINUE' ? 'Check the remaining acceptance result.' : '', external: action === 'WAIT_EXTERNAL' ? { missing: 'Required credential.', attempted: ['Checked local credentials.'], why_no_other_work: 'The only remaining item requires the credential.', resume_when: 'User supplies credential.' } : null };
      const judgeItem = { type: 'agentMessage', id: 'judge-output', text: scenario.judge_output ?? JSON.stringify(decision), phase: 'final_answer' };
      if (scenario.wrong_judge_turn) send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'unrelated-judge-turn', status: 'completed', items: [{ ...judgeItem, text: '{"action":"DONE"}' }] } } });
      if (scenario.stream_items) send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId, item: judgeItem } });
      const finishJudge = () => send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'completed', items: scenario.stream_items ? [] : [judgeItem] } } });
      if (!scenario.hold_judge) { if (scenario.judge_delay_ms) setTimeout(finishJudge, scenario.judge_delay_ms); else finishJudge(); }
      continue;
    }
    turns++;
    const turnId = scenario.turn_id ?? (turns === 1 ? 'first-turn-from-server' : `turn-${turns}-from-server`);
    if (scenario.state_file) trace({ kind: 'checkpoint_at_send', state: JSON.parse(readFileSync(scenario.state_file, 'utf8')) });
    if (scenario.disconnect_on_send) process.exit(0);
    const response = () => send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (scenario.late_error_first && turns === 1) setTimeout(() => send({ id: message.id, error: { code: -32000, message: 'Late obsolete request failure after actual start.' } }), 10);
    else if (!scenario.response_order) response();
    if (scenario.duplicate_events) {
      send({ method: 'turn/started', params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'inProgress', items: [] } } });
      send({ method: 'turn/completed', params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'completed', items: [] } } });
      // A same-thread unrelated started/input pair must not confirm this delivery.
      send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'unrelated-turn', status: 'inProgress', items: [] } } });
      send({ method: 'item/started', params: { threadId: message.params.threadId, turnId: 'unrelated-turn', item: { type: 'userMessage', id: 'old-input', clientId: 'obsolete-delivery', content: [] } } });
      if (!scenario.real_judge) send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'first-turn-from-server', status: 'completed', items: [] } } });
    }
    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    send({ method: 'item/started', params: { threadId: message.params.threadId, turnId, item: { type: 'userMessage', id: `input-${turns}`, clientId: message.params.clientUserMessageId, content: message.params.input } } });
    if (scenario.pause_after_ms !== undefined) setTimeout(() => send({ method: 'supervisor/test/pause', params: {} }), scenario.pause_after_ms);
    if (!scenario.hold_worker) {
      const completed = { method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: scenario.terminal_status ?? 'completed', items: [...scenario.tool_items ?? [], { type: 'agentMessage', id: 'answer-1', text: scenario.answer ?? 'Only fixture stage completed.' }] } } };
      if (scenario.stream_items) { for (const item of completed.params.turn.items) send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId, item } }); completed.params.turn.items = []; }
      if (scenario.late_error_first && turns > 1) setTimeout(() => send(completed), 80);
      else send(completed);
      if (scenario.duplicate_events) { send(completed); send(completed); }
    }
    if (scenario.response_order === 'after-completed') setTimeout(response, 30);
    if (scenario.response_order === 'missing') setTimeout(() => process.exit(0), 1000);
  } else if (message.method === 'command/exec') {
    setTimeout(() => send({ id: message.id, result: { exitCode: 0, stdout: 'Fixture late success.', stderr: '' } }), scenario.verification_delay_ms ?? 300);
  } else if (message.method === 'turn/interrupt') {
    if (scenario.state_file) trace({ kind: 'checkpoint_at_interrupt', state: JSON.parse(readFileSync(scenario.state_file, 'utf8')) });
    send({ id: message.id, result: {} });
    if (message.params.threadId.startsWith('judge-')) send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted', items: [] } } });
  } else {
    send({ id: message.id, error: { code: -32601, message: 'Not supported by fixture' } });
  }
}
