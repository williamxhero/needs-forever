#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Store } from './store.js';
import { FixtureJudge, AppServerJudge } from './judge.js';
import { Supervisor } from './supervisor.js';
import { codexCommand } from './transport.js';
import { reachedLimits } from './rules.js';
import { record, text } from './types.js';
import type { Decision, State, Task } from './types.js';

function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
function taskInput(input: unknown): Task {
  const data = record(input);
  if (data.schema_version !== 1) throw new Error('schema_version must be 1.');
  const workspace = text(data.workspace, 'workspace');
  if (!isAbsolute(workspace) || !statSync(workspace).isDirectory()) throw new Error('workspace must name an existing absolute directory.');
  const taskId = text(data.task_id, 'task_id');
  if (!/^[\w.-]+$/.test(taskId) || taskId === '.' || taskId === '..') throw new Error('task_id must be a safe local identifier.');
  if (!Array.isArray(data.acceptance) || !data.acceptance.length) throw new Error('acceptance must be nonempty.');
  const acceptance = data.acceptance.map((value) => { const item = record(value); return { id: text(item.id, 'acceptance.id'), text: text(item.text, 'acceptance.text') }; });
  if (new Set(acceptance.map((item) => item.id)).size !== acceptance.length) throw new Error('acceptance ids must be unique.');
  const limits = record(data.limits ?? {});
  const limit = (name: string): number | null => {
    const value = limits[name] ?? null;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (name === 'max_worker_turns' && !Number.isInteger(value)))) throw new Error(`${name} must be positive or null.`);
    return value as number | null;
  };
  const task: Task = { schema_version: 1, task_id: taskId, workspace: resolve(workspace), goal: text(data.goal, 'goal'), acceptance, authorization: text(data.authorization, 'authorization'), limits: { max_worker_turns: limit('max_worker_turns'), max_minutes: limit('max_minutes') } };
  if (data.verify !== undefined) {
    const verify = record(data.verify);
    if (!Array.isArray(verify.argv) || !verify.argv.length || !verify.argv.every((value) => typeof value === 'string' && value.length)) throw new Error('verify.argv must be a nonempty string array.');
    if (typeof verify.timeout_seconds !== 'number' || !Number.isFinite(verify.timeout_seconds) || verify.timeout_seconds <= 0) throw new Error('verify.timeout_seconds must be positive.');
    if (!Array.isArray(verify.protected_files) || !verify.protected_files.every((value) => typeof value === 'string' && value.length)) throw new Error('verify.protected_files must be a string array.');
    task.verify = { argv: verify.argv as string[], timeout_seconds: verify.timeout_seconds, protected_files: verify.protected_files as string[] };
  }
  return task;
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!key || !['--state', '--task', '--test-fixture'].includes(key) || !value || value.startsWith('--') || flags.has(key)) throw new Error('Expected unique --task/--state/--test-fixture flags with values.');
    flags.set(key, value);
  }
  if (command === 'status') {
    const store = new Store(resolve(text(flags.get('--state'), '--state')));
    console.log(JSON.stringify(store.read(), null, 2));
    return;
  }
  if (command !== 'start' && command !== 'resume') throw new Error('Usage: codex-supervisor start --task FILE [--state FILE] [--test-fixture FILE] | resume --state FILE [--task FILE] [--test-fixture FILE] | status --state FILE.');
  // Before exclusivity, a resume checkpoint supplies only the lock identity.
  // Another owner may still update its status, contract or counters.
  const initial = command === 'resume' ? new Store(resolve(text(flags.get('--state'), '--state'))).read() : undefined;
  const initialTask = initial ? record(initial.task) : undefined;
  const startingTask = command === 'start' ? taskInput(readJson(resolve(text(flags.get('--task'), '--task')))) : undefined;
  const identity = initial ? { task_id: text(initial.task_id, 'task_id'), workspace: resolve(text(initialTask!.workspace, 'workspace')) } : startingTask!;
  const stateFile = resolve(flags.get('--state') ?? resolve('runs', identity.task_id, 'state.json'));
  const store = new Store(stateFile);
  store.lock(identity, command === 'resume');
  try {
    const saved = command === 'resume' ? store.read() : undefined;
    if (saved && (saved.schema_version !== 1 || saved.status === 'DONE')) throw new Error('DONE cannot resume; saved state must use schema_version 1.');
    const savedTask = saved ? taskInput(saved.task) : undefined;
    if (saved && (saved.task_id !== identity.task_id || savedTask!.task_id !== identity.task_id || savedTask!.workspace !== identity.workspace)) throw new Error('Saved task identity changed before the supervisor lock was acquired.');
    const task = saved && flags.has('--task') ? taskInput(readJson(resolve(flags.get('--task')!))) : savedTask ?? startingTask!;
    if (saved && (saved.task_id !== task.task_id || savedTask!.workspace !== task.workspace)) throw new Error('Explicit --task cannot change task_id or workspace.');
    if (saved && saved.status !== 'PAUSED' && (task.goal !== savedTask!.goal || task.authorization !== savedTask!.authorization)) throw new Error('Changing goal or authorization requires a durable PAUSED checkpoint first.');
    if (saved) {
      const limits = reachedLimits(task.limits, saved);
      if (limits.turns || limits.time) throw new Error('Cumulative user_limit reached; raise or remove the limit through explicit --task before resume.');
    }
    if (!saved && existsSync(stateFile)) throw new Error('Task state already exists; start cannot overwrite an existing task.');
    const fixturePath = flags.get('--test-fixture');
    const fixture = fixturePath ? record(readJson(resolve(fixturePath))) : undefined;
    let argv = codexCommand;
    let commandArgv: string[];
    if (fixture) {
      if (!Array.isArray(fixture.app_server_argv) || !fixture.app_server_argv.length || !fixture.app_server_argv.every((value) => typeof value === 'string')) throw new Error('Fixture app_server_argv must be a nonempty string array.');
      commandArgv = fixture.app_server_argv as string[];
      console.log('SIMULATED: app-server and judge fixtures are active.');
    } else commandArgv = argv();
    const state: State = saved ?? { schema_version: 1, task_id: task.task_id, task_version: 1, task, worker_thread_id: null, status: 'ACTIVE', phase: 'WORKER', active_worker_turn_id: null, reviewing_turn_id: null, handled_turn_ids: [], pending_action: null, retry: { kind: null, attempt: 0, next_at: null }, last_decision: null, worker_turn_count: 0, elapsed_active_seconds: 0, updated_at: new Date().toISOString(), codex_version: null, mode: fixture ? 'simulated' : 'live' };
    if (saved) {
      if (state.mode !== (fixture ? 'simulated' : 'live')) throw new Error('Resume must preserve simulated/live mode.');
      state.task = task;
      state.task_version++;
      state.status = 'ACTIVE';
      delete state.pause_reason;
      state.retry = { kind: null, attempt: 0, next_at: null };
    }
    const judgeDelay = fixture?.judge_delay_ms ?? 0;
    if (typeof judgeDelay !== 'number' || !Number.isFinite(judgeDelay) || judgeDelay < 0) throw new Error('Fixture judge_delay_ms must be a nonnegative number.');
    const judgeTimeout = fixture?.judge_timeout_ms ?? 120_000;
    if (typeof judgeTimeout !== 'number' || !Number.isFinite(judgeTimeout) || judgeTimeout <= 0) throw new Error('Fixture judge_timeout_ms must be positive.');
    const judge = fixture && fixture.real_judge !== true ? new FixtureJudge(fixture.judge as Decision | Decision[], judgeDelay, fixture.judge_ignores_cancellation === true, Array.isArray(fixture.judge_failures) ? fixture.judge_failures : undefined) : new AppServerJudge(judgeTimeout);
    const recoveryDelays = fixture?.recovery_delays_ms;
    if (recoveryDelays !== undefined && (!Array.isArray(recoveryDelays) || recoveryDelays.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0))) throw new Error('Fixture recovery_delays_ms must be a nonnegative number array.');
    const reconcileInterval = fixture?.reconcile_interval_ms;
    if (reconcileInterval !== undefined && (typeof reconcileInterval !== 'number' || !Number.isFinite(reconcileInterval) || reconcileInterval <= 0)) throw new Error('Fixture reconcile_interval_ms must be positive.');
    const supervisorOptions = fixture ? {
      simulate_verification: fixture.simulate_verification === true,
      recovery_enabled: fixture.recovery_enabled === true,
      real_judge: fixture.real_judge === true,
      ...(recoveryDelays === undefined ? {} : { recovery_delays_ms: recoveryDelays as number[] }),
      ...(reconcileInterval === undefined ? {} : { reconcile_interval_ms: reconcileInterval }),
      ...(fixture.native_thread_unload_once === true ? { native_thread_unload_once: true } : {}),
    } : process.env.CODEX_SUPERVISOR_TEST_NATIVE_THREAD_UNLOAD === '1' ? { native_thread_unload_once: true, recovery_enabled: true, real_judge: true } : undefined;
    const supervisor = new Supervisor(state, store, judge, supervisorOptions);
    const pause = () => supervisor.pause();
    // A foreground console delivers Ctrl+C as SIGINT.  When the CLI is driven
    // from a process harness (including Windows where child.kill('SIGINT') can
    // terminate the child without running JavaScript handlers), the same byte
    // is accepted on stdin so the durable pause path is exercised before the
    // owned calls are cancelled.
    const onStdin = (chunk: Buffer | string) => { if (String(chunk).includes('\u0003')) pause(); };
    process.on('SIGINT', pause);
    process.stdin.on('data', onStdin);
    try { await supervisor.start(commandArgv, !!saved); } finally { process.off('SIGINT', pause); process.stdin.off('data', onStdin); process.stdin.pause(); }
  } finally { store.release(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Supervisor failed.'); process.exitCode = 1; });
