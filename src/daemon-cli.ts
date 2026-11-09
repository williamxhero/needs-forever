#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NFDaemon, startLoopbackApi } from './daemon.js';
import { startWebServer, type RunningWebServer } from './web.js';

type ParsedFlags = Map<string, string[]>;

function flags(argv: string[]): ParsedFlags {
  const result: ParsedFlags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (!key || !value || !key.startsWith('--') || value.startsWith('--')) throw new Error('Expected daemon flags with values.');
    const values = result.get(key) ?? [];
    values.push(value);
    result.set(key, values);
  }
  return result;
}

function one(options: ParsedFlags, key: string): string | undefined { return options.get(key)?.at(-1); }
function many(options: ParsedFlags, key: string): string[] { return options.get(key) ?? []; }
function windowsQuote(value: string): string { return `"${value.replaceAll('"', '\\\"')}"`; }

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'NeedsForeverDaemon';

function installWindowsAutostart(options: ParsedFlags, workspaces: string[]): Record<string, unknown> {
  if (process.platform !== 'win32') throw new Error('Windows automatic startup is only supported on Windows.');
  const state = resolve(one(options, '--state') ?? `${process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.cwd()}\\NeedsForever\\daemon.json`);
  const dataDirectory = resolve(state, '..');
  mkdirSync(dataDirectory, { recursive: true });
  const config = { schema_version: 1, workspaces, state, port: Number(one(options, '--port') ?? 8790), web_port: Number(one(options, '--web-port') ?? 8788), installed_at: new Date().toISOString() };
  writeFileSync(resolve(dataDirectory, 'daemon-start.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const script = resolve(fileURLToPath(new URL('./daemon-cli.js', import.meta.url)));
  const args = ['start', ...workspaces.flatMap((workspace) => ['--workspace', workspace]), '--state', state, '--port', String(config.port), '--web-port', String(config.web_port)];
  const command = [process.execPath, script, ...args].map(windowsQuote).join(' ');
  execFileSync('reg.exe', ['ADD', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', command, '/f'], { windowsHide: true, stdio: 'ignore' });
  return { installed: true, registry: `${RUN_KEY}\\${RUN_NAME}`, command, config: resolve(dataDirectory, 'daemon-start.json') };
}

function uninstallWindowsAutostart(): Record<string, unknown> {
  if (process.platform !== 'win32') throw new Error('Windows automatic startup is only supported on Windows.');
  try { execFileSync('reg.exe', ['DELETE', RUN_KEY, '/v', RUN_NAME, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already absent */ }
  return { uninstalled: true, registry: `${RUN_KEY}\\${RUN_NAME}` };
}

async function main(): Promise<void> {
  const [command = 'start', ...argv] = process.argv.slice(2);
  const options = flags(argv);
  if (!['start', 'status', 'install', 'uninstall'].includes(command)) throw new Error('Usage: daemon [start|status|install|uninstall] --workspace DIRECTORY [--workspace DIRECTORY ...] [--state FILE] [--port PORT].');
  const workspaces = many(options, '--workspace').map((workspace) => resolve(workspace));
  if (!workspaces.length) workspaces.push(resolve('.'));
  if (command === 'install') { console.log(JSON.stringify(installWindowsAutostart(options, workspaces), null, 2)); return; }
  if (command === 'uninstall') { console.log(JSON.stringify(uninstallWindowsAutostart(), null, 2)); return; }
  const daemon = new NFDaemon({ workspaces, ...(one(options, '--state') ? { dataPath: one(options, '--state')! } : {}), ...(one(options, '--interval') ? { intervalMs: Number(one(options, '--interval')!) } : {}) });
  if (command === 'status') { await daemon.tick(); console.log(JSON.stringify(daemon.status(), null, 2)); return; }
  daemon.start();
  const api = await startLoopbackApi({ daemon, port: one(options, '--port') ? Number(one(options, '--port')!) : 0, ...(one(options, '--token') ? { token: one(options, '--token')! } : {}) });
  let web: RunningWebServer | undefined;
  if (one(options, '--web-port')) web = await startWebServer({ workspace: workspaces[0]!, workspaces, port: Number(one(options, '--web-port')!), daemonApi: api.url, daemonToken: api.token });
  console.log(JSON.stringify({ url: api.url, web_url: web?.url ?? null, pid: process.pid, tokenPath: daemon.tokenPath }));
  await new Promise<void>((resolvePromise) => {
    const stop = () => { daemon.stop(); void Promise.all([api.close(), web?.close() ?? Promise.resolve()]).finally(resolvePromise); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'NF daemon failed.'); process.exitCode = 1; });
