#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { codexCommand, PROTOCOL_VERSION } from '../runtime/src/transport.js';
import { redact } from '../runtime/src/redact.js';
import { prepareMainSession, resumeMainSession } from '../runtime/src/main-session.js';
import { controllerStatus, pauseMainController, prepareControllerResume } from '../runtime/src/main-controller.js';

const script = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL('../runtime/src/cli.js', import.meta.url));
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const emit = (value) => console.log(JSON.stringify(value, null, 2));
const receiptPath = (state) => `${state}.session.json`;
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid saved process identity.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
function save(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}
function absolute(value, name) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}
function options(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--task', '--state', '--test-fixture', '--control-mode'].includes(key) || flags[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected unique --task, --state, --test-fixture or --control-mode flags.');
    if (key === '--control-mode') { if (!['main-session', 'independent-worker'].includes(args[i + 1])) throw new Error('Invalid control mode.'); flags[key] = args[i + 1]; }
    else flags[key] = absolute(args[i + 1], key);
  }
  return flags;
}
function request(receipt, command) {
  return new Promise((resolve_, reject) => {
    const socket = createConnection(receipt.endpoint);
    let output = '';
    const fail = (error) => { socket.destroy(); reject(error); };
    socket.setTimeout(15_000, () => fail(new Error('Control request timed out; inspect status before retrying.')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(JSON.stringify({ command, session_id: receipt.session_id }) + '\n'));
    socket.on('data', (chunk) => {
      output += chunk;
      if (output.length > 1024 * 1024) return fail(new Error('Oversized control response.'));
      if (!output.includes('\n')) return;
      try { const result = JSON.parse(output.split('\n')[0]); socket.destroy(); resolve_(result); }
      catch (error) { fail(error); }
    });
    socket.on('end', () => { if (!output.includes('\n')) reject(new Error('Control connection ended without a result.')); });
  });
}
function lease(state) {
  const path = `${state}.plugin.lock`;
  const token = randomUUID();
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const guard = `${path}.reclaim`;
    const guardFd = openSync(guard, 'wx', 0o600);
    try {
      if (alive(read(path).pid)) throw new Error('This state already has a live plugin supervisor.');
      unlinkSync(path);
      fd = openSync(path, 'wx', 0o600);
    } finally { closeSync(guardFd); unlinkSync(guard); }
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
  return () => { closeSync(fd); if (read(path).token === token) unlinkSync(path); };
}
async function host(config) {
  let release;
  let child;
  let server;
  let exitOutcome;
  const sockets = new Set();
  const session = { schema_version: 1, session_id: randomUUID(), host_pid: process.pid, state_path: config.state, command: config.command, lifecycle: 'starting', started_at: new Date().toISOString() };
  session.endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\needs-forever-${session.session_id}` : resolve(tmpdir(), `nf-${session.session_id}.sock`);
  session.log_path = `${config.state}.console.log`;
  const log = (line) => appendFileSync(session.log_path, String(redact(line)) + '\n', { mode: 0o600 });
  const checkpoint = () => existsSync(config.state) ? read(config.state) : null;
  try {
    mkdirSync(dirname(config.state), { recursive: true });
    release = lease(config.state);
    // The core validates its own contract and lock before any model starts.
    const argv = [cli, config.command, '--state', config.state];
    for (const key of ['--task', '--test-fixture']) if (config.flags[key]) argv.push(key, config.flags[key]);
    child = spawn(process.execPath, argv, { cwd: config.workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise((done) => {
      child.once('error', (error) => done({ exit_code: null, error: error.message }));
      child.once('exit', (code, signal) => done({ exit_code: code, signal }));
    });
    void exited.then((outcome) => { exitOutcome = outcome; });
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', log);
    session.supervisor_pid = child.pid;
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.setTimeout(15_000, () => socket.destroy());
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
        if (data.length > 4096) return socket.destroy();
        if (!data.includes('\n')) return;
        socket.removeAllListeners('data');
        void (async () => {
          const message = JSON.parse(data.split('\n')[0]);
          if (message.session_id !== session.session_id) throw new Error('Control session identity mismatch.');
          if (message.command === 'ping') return { live: true, session_id: session.session_id };
          if (message.command !== 'pause') throw new Error('Unknown control command.');
          // Use the existing CLI input path: save PAUSED, invalidate results,
          // then cancel owned calls. Never signal an arbitrary saved PID.
          child.stdin.write('\u0003');
          await Promise.race([exited, delay(10_000, undefined, { ref: false }).then(() => { throw new Error('Pause not confirmed; inspect the saved state and session.'); })]);
          const state = checkpoint();
          if (state?.status !== 'PAUSED') throw new Error(`Pause was not persisted (${state?.status ?? 'no state'}).`);
          return { paused: true, status: state.status, worker_thread_id: state.worker_thread_id, state_path: config.state };
        })().then((result) => socket.end(JSON.stringify(result) + '\n')).catch((error) => socket.end(JSON.stringify({ error: error.message }) + '\n'));
      });
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(session.endpoint, done); });
    // Wait for this invocation's checkpoint, rather than an old checkpoint
    // from a previous run or merely a successfully spawned process.
    let initialized = false;
    for (let i = 0; i < 100; i++) {
      const state = checkpoint();
      if (state && state.task_version === config.previous_version + 1) { initialized = true; break; }
      if (exitOutcome) throw new Error(`Supervisor startup failed. Inspect ${session.log_path}.`);
      await delay(50);
    }
    if (!initialized) throw new Error(`Supervisor startup not confirmed. Inspect ${session.log_path}.`);
    session.lifecycle = 'running';
    save(receiptPath(config.state), session);
    process.send?.({ ready: true, session });
    if (process.connected) process.disconnect();
    const outcome = await exited;
    session.lifecycle = 'exited';
    Object.assign(session, outcome, { ended_at: new Date().toISOString() });
    save(receiptPath(config.state), session);
    release();
    release = undefined;
    // Let a pending pause response flush before closing its control socket.
    server.close();
    await delay(100);
    for (const socket of sockets) socket.destroy();
  } catch (error) {
    process.send?.({ error: error.message });
    if (process.connected) process.disconnect();
    if (child && child.exitCode === null) child.stdin.write('\u0003');
    if (release) {
      log(`Plugin host error: ${error.message}`);
      session.lifecycle = 'exited';
      session.error = error.message;
      save(receiptPath(config.state), session);
    }
    throw error;
  } finally {
    server?.close();
    release?.();
    if (process.platform !== 'win32' && existsSync(session.endpoint)) unlinkSync(session.endpoint);
  }
}
async function launch(command, flags) {
  if (command === 'start' && !flags['--task']) throw new Error('start requires --task FILE.');
  if (command === 'resume' && !flags['--state']) throw new Error('resume requires --state FILE.');
  const task = flags['--task'] ? read(flags['--task']) : read(flags['--state']).task;
  const workspace = absolute(task.workspace, 'task.workspace');
  if (!/^[\w.-]+$/.test(task.task_id) || ['.', '..'].includes(task.task_id)) throw new Error('Invalid task_id.');
  const state = flags['--state'] ?? resolve(workspace, '.codex-supervisor', task.task_id, 'state.json');
  if (command === 'start' && existsSync(state)) throw new Error('Task state already exists; use explicit resume.');
  const previous = command === 'resume' ? read(state) : null;
  if (previous?.status === 'DONE') throw new Error('DONE cannot resume; use a new task_id for additional work.');
  mkdirSync(dirname(state), { recursive: true });
  const config = { command, flags, workspace, state, previous_version: previous?.task_version ?? 0 };
  const child = spawn(process.execPath, [script, '--host', Buffer.from(JSON.stringify(config)).toString('base64')], { cwd: workspace, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const result = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Plugin launch outcome unknown. Inspect ${receiptPath(state)} and status before retrying.`)), 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Plugin host exited before ready (${code}); inspect ${state}.console.log.`)); });
    child.once('message', (message) => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : done(message); });
  });
  child.unref();
  // A receipt proves only that the process launched. Re-read authoritative
  // state before saying a worker exists or the goal has completed.
  for (let i = 0; i < 50; i++) {
    if (existsSync(state)) break;
    const receipt = existsSync(receiptPath(state)) ? read(receiptPath(state)) : null;
    if (receipt?.lifecycle === 'exited') throw new Error(`Supervisor startup failed. Inspect ${receipt.log_path}.`);
    await delay(100);
  }
  const saved = existsSync(state) ? read(state) : null;
  return { launched: true, status: saved?.status ?? 'STARTING', phase: saved?.phase ?? null, worker_thread_id: saved?.worker_thread_id ?? null, state_path: state, session: result.session };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--host') return host(JSON.parse(Buffer.from(args[0], 'base64').toString('utf8')));
  if (command === 'doctor') {
    const argv = codexCommand();
    const result = spawnSync(argv[0], [...argv.slice(1), '--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const version = result.stdout?.trim();
    if (Number(process.versions.node.split('.')[0]) < 24 || result.status !== 0 || version !== PROTOCOL_VERSION) throw new Error(`Requires Node.js >=24 and ${PROTOCOL_VERSION}; found Node ${process.versions.node}, Codex ${version ?? 'unavailable'}.`);
    return emit({ ready: true, node: process.version, codex: version, plugin_version: read(fileURLToPath(new URL('../.codex-plugin/plugin.json', import.meta.url))).version });
  }
  const flags = options(args);
  // Route before any legacy lease/checkpoint/process mutation. Missing mode in
  // saved checkpoints is the original independent-worker contract.
  const saved = flags['--state'] && existsSync(flags['--state']) ? read(flags['--state']) : null;
  const mode = command === 'start' ? flags['--control-mode'] ?? 'main-session' : saved?.control_mode ?? 'independent-worker';
  if (flags['--control-mode'] && flags['--control-mode'] !== mode) throw new Error('An existing checkpoint cannot change control mode.');
  if (mode === 'main-session') {
    if (command === 'start') {
      const task = read(absolute(flags['--task'], '--task'));
      const path = flags['--state'] ?? resolve(absolute(task.workspace, 'task.workspace'), '.codex-supervisor', task.task_id, 'state.json');
      const state = prepareMainSession(flags['--task'], path, Boolean(flags['--test-fixture']));
      return emit({ prepared: true, control_mode: state.control_mode, binding: state.binding, state_path: path });
    }
    const path = absolute(flags['--state'], '--state');
    if (command === 'status') return emit(await controllerStatus(path));
    if (command === 'resume') { await prepareControllerResume(path); const state = resumeMainSession(path, flags['--task'], Boolean(flags['--test-fixture'])); return emit({ prepared: true, control_mode: state.control_mode, binding: state.binding, state_path: path }); }
    if (command === 'pause') {
      return emit(await pauseMainController(path));
    }
    throw new Error('Commands: start/status/pause/resume.');
  }
  if (command === 'start' || command === 'resume') return emit(await launch(command, flags));
  if (command !== 'status' && command !== 'pause') throw new Error('Commands: doctor | start --task FILE [--state FILE] | status/pause/resume --state FILE.');
  const statePath = absolute(flags['--state'], '--state');
  const state = read(statePath);
  const receipt = existsSync(receiptPath(statePath)) ? read(receiptPath(statePath)) : null;
  if (command === 'status') {
    let live = false;
    if (receipt?.lifecycle === 'running') {
      try { live = (await request(receipt, 'ping')).live === true; } catch { /* Keep checkpoint status separate from process liveness. */ }
    }
    return emit({ state_path: statePath, status: state.status, phase: state.phase, worker_thread_id: state.worker_thread_id, live, recovery_required: state.status === 'ACTIVE' && !live, last_decision: state.last_decision, retry: state.retry, session: receipt });
  }
  if (state.status === 'PAUSED') return emit({ paused: true, status: 'PAUSED', state_path: statePath });
  if (state.status !== 'ACTIVE') throw new Error(`Task is ${state.status}; no running task to pause.`);
  if (!receipt || receipt.lifecycle !== 'running') throw new Error('No live plugin control handle. Inspect state and use explicit resume; no process was killed.');
  const result = await request(receipt, 'pause');
  if (result.error) throw new Error(result.error);
  emit(result);
}
main().catch((error) => { console.error(String(redact(error.message))); process.exitCode = 1; });
