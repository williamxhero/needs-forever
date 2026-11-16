import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { State } from '../types.js';
import { TaskCatalog } from './catalog.js';
import { asRecord } from './projection.js';
import { WEB_HTML } from './ui.js';

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(body);
}

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let value = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { value += chunk; if (value.length > 64 * 1024) reject(new Error('Request body too large.')); });
    request.on('end', () => resolveBody(value));
    request.on('error', reject);
  });
}

function controlScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/control.mjs');
}

function runControl(command: 'pause' | 'resume' | 'delete', statePath: string, workspace: string, taskId: string, daemon?: { url: string; token: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  if (daemon) {
    return fetch(`${daemon.url}/api/tasks/${encodeURIComponent(taskId)}/control`, { method: 'POST', headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: command }) })
      .then(async (response) => ({ code: response.ok ? 0 : response.status, stdout: await response.text(), stderr: response.ok ? '' : response.statusText }))
      .catch((error) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  }
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [controlScriptPath(), command, '--state', statePath], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}

function archiveDeletedTaskAudit(root: string, directory: string, taskId: string, statePath: string): void {
  const auditDirectory = resolve(root, 'system-audit');
  mkdirSync(auditDirectory, { recursive: true });
  const eventsPath = resolve(directory, 'events.jsonl');
  const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '';
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as State : null;
  const audit = { event_id: randomUUID(), at: new Date().toISOString(), type: 'task_deleted', task_id: taskId, task_version: state?.task_version ?? null, status: state?.status ?? null, event_count: events.split('\n').filter(Boolean).length, preserved_events: events ? events.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [] };
  appendFileSync(resolve(auditDirectory, 'events.jsonl'), `${JSON.stringify(audit)}\n`, 'utf8');
}

function html(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(WEB_HTML);
}

export interface WebServerOptions {
  workspace: string;
  workspaces?: string[];
  host?: '127.0.0.1' | 'localhost';
  port?: number;
  daemonApi?: string;
  daemonToken?: string;
}

export interface RunningWebServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const workspaces = [...new Set([options.workspace, ...(options.workspaces ?? [])].map((workspace) => resolve(workspace)))];
  for (const workspace of workspaces) if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error('workspace must name an existing directory.');
  const workspace = workspaces[0]!;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer between 0 and 65535.');
  const catalog = new TaskCatalog({ workspace, workspaces });
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      response.setHeader('allow', 'GET, HEAD, POST');
      return json(response, 405, { error: 'method not allowed' });
    }
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', `http://${host}`).pathname; }
    catch { return json(response, 400, { error: 'invalid url' }); }
    if (pathname === '/healthz') return json(response, 200, { ok: true });
    if (pathname === '/api/tasks') return json(response, 200, { tasks: catalog.list() });
    if (pathname.startsWith('/api/tasks/')) {
      let taskId: string;
      try { taskId = decodeURIComponent(pathname.slice('/api/tasks/'.length)); }
      catch { return json(response, 400, { error: 'invalid task id' }); }
      if (request.method === 'POST' && taskId.endsWith('/control')) {
        taskId = taskId.slice(0, -'/control'.length);
        let action: unknown;
        try { action = JSON.parse(await body(request)); } catch { return json(response, 400, { error: 'invalid json body' }); }
        const operation = asRecord(action)?.action;
        if (operation !== 'pause' && operation !== 'resume' && operation !== 'delete') return json(response, 400, { error: 'action must be pause, resume or delete' });
        try {
          const located = catalog.locate(taskId);
          // pi-nf publishes a read-only audit projection into NFG. Its pause,
          // resume and delete operations require the pi-nf writer lease and
          // belong to the pi-nf CLI, not to the Codex control script.
          if (located.source === 'pi-nf') return json(response, 409, { error: 'pi-nf tasks are read-only in NFG.' });
          const directory = located.directory;
          const statePath = resolve(directory, 'state.json');
          if (!existsSync(statePath)) return json(response, 404, { error: 'Task not found.' });
          if (operation === 'delete') {
            const paused = await runControl('pause', statePath, located.workspace, taskId, options.daemonApi && options.daemonToken ? { url: options.daemonApi, token: options.daemonToken } : undefined).catch(() => null);
            if (paused && paused.code !== 0) {
              let persistedStatus: string | null = null;
              try { persistedStatus = (JSON.parse(readFileSync(statePath, 'utf8')) as State).status; } catch { /* deletion below reports the real filesystem outcome */ }
              if (persistedStatus !== 'PAUSED' && persistedStatus !== 'INTERRUPTED' && !/already paused|PAUSED/i.test(paused.stderr + paused.stdout)) return json(response, 409, { error: paused.stderr || paused.stdout || 'Unable to pause task before delete.' });
            }
            archiveDeletedTaskAudit(located.root, directory, taskId, statePath);
            rmSync(directory, { recursive: true, force: true });
            return json(response, 200, { deleted: true, taskId });
          }
          const result = await runControl(operation, statePath, located.workspace, taskId, options.daemonApi && options.daemonToken ? { url: options.daemonApi, token: options.daemonToken } : undefined);
          if (result.code !== 0) return json(response, 409, { error: result.stderr.trim() || result.stdout.trim() || `Unable to ${operation} task.` });
          return json(response, 200, { action: operation, taskId, output: result.stdout });
        } catch (error) { return json(response, 500, { error: error instanceof Error ? error.message : 'control operation failed' }); }
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'method not allowed' });
      try {
        const record = catalog.read(taskId);
        return json(response, 200, catalog.sourceOf(taskId) === 'pi-nf' ? { ...record, readOnly: true } : record);
      }
      catch (error) { return json(response, 404, { error: error instanceof Error ? error.message : 'task not found' }); }
    }
    if (pathname === '/' || pathname.startsWith('/tasks/')) return html(response);
    return json(response, 404, { error: 'not found' });
  });
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(port, host, resolvePromise); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Web server did not expose a TCP address.');
  const url = `http://${host}:${address.port}/`;
  return { server, url, close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())) };
}

