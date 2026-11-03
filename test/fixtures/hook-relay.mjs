import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
const state = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const occurrence = process.argv[3];
const socket = createConnection(state.controller.endpoint);
socket.setTimeout(15_000, () => socket.destroy(new Error('Relay timeout')));
socket.on('connect', () => socket.write(JSON.stringify({ token: state.controller.token, controller_id: state.controller.id, run_generation: state.run_generation, command: 'lifecycle', payload: { adapter_occurrence_id: occurrence, event: { hook_event_name: 'Stop', session_id: state.main_session_id, cwd: state.task.workspace, turn_id: 'same-turn' } } }) + '\n'));
socket.on('data', (chunk) => process.stdout.write(chunk));
socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
