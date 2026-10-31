import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = resolve(process.argv[2] ?? `runs/ticket23/demo-${Date.now()}`);
if (existsSync(directory)) throw new Error('Use a new output directory; existing evidence is never overwritten.');
const workspace = resolve(directory, 'workspace');
mkdirSync(workspace, { recursive: true });
const taskFile = resolve(directory, 'task.json');
const stateFile = resolve(directory, 'state.json');
const scenarioFile = resolve(directory, 'scenario.json');
const fixtureFile = resolve(directory, 'fixture.json');
const task = { schema_version: 1, task_id: 's1-start-demonstration', workspace, goal: 'Demonstrate the initial worker turn and a queryable external wait.', acceptance: [{ id: 'A1', text: 'The initial turn is confirmed and the complete task is retained.' }], authorization: 'Only this isolated local fixture workspace may be changed.' };
writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`);
writeFileSync(scenarioFile, `${JSON.stringify({ trace: resolve(directory, 'protocol.jsonl'), mcp_servers: ['fixture.external'], answer: 'The first fixture stage is complete. Required fixture input is unavailable.' }, null, 2)}\n`);
writeFileSync(fixtureFile, `${JSON.stringify({ app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), scenarioFile], judge: { action: 'WAIT_EXTERNAL', reason: 'The fixed fixture demonstrates a concrete external wait, not semantic completion.', evidence_ids: ['E1'], next_message: '', external: { missing: 'The demonstration input fixture.', attempted: ['The fixture stage returned without the required input.'], why_no_other_work: 'The remaining fixture step depends on that input.', resume_when: 'Supply the demonstration input fixture.' } } }, null, 2)}\n`);
const cli = resolve('dist/src/cli.js');
for (const [name, argv] of [['start', ['start', '--task', taskFile, '--state', stateFile, '--test-fixture', fixtureFile]], ['status', ['status', '--state', stateFile]]]) {
  const result = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  writeFileSync(resolve(directory, `${name}.stdout.txt`), result.stdout ?? '');
  writeFileSync(resolve(directory, `${name}.stderr.txt`), result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${name} failed; inspect ${directory}.`);
  process.stdout.write(result.stdout);
}
console.log(`SIMULATED evidence saved to ${directory}`);
