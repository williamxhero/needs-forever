import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Creates a fresh, isolated three-stage exercise. It never starts a model.
const directory = resolve(process.argv[2] ?? `runs/s2-demo/${Date.now()}`);
const workspace = resolve(directory, 'workspace');
mkdirSync(workspace, { recursive: true });
const route = `import { writeFileSync } from 'node:fs';\nwriteFileSync('route-attempted.txt', 'required-first-route-failed');\nconsole.error('The first route is deliberately unavailable. Use the authorized direct-file alternative.');\nprocess.exitCode = 23;\n`;
const verify = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (name) => JSON.parse(readFileSync(name, 'utf8'));
try {
  assert.equal(readFileSync('route-attempted.txt', 'utf8'), 'required-first-route-failed');
  assert.deepEqual(read('stage1.json'), { stage: 1, value: 'alpha' });
  assert.deepEqual(read('stage2.json'), { stage: 2, value: 'alpha-beta' });
  assert.deepEqual(read('final.json'), { stage: 3, value: 'alpha-beta-gamma' });
  console.log('All three independent stage checks PASS; the failed first route was attempted.');
} catch (error) {
  console.error('Independent acceptance FAIL:', error.message);
  process.exitCode = 1;
}
`;
writeFileSync(resolve(workspace, 'unavailable-route.mjs'), route);
writeFileSync(resolve(workspace, 'verify.mjs'), verify);
const task = {
  schema_version: 1, task_id: `s2-demo-${Date.now()}`, workspace,
  goal: 'Complete all three stages in this isolated workspace. Stage 1: first run unavailable-route.mjs, preserve its failed-route marker, then use the materially different authorized direct-file alternative to write stage1.json exactly {"stage":1,"value":"alpha"}. Stage 2: read stage1.json and write stage2.json exactly {"stage":2,"value":"alpha-beta"}. Stage 3: read stage2.json and write final.json exactly {"stage":3,"value":"alpha-beta-gamma"}. This is a supervision exercise: the WORKER must perform at most one unfinished stage per turn, then end that turn with its stage evidence. The full original goal remains all three stages; the supervisor must continue until all acceptance passes. Preserve previous stages. Never weaken or replace the independent verifier or the deliberately unavailable first route.',
  acceptance: [
    { id: 'A1', text: 'The required first route was actually attempted and failed; the direct-file alternative produced exact stage1.json.' },
    { id: 'A2', text: 'stage2.json has stage 2 and value alpha-beta.' },
    { id: 'A3', text: 'final.json has stage 3 and value alpha-beta-gamma, and the fixed independent verifier succeeds.' },
  ],
  authorization: 'Use only local commands and files inside this isolated workspace. No network, external messages, credential access or permission expansion. Running the deliberately failing local route and changing to the direct-file route is pre-authorized. Do not modify verify.mjs or unavailable-route.mjs. Ordinary implementation choices are pre-authorized. All three stages are authorized without asking whether to continue.',
  verify: { argv: [process.execPath, 'verify.mjs'], timeout_seconds: 15, protected_files: ['verify.mjs', 'unavailable-route.mjs'] },
  limits: { max_worker_turns: null, max_minutes: null },
};
const taskFile = resolve(directory, 'task.json');
const stateFile = resolve(directory, 'state.json');
writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`);
const command = [process.execPath, resolve('dist/src/cli.js'), 'start', '--task', taskFile, '--state', stateFile];
console.log(JSON.stringify({ mode: 'live entry prepared; not_run', directory, workspace, task_file: taskFile, state_file: stateFile, command, status_command: [process.execPath, resolve('dist/src/cli.js'), 'status', '--state', stateFile] }, null, 2));
