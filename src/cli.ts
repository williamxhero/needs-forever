#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Store } from './store.js';
import { FixtureJudge, UnavailableJudge } from './judge.js';
import { Supervisor } from './supervisor.js';
import { codexCommand } from './transport.js';
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
  if (command !== 'start') throw new Error('Usage: codex-supervisor start --task FILE [--state FILE] [--test-fixture FILE] | status --state FILE. resume is delivered by ticket #25.');
  const task = taskInput(readJson(resolve(text(flags.get('--task'), '--task'))));
  const stateFile = resolve(flags.get('--state') ?? resolve('runs', task.task_id, 'state.json'));
  const store = new Store(stateFile);
  store.lock(task);
  try {
    if (existsSync(stateFile)) throw new Error('Task state already exists; start cannot overwrite an existing task.');
    const fixturePath = flags.get('--test-fixture');
    const fixture = fixturePath ? record(readJson(resolve(fixturePath))) : undefined;
    let argv = codexCommand;
    let commandArgv: string[];
    if (fixture) {
      if (!Array.isArray(fixture.app_server_argv) || !fixture.app_server_argv.length || !fixture.app_server_argv.every((value) => typeof value === 'string')) throw new Error('Fixture app_server_argv must be a nonempty string array.');
      commandArgv = fixture.app_server_argv as string[];
      console.log('SIMULATED: app-server and judge fixtures are active.');
    } else commandArgv = argv();
    const state: State = { schema_version: 1, task_id: task.task_id, task_version: 1, task, worker_thread_id: null, status: 'ACTIVE', phase: 'WORKER', active_worker_turn_id: null, reviewing_turn_id: null, handled_turn_ids: [], pending_action: null, retry: { kind: null, attempt: 0, next_at: null }, last_decision: null, worker_turn_count: 0, elapsed_active_seconds: 0, updated_at: new Date().toISOString(), codex_version: null, mode: fixture ? 'simulated' : 'live' };
    const judge = fixture ? new FixtureJudge(fixture.judge as Decision) : new UnavailableJudge();
    await new Supervisor(state, store, judge).start(commandArgv);
  } finally { store.release(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Supervisor failed.'); process.exitCode = 1; });
