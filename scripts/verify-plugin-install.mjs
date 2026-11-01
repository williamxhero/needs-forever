import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { codexCommand } from '../plugins/needs-forever/runtime/src/transport.js';

const directory = resolve('runs/plugin-install', String(Date.now()));
const codexHome = resolve(directory, 'codex-home');
mkdirSync(codexHome, { recursive: true });
const [executable, ...prefix] = codexCommand();
const evidence = { mode: 'live-local-install-no-model', commands: [], directory };
let installedPath;
for (const args of [
  ['plugin', 'marketplace', 'add', resolve('.'), '--json'],
  ['plugin', 'add', 'needs-forever@needs-forever-local', '--json'],
  ['plugin', 'list', '--marketplace', 'needs-forever-local', '--json'],
]) {
  const result = spawnSync(executable, [...prefix, ...args], { env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  evidence.commands.push({ argv: [executable, ...prefix, ...args], exit_code: result.status, stdout: result.stdout, stderr: result.stderr });
  writeFileSync(resolve(directory, 'install.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(result.stdout);
  if (result.status !== 0) throw new Error(result.stderr || 'Plugin installation failed.');
  if (args[0] === 'plugin' && args[1] === 'add') installedPath = JSON.parse(result.stdout).installedPath;
}
// Probe the real host's skill loader without starting a model or task.
const server = spawn(executable, [...prefix, 'app-server'], { cwd: resolve('.'), env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, stdio: 'pipe' });
server.stderr.resume();
let sequence = 0;
const pending = new Map();
const lines = createInterface({ input: server.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!pending.has(message.id)) return;
  const { done, reject, timer } = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(timer);
  message.error ? reject(new Error(JSON.stringify(message.error))) : done(message.result);
});
const rpc = (method, params) => new Promise((done, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15_000);
  pending.set(id, { done, reject, timer });
  server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
try {
  await rpc('initialize', { clientInfo: { name: 'needs-forever-install-check', version: '0.2.0' }, capabilities: { experimentalApi: false } });
  server.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const skills = await rpc('skills/list', { cwds: [resolve('.')], forceReload: true });
  evidence.skills = skills.data.flatMap((entry) => entry.skills).filter((skill) => skill.pluginId === 'needs-forever@needs-forever-local' && skill.name === 'needs-forever:supervise');
  evidence.skill_errors = skills.data.flatMap((entry) => entry.errors);
  writeFileSync(resolve(directory, 'install.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (evidence.skills.length !== 1) throw new Error('Installed plugin skill is not discoverable by the actual host.');
} finally {
  const exited = once(server, 'exit');
  server.kill();
  await exited;
  lines.close();
  for (const { timer } of pending.values()) clearTimeout(timer);
}
const doctor = spawnSync(process.execPath, [resolve(installedPath, 'scripts/control.mjs'), 'doctor'], { cwd: directory, env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
evidence.installed_doctor = { exit_code: doctor.status, stdout: doctor.stdout, stderr: doctor.stderr };
writeFileSync(resolve(directory, 'install.json'), JSON.stringify(evidence, null, 2) + '\n');
if (doctor.status !== 0) throw new Error(doctor.stderr);
console.log(`Discovered plugin skill: ${evidence.skills[0].name}`);
console.log(`Installation evidence: ${directory}`);
