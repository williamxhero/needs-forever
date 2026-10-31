import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = resolve(process.argv[2] ?? `runs/ticket24/demo-${Date.now()}`);
if (existsSync(directory)) throw new Error('Choose a new evidence directory.');
const workspace = resolve(directory, 'workspace');
mkdirSync(workspace, { recursive: true });
const write = (name, value) => {
  const path = resolve(directory, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
};
const stateFile = resolve(directory, 'state.json');
const taskFile = write('task.json', {
  schema_version: 1, task_id: 's1-continuation-demonstration', workspace,
  goal: 'Complete all three fixture stages in the same worker.',
  acceptance: [{ id: 'A1', text: 'Two early finishes each cause a confirmed new turn, then fixed DONE.' }],
  authorization: 'Only this isolated simulated workspace may be changed.',
});
const scenarioFile = write('scenario.json', {
  trace: resolve(directory, 'protocol.jsonl'), state_file: stateFile,
  response_order: 'after-completed', duplicate_events: true,
  answer: 'This simulated turn finished one stage.',
});
const fixtureFile = write('fixture.json', {
  app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), scenarioFile],
  judge_delay_ms: 20,
  judge: [
    { action: 'CONTINUE', reason: 'Stage two remains.', evidence_ids: ['E1'], next_message: 'Complete fixture stage two.', external: null },
    { action: 'CONTINUE', reason: 'Stage three remains.', evidence_ids: ['E1'], next_message: 'Complete fixture stage three.', external: null },
    { action: 'DONE', reason: 'All fixed fixture stages are complete.', evidence_ids: ['E1'], next_message: '', external: null },
  ],
});
for (const [name, args] of [
  ['start', ['start', '--task', taskFile, '--state', stateFile, '--test-fixture', fixtureFile]],
  ['status', ['status', '--state', stateFile]],
]) {
  const result = spawnSync(process.execPath, [resolve('dist/src/cli.js'), ...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  writeFileSync(resolve(directory, `${name}.stdout.txt`), result.stdout ?? '');
  writeFileSync(resolve(directory, `${name}.stderr.txt`), result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${name} failed; inspect ${directory}.`);
  process.stdout.write(result.stdout);
}
console.log(`SIMULATED evidence saved to ${directory}`);
