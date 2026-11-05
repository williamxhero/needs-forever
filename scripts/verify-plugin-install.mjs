import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { platform, release } from 'node:os';
import { codexCommand } from '../plugins/needs-forever/runtime/src/transport.js';

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--directory', '--candidate', '--codex-argv'].includes(process.argv[i]) || flags[process.argv[i]] || !process.argv[i + 1]) throw new Error('Expected unique --directory/--candidate/--codex-argv values.');
  flags[process.argv[i]] = process.argv[i + 1];
}
const directory = resolve(flags['--directory'] ?? `runs/plugin-install/${Date.now()}`);
const candidate = resolve(flags['--candidate'] ?? '.');
const codexHome = resolve(directory, 'codex-home');
const workspace = resolve(directory, 'workspace');
mkdirSync(codexHome, { recursive: true });
mkdirSync(workspace, { recursive: true });
const argv = flags['--codex-argv'] ? JSON.parse(flags['--codex-argv']) : codexCommand();
if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string')) throw new Error('codex-argv must be a JSON array of strings.');
const [executable, ...prefix] = argv;
const env = { ...process.env, CODEX_HOME: codexHome };
const evidence = { mode: 'isolated-install-discovery-no-model', directory, candidate, codex_home: codexHome, workspace, os: { platform: platform(), release: release() }, node: process.version, commands: [], native_effectiveness: 'not_run', discovery_pass: false };
const save = () => writeFileSync(resolve(directory, 'install.json'), JSON.stringify(evidence, null, 2) + '\n');
function hashes(root, prefix = '') {
  return Object.fromEntries(readdirSync(resolve(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Package symlinks are not supported: ${name}`);
    return entry.isDirectory() ? Object.entries(hashes(root, name)) : [[name, createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex')]];
  }));
}
function inside(root, path) { const suffix = relative(root, resolve(path)); return suffix !== '' && !suffix.startsWith('..') && !isAbsolute(suffix); }
let server, lines;
const pending = new Map();
try {
  evidence.candidate_hashes = hashes(resolve(candidate, 'plugins/needs-forever'));
  evidence.plugin_version = JSON.parse(readFileSync(resolve(candidate, 'plugins/needs-forever/.codex-plugin/plugin.json'), 'utf8')).version;
  let installedPath;
  for (const args of [['--version'], ['plugin', 'marketplace', 'add', candidate, '--json'], ['plugin', 'add', 'needs-forever@needs-forever-local', '--json'], ['plugin', 'list', '--marketplace', 'needs-forever-local', '--json']]) {
    const result = spawnSync(executable, [...prefix, ...args], { cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    evidence.commands.push({ argv: [executable, ...prefix, ...args], cwd: workspace, codex_home: codexHome, exit_code: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }); save();
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Plugin installation failed.');
    if (args[0] === '--version') evidence.codex_version = result.stdout.trim();
    if (args[1] === 'add') installedPath = JSON.parse(result.stdout).installedPath;
  }
  if (!installedPath || !inside(codexHome, installedPath)) throw new Error('Host did not return an installedPath inside the isolated home.');
  evidence.installed_path = installedPath;
  evidence.installed_hashes = hashes(installedPath);
  evidence.package_matches_candidate = JSON.stringify(evidence.candidate_hashes) === JSON.stringify(evidence.installed_hashes);
  if (!evidence.package_matches_candidate) throw new Error('Installed package differs from candidate.');
  evidence.app_server_argv = [executable, ...prefix, 'app-server'];
  server = spawn(executable, [...prefix, 'app-server'], { cwd: workspace, env, windowsHide: true, stdio: 'pipe' });
  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-65536); });
  const fail = (error) => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  server.on('error', fail);
  server.on('exit', (code) => fail(new Error(`Owned discovery server exited: ${code}; ${stderr}`)));
  lines = createInterface({ input: server.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error('Malformed app-server JSON.')); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.done(message.result);
  });
  let sequence = 0;
  const rpc = (method, params) => new Promise((done, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 20_000);
    pending.set(id, { done, reject, timer });
    server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  evidence.initialize = await rpc('initialize', { clientInfo: { name: 'needs-forever-install-check', title: 'Isolated hook discovery', version: evidence.plugin_version }, capabilities: { experimentalApi: false, requestAttestation: false, explicitGatewayOauth: true } });
  if (resolve(evidence.initialize.codexHome) !== codexHome) throw new Error('Server initialized with another CODEX_HOME.');
  server.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  evidence.skills_raw = await rpc('skills/list', { cwds: [workspace], forceReload: true });
  evidence.hooks_raw = await rpc('hooks/list', { cwds: [workspace] });
  evidence.skills = evidence.skills_raw.data.flatMap((entry) => entry.skills).filter((skill) => skill.pluginId === 'needs-forever@needs-forever-local' && skill.name === 'needs-forever:supervise');
  evidence.hooks = evidence.hooks_raw.data.flatMap((entry) => entry.hooks).filter((hook) => hook.source === 'plugin' && hook.pluginId === 'needs-forever@needs-forever-local');
  const expected = Object.keys(JSON.parse(readFileSync(resolve(installedPath, 'hooks/hooks.json'), 'utf8')).hooks);
  const missing = expected.filter((event) => !evidence.hooks.some((hook) => hook.eventName === event[0].toLowerCase() + event.slice(1)));
  const candidateErrors = [...evidence.skills_raw.data, ...evidence.hooks_raw.data].flatMap((entry) => entry.errors ?? []).filter((error) => error.path && inside(installedPath, error.path));
  evidence.human_trust_required = evidence.hooks.some((hook) => !['trusted', 'managed'].includes(hook.trustStatus));
  evidence.effective_hooks_claimed = false;
  if (evidence.skills.length !== 1 || missing.length || candidateErrors.length || evidence.hooks.some((hook) => !inside(installedPath, hook.sourcePath))) throw new Error(`Candidate discovery failed: missing=${missing}; candidate errors=${JSON.stringify(candidateErrors)}`);
  evidence.discovery_pass = true;
  save();
  console.log(JSON.stringify({ discovery_pass: true, native_effectiveness: 'not_run', human_trust_required: evidence.human_trust_required, installed_path: installedPath, evidence: resolve(directory, 'install.json') }, null, 2));
} catch (error) { evidence.error = error.message; save(); console.error(error.message); process.exitCode = 1; }
finally {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear(); lines?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((done) => server.once('exit', done));
    server.kill();
    await Promise.race([exited, new Promise((done) => { const timer = setTimeout(done, 3000); timer.unref(); })]);
  }
}
