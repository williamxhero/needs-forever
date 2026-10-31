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
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: {
      thread: { id: 'worker-from-server', turns: [] }, cwd: message.params.cwd,
      approvalPolicy: scenario.approval_policy ?? 'never',
      sandbox: scenario.sandbox ?? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    } });
  } else if (message.method === 'turn/start') {
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
      send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'first-turn-from-server', status: 'completed', items: [] } } });
    }
    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    send({ method: 'item/started', params: { threadId: message.params.threadId, turnId, item: { type: 'userMessage', id: `input-${turns}`, clientId: message.params.clientUserMessageId, content: message.params.input } } });
    if (!scenario.hold_worker) {
      const completed = { method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: scenario.terminal_status ?? 'completed', items: [{ type: 'agentMessage', id: 'answer-1', text: scenario.answer ?? 'Only fixture stage completed.' }] } } };
      if (scenario.late_error_first && turns > 1) setTimeout(() => send(completed), 80);
      else send(completed);
      if (scenario.duplicate_events) { send(completed); send(completed); }
    }
    if (scenario.response_order === 'after-completed') setTimeout(response, 30);
    if (scenario.response_order === 'missing') setTimeout(() => process.exit(0), 1000);
  } else {
    send({ id: message.id, error: { code: -32601, message: 'Not supported by fixture' } });
  }
}
