import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { platform, release } from 'node:os';

const root = resolve(process.argv[2] ?? `runs/ticket31-live/${Date.now()}`);
const phase = process.argv[3] === '--phase' ? process.argv[4] : null;
const activeRoot = phase ? resolve(root, phase.toLowerCase()) : root;
mkdirSync(resolve(activeRoot, 'workspace'), { recursive: true });
const workspace = resolve(activeRoot, 'workspace');

function save(name, value) { writeFileSync(resolve(activeRoot, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function state() { return JSON.parse(readFileSync(resolve(activeRoot, 'state.json'), 'utf8')); }
function events() {
  const file = resolve(activeRoot, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function waitFor(predicate, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError;
  return new Promise((resolveWait, reject) => {
    const poll = () => {
      try {
        const current = state();
        if (predicate(current, events())) return resolveWait(current);
      } catch (error) { lastError = error; }
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for state predicate after ${timeoutMs}ms.${lastError ? ` Last read error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`));
      setTimeout(poll, 100);
    };
    poll();
  });
}
function task(taskId, goal, acceptance, verify = null) {
  return {
    schema_version: 1, task_id: taskId, workspace, goal, acceptance,
    authorization: 'Use only this local workspace. No network, credentials, or external side effects. All listed work is authorized.',
    ...(verify ? { verify } : {}),
    limits: { max_worker_turns: null, max_minutes: null },
  };
}
function launch(taskFile) {
  const stateFile = resolve(activeRoot, 'state.json');
  const child = spawn(process.execPath, [resolve('dist/src/cli.js'), 'start', '--task', taskFile, '--state', stateFile], { cwd: resolve('.'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return { child, stateFile, stdout: () => stdout, stderr: () => stderr };
}
async function waitChild(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return 'exited';
  const exited = new Promise((resolveWait) => child.once('exit', () => resolveWait('exited')));
  const timeout = new Promise((resolveWait) => setTimeout(() => resolveWait('timeout'), timeoutMs));
  const result = await Promise.race([exited, timeout]);
  if (result === 'exited') return result;
  killTree(child.pid);
  const confirmed = await Promise.race([exited, new Promise((resolveWait) => setTimeout(() => resolveWait('still_running'), 5_000))]);
  if (confirmed !== 'exited') throw new Error(`Harness child process ${child.pid ?? 'unknown'} did not exit after process-tree cleanup.`);
  return 'forced';
}
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGTERM'); } catch {} }
}
async function stopAt(phase, label) {
  const taskFile = resolve(activeRoot, `${label}.task.json`);
  const value = label === 'worker-pause'
    ? task('ticket31-t08-worker', 'Run a local Node command that waits for 60 seconds, then write worker.txt with the exact text worker-ok.', [{ id: 'A1', text: 'worker.txt contains worker-ok.' }])
    : label === 'judge-pause'
      ? task('ticket31-t08-judge', 'Write judge.txt with the exact text judge-ok, then stop.', [{ id: 'A1', text: 'judge.txt contains judge-ok.' }])
      : task('ticket31-t08-verification', 'Write verification.txt with the exact text verification-ok, then stop.', [{ id: 'A1', text: 'verification.txt contains verification-ok.' }], { argv: [process.execPath, resolve(activeRoot, 'slow-verify.mjs')], timeout_seconds: 90, protected_files: [] });
  save(`${label}.task.json`, value);
  const run = launch(taskFile);
  try {
    await waitFor((s) => phase === 'WORKER' ? s.active_worker_turn_id !== null : phase === 'JUDGE' ? s.reviewing_turn_id !== null : s.phase === 'VERIFY', 90_000);
    const before = state();
    if (!run.child.stdin || !run.child.stdin.write('\u0003')) throw new Error('Unable to write the Ctrl+C control byte to the foreground CLI.');
    const after = await waitFor((s) => s.status === 'PAUSED', 20_000);
    const process_shutdown = await waitChild(run.child);
    return { label, phase, status: after.status, task_version: after.task_version, active_worker_turn_id: before.active_worker_turn_id, reviewing_turn_id: before.reviewing_turn_id, process_shutdown, stdout: run.stdout(), stderr: run.stderr(), events: events().filter((event) => ['paused', 'owned_calls_cancelled', 'stale_judge_result_ignored', 'stale_verification_result_ignored'].includes(event.type)).map((event) => event.type) };
  } finally {
    if (run.child.exitCode === null) await waitChild(run.child).catch(() => killTree(run.child.pid));
  }
}
async function appServerExit() {
  const taskFile = resolve(activeRoot, 'app-server-exit.task.json');
  const verifier = `import { readFileSync } from 'node:fs';\nif (readFileSync('exit.txt', 'utf8') !== 'exit-ok') process.exit(1);\nconsole.log('T11 app-server exit verifier PASS');\n`;
  writeFileSync(resolve(workspace, 'verify-exit.mjs'), verifier, 'utf8');
  const value = task('ticket31-t11-exit', 'Write exit.txt with the exact text exit-ok, then stop.', [{ id: 'A1', text: 'exit.txt contains exit-ok.' }], { argv: [process.execPath, resolve(workspace, 'verify-exit.mjs')], timeout_seconds: 20, protected_files: ['verify-exit.mjs'] });
  save('app-server-exit.task.json', value);
  const run = launch(taskFile);
  try {
    await waitFor((_s, list) => list.some((event) => event.type === 'worker_completed' && event.status === 'completed'), 120_000);
    const connection = events().find((event) => event.type === 'connection_verified' && event.server_process_id);
    if (!connection || !Number.isInteger(connection.server_process_id)) throw new Error('No verified native app-server process ID was recorded.');
    const oldPid = connection.server_process_id;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(oldPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(oldPid);
    const recovered = await waitFor((s, list) => s.status === 'DONE' && list.some((event) => event.type === 'connection_reconnected'), 180_000);
    const process_shutdown = await waitChild(run.child);
    return { label: 'app-server-exit', status: recovered.status, worker_thread_id: recovered.worker_thread_id, old_server_process_id: oldPid, reconnects: events().filter((event) => event.type === 'connection_reconnected').length, process_shutdown, stdout: run.stdout(), stderr: run.stderr() };
  } finally {
    if (run.child.exitCode === null) await waitChild(run.child).catch(() => killTree(run.child.pid));
  }
}

writeFileSync(resolve(activeRoot, 'slow-verify.mjs'), `await new Promise((resolveWait) => setTimeout(resolveWait, 90_000));\nconsole.log('slow verifier completed');\n`, 'utf8');
const startedAt = new Date().toISOString();
const results = [];
for (const [phase, label] of [['WORKER', 'worker-pause'], ['JUDGE', 'judge-pause'], ['VERIFY', 'verification-pause']]) {
  const phaseRoot = resolve(root, label);
  mkdirSync(phaseRoot, { recursive: true });
  // Each phase is isolated so a paused process cannot affect the next phase.
  results.push({ phase, label, note: 'See per-phase run directory and event log.' });
}

// The phase runner is intentionally sequential and writes a manifest before execution.
save('manifest.json', { mode: 'live-process-boundary', started_at: startedAt, system: `${platform()} ${release()}`, node: process.version, phases: ['worker', 'judge', 'verification'], t11: ['thread-unload-simulated-by-controlled-notification', 'app-server-exit-live-process'] });
// Run the three pause phases in separate child directories by re-execing this script with an internal selector.
if (process.argv[3] === '--phase') {
  const result = await stopAt(phase, phase === 'WORKER' ? 'worker-pause' : phase === 'JUDGE' ? 'judge-pause' : 'verification-pause');
  save(`${phase.toLowerCase()}-pause.json`, result);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
if (process.argv[3] === '--t11') {
  const result = await appServerExit();
  save('t11-app-server-exit.json', result);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(JSON.stringify({ mode: 'live-process-boundary', root, manifest: resolve(root, 'manifest.json'), commands: { worker: `${process.execPath} ${resolve('scripts/run-ticket31-live.mjs')} ${root} --phase WORKER`, judge: `${process.execPath} ${resolve('scripts/run-ticket31-live.mjs')} ${root} --phase JUDGE`, verification: `${process.execPath} ${resolve('scripts/run-ticket31-live.mjs')} ${root} --phase VERIFY`, t11: `${process.execPath} ${resolve('scripts/run-ticket31-live.mjs')} ${root} --t11` } }, null, 2));
