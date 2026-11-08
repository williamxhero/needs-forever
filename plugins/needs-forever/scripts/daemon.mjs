#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../runtime/src/daemon-cli.js', import.meta.url));
const args = process.argv.slice(2);
const command = args.shift() ?? 'status';
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const workspaceArgs = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--workspace' && args[i + 1]) workspaceArgs.push(resolve(args[++i]));
const manifest = resolve(value('--state', resolve(homedir(), '.needs-forever', 'daemon.json')));
const pidFile = `${manifest}.pid`;
const port = Number(value('--port', '8790'));
const webPort = Number(value('--web-port', '8788'));
const tokenPath = resolve(dirname(manifest), 'daemon.token');
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; } };
const emit = (value) => console.log(JSON.stringify(value, null, 2));

async function main() {
  if (!['start', 'status', 'stop', 'install', 'uninstall'].includes(command)) throw new Error('Usage: daemon.mjs start|status|stop|install|uninstall [--workspace DIRECTORY] [--state FILE] [--port PORT].');
  if (command === 'install' || command === 'uninstall') {
    const taskName = 'Needs Forever Daemon';
    if (command === 'uninstall') {
      try { execFileSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' }); } catch { /* Already absent. */ }
      try { execFileSync('reg.exe', ['DELETE', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/V', 'NeedsForeverDaemon', '/F'], { stdio: 'ignore' }); } catch { /* Already absent. */ }
      emit({ uninstalled: true, task: taskName });
      return;
    }
    const taskRun = [`"${process.execPath}"`, `"${fileURLToPath(import.meta.url)}"`, 'start', '--state', `"${manifest}"`, '--port', String(port), '--web-port', String(webPort), ...workspaceArgs.flatMap((workspace) => ['--workspace', `"${workspace}"`])].join(' ');
    try {
      execFileSync('schtasks.exe', ['/Create', '/TN', taskName, '/SC', 'ONLOGON', '/TR', taskRun, '/F'], { stdio: 'pipe' });
      emit({ installed: true, mechanism: 'scheduled-task', task: taskName, command: taskRun, manifest });
    } catch {
      execFileSync('reg.exe', ['ADD', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/V', 'NeedsForeverDaemon', '/T', 'REG_SZ', '/D', taskRun, '/F'], { stdio: 'pipe' });
      emit({ installed: true, mechanism: 'user-run-key', task: taskName, command: taskRun, manifest });
    }
    return;
  }
  const receipt = readJson(pidFile);
  if (command === 'status') {
    const running = !!receipt?.pid && alive(receipt.pid);
    emit({ running, pid: running ? receipt.pid : null, manifest, url: receipt?.url ?? `http://127.0.0.1:${port}`, web_url: receipt?.web_url ?? `http://127.0.0.1:${webPort}`, token_path: tokenPath });
    return;
  }
  if (command === 'stop') {
    if (!receipt?.pid || !alive(receipt.pid)) { if (existsSync(pidFile)) unlinkSync(pidFile); emit({ stopped: true, running: false, manifest }); return; }
    process.kill(receipt.pid);
    emit({ stopped: true, pid: receipt.pid, manifest });
    return;
  }
  if (receipt?.pid && alive(receipt.pid)) { emit({ started: false, already_running: true, pid: receipt.pid, url: receipt.url, web_url: receipt.web_url, manifest }); return; }
  mkdirSync(dirname(manifest), { recursive: true });
  const childArgs = [runtime, 'start', '--port', String(port), '--web-port', String(webPort), '--state', manifest];
  for (const workspace of workspaceArgs.length ? workspaceArgs : [process.cwd()]) childArgs.push('--workspace', workspace);
  const child = spawn(process.execPath, childArgs, { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  child.unref();
  writeFileSync(pidFile, `${JSON.stringify({ pid: child.pid, url: `http://127.0.0.1:${port}`, web_url: `http://127.0.0.1:${webPort}`, manifest })}\n`, { encoding: 'utf8', mode: 0o600 });
  emit({ started: true, pid: child.pid, url: `http://127.0.0.1:${port}`, web_url: `http://127.0.0.1:${webPort}`, manifest, token_path: tokenPath });
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
