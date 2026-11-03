import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Preparation only: no model, task start, installation or trust mutation.
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--directory', '--plugin'].includes(key) || flags[key] || !value || !isAbsolute(value)) throw new Error('Expected unique absolute --directory and --plugin paths.');
  flags[key] = resolve(value);
}
if (!flags['--directory'] || !flags['--plugin']) throw new Error('--directory and --plugin are required.');
const directory = flags['--directory'];
const control = resolve(flags['--plugin'], 'scripts/control.mjs');
if (!existsSync(control)) throw new Error('Installed plugin control is missing.');
if (existsSync(resolve(directory, 'workspace'))) throw new Error('Use a fresh demo directory; existing workspace will not be overwritten.');
const prepared = spawnSync(process.execPath, [fileURLToPath(new URL('./prepare-s2-demo.mjs', import.meta.url)), directory], { encoding: 'utf8', windowsHide: true });
if (prepared.status !== 0) throw new Error(prepared.stderr);
const base = JSON.parse(prepared.stdout);
const command = [process.execPath, control, 'start', '--task', base.task_file, '--state', base.state_file];
const task = JSON.parse(readFileSync(base.task_file, 'utf8'));
// Legacy workers execute a new turn after each judgment. Native Stop instead
// continues the existing turn, so only the main-session exercise changes this
// pacing constraint; its three acceptance items and protected verifier remain.
const legacyPacing = 'at most one unfinished stage per turn, then end that turn with its stage evidence.';
if (!task.goal.includes(legacyPacing)) throw new Error('Legacy exercise pacing changed; review the main-session contract adaptation.');
task.goal = task.goal.replace(legacyPacing, 'at most one unfinished stage per response between consecutive Stop attempts, then end that response with its stage evidence. After a Stop continuation, perform the next unfinished stage even when the host remains in the same native turn.');
writeFileSync(base.task_file, JSON.stringify(task, null, 2) + '\n');
const prompt = `Open a Desktop chat whose actual workspace/cwd is exactly ${base.workspace}, then paste this complete prompt. Changing only a shell tool's workdir in another chat does not change native event.cwd and cannot bind this task.\n\nUse the installed needs-forever:supervise skill in this Desktop chat. This chat is worker A. Start the prepared main-session task by executing the following argv as one native tool command, preserving all paths and arguments:\n\n${JSON.stringify(command)}\n\nFull goal:\n${task.goal}\n\nAcceptance:\n${task.acceptance.map((item) => `${item.id}: ${item.text}`).join('\n')}\n\nAuthorization:\n${task.authorization}\n\nAfter native pre/post tool binding confirms B is active, perform only one unfinished stage, report its actual tool evidence, and end your response. The Stop hook must check the full goal and continue this same chat. Do not manually execute all stages in one response or create an independent worker. Do not change protected files. If hook trust or native binding is unavailable, report the exact pending gate without claiming supervision.\n`;
writeFileSync(resolve(directory, 'desktop-launch-prompt.txt'), prompt, 'utf8');
const receipt = { ...base, mode: 'main-session preparation only', live_desktop_acceptance: 'not_run', command, status_command: [process.execPath, control, 'status', '--state', base.state_file], pause_command: [process.execPath, control, 'pause', '--state', base.state_file], resume_command: [process.execPath, control, 'resume', '--state', base.state_file], launch_prompt: resolve(directory, 'desktop-launch-prompt.txt'), required_gate: 'Install candidate in actual Desktop, review and trust hooks through Settings > Hooks, reload if required, then execute the prompt in an authorized Desktop A.' };
writeFileSync(resolve(directory, 'preparation.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
