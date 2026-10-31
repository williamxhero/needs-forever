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
    const turnId = scenario.turn_id ?? 'first-turn-from-server';
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (!scenario.hold_worker) {
      send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', id: 'answer-1', text: scenario.answer ?? 'Only fixture stage completed.' }] } } });
    }
  } else {
    send({ id: message.id, error: { code: -32601, message: 'Not supported by fixture' } });
  }
}
