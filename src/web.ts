import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { State } from './types.js';

export interface TaskStateView {
  taskId: string;
  status: State['status'];
  phase: State['phase'];
  mode: State['mode'];
  goal: string;
  workspace: string;
  acceptance: { id: string; text: string }[];
  workerThreadId: string | null;
  workerTurnCount: number;
  updatedAt: string;
  lastDecision: State['last_decision'];
  retry: State['retry'];
  lastError: string | null;
  pauseReason: State['pause_reason'] | null;
  recoveryCondition: State['recovery_condition'] | null;
}

export interface HumanEvent {
  at: string;
  role: 'worker' | 'supervisor' | 'system';
  eventType: string;
  summary: string;
  result: string | null;
  details: Record<string, unknown>;
}

export interface TechnicalEvent extends HumanEvent {
  threadId: string | null;
  turnId: string | null;
  deliveryId: string | null;
  snapshotId: string | null;
}

export interface WorkRound {
  id: string;
  startedAt: string;
  endedAt: string;
  worker: HumanEvent | null;
  supervisor: HumanEvent[];
  result: HumanEvent | null;
  technicalEvents: TechnicalEvent[];
}

export interface TaskSummary {
  taskId: string;
  status: State['status'];
  phase: State['phase'];
  updatedAt: string;
  lastResult: string;
}

export interface TaskRecord {
  taskId: string;
  state: TaskStateView;
  summary: string;
  rounds: WorkRound[];
  eventCount: number;
  snapshotIds: string[];
  updatedAt: string;
}

export interface TaskCatalogOptions {
  workspace: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function eventTime(event: Record<string, unknown>): string {
  return stringValue(event.at) ?? new Date(0).toISOString();
}

function eventRole(event: Record<string, unknown>): HumanEvent['role'] {
  const role = stringValue(event.role);
  if (role === 'worker' || role === 'judge' || role === 'supervisor') return role === 'judge' ? 'supervisor' : role;
  const type = stringValue(event.type) ?? '';
  if (type.startsWith('worker_') || type === 'send_prepared' || type === 'send_attempted' || type === 'send_confirmed') return 'worker';
  if (type.startsWith('judge_') || type === 'decision' || type.startsWith('verification_') || type.startsWith('recovery_') || type.startsWith('stale_') || type.startsWith('external_')) return 'supervisor';
  return 'system';
}

function decision(event: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(event.decision);
}

function eventResult(event: Record<string, unknown>): string | null {
  const type = stringValue(event.type) ?? '';
  const rawDecision = decision(event);
  const action = stringValue(rawDecision?.action);
  if (action) return action;
  const status = stringValue(event.status);
  if (type.startsWith('worker_') && status) return status;
  if (type === 'verification_result') {
    const passed = event.passed;
    if (typeof passed === 'boolean') return passed ? 'PASS' : 'FAIL';
  }
  if (type === 'send_confirmed') return 'CONFIRMED';
  if (type === 'external_wait_required') return 'WAIT_EXTERNAL';
  if (type === 'paused') return 'PAUSED';
  return null;
}

function eventSummary(event: Record<string, unknown>): string {
  const type = stringValue(event.type) ?? 'unknown';
  const rawDecision = decision(event);
  const action = stringValue(rawDecision?.action);
  const reason = stringValue(rawDecision?.reason);
  const error = stringValue(event.error) ?? stringValue(event.message);
  const status = stringValue(event.status);
  switch (type) {
    case 'worker_created': return 'worker 已创建';
    case 'worker_resumed': return 'worker 已恢复';
    case 'worker_started': return 'worker 开始工作';
    case 'worker_completed': return `worker 回合结束${status ? `，状态为 ${status}` : ''}`;
    case 'worker_interrupted': return 'worker 回合被中断';
    case 'worker_failed': return 'worker 回合失败';
    case 'worker_output': return 'worker 输出了一条结果';
    case 'decision': return `${action ? `判断为 ${action}` : 'supervisor 完成判断'}${reason ? `：${reason}` : ''}`;
    case 'send_prepared': return '已准备发送下一步指令';
    case 'send_attempted': return '已发送下一步指令，等待确认';
    case 'send_confirmed': return '下一轮已确认开始';
    case 'verification_result': return '独立验收已返回结果';
    case 'verification_started':
    case 'fixture_verification_started': return '开始独立验收';
    case 'verification_failed': return '独立验收失败';
    case 'external_wait_required': return '进入外部等待';
    case 'recovery_required': return error ? `需要恢复：${error}` : '需要恢复';
    case 'recovery_retry_scheduled': return error ? `已安排恢复重试：${error}` : '已安排恢复重试';
    case 'connection_reconnected': return '已重新连接 app-server';
    case 'connection_verified': return '已确认 app-server 连接';
    case 'stale_judge_result_ignored': return '迟到的判断结果已忽略';
    case 'stale_verification_result_ignored': return '迟到的验收结果已忽略';
    case 'paused': return '任务已暂停';
    case 'owned_calls_cancelled': return '已取消监督器持有的调用';
    case 'server_request': return `收到请求${stringValue(event.method) ? `：${event.method}` : ''}`;
    case 'server_request_answered': return `已处理请求${stringValue(event.method) ? `：${event.method}` : ''}`;
    default: return type.replaceAll('_', ' ');
  }
}

function humanEvent(event: Record<string, unknown>): HumanEvent {
  const type = stringValue(event.type) ?? 'unknown';
  return {
    at: eventTime(event),
    role: eventRole(event),
    eventType: type,
    summary: eventSummary(event),
    result: eventResult(event),
    details: event,
  };
}

function technicalEvent(event: Record<string, unknown>): TechnicalEvent {
  const base = humanEvent(event);
  return {
    ...base,
    threadId: stringValue(event.thread_id) ?? stringValue(event.worker_thread_id),
    turnId: stringValue(event.turn_id) ?? stringValue(event.worker_turn_id),
    deliveryId: stringValue(event.delivery_id),
    snapshotId: stringValue(event.snapshot_id),
  };
}

function safeEvents(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const event = asRecord(parsed);
      if (event) events.push(event);
    } catch {
      // An append may be observed between writes. Ignore only the incomplete line.
    }
  }
  return events.sort((left, right) => eventTime(left).localeCompare(eventTime(right)));
}

function stateView(state: State): TaskStateView {
  return {
    taskId: state.task_id,
    status: state.status,
    phase: state.phase,
    mode: state.mode,
    goal: state.task.goal,
    workspace: state.task.workspace,
    acceptance: state.task.acceptance,
    workerThreadId: state.worker_thread_id,
    workerTurnCount: state.worker_turn_count,
    updatedAt: state.updated_at,
    lastDecision: state.last_decision,
    retry: state.retry,
    lastError: state.last_error ?? null,
    pauseReason: state.pause_reason ?? null,
    recoveryCondition: state.recovery_condition ?? null,
  };
}

function resultForRound(round: WorkRound): HumanEvent | null {
  const candidates = round.technicalEvents.filter((event) => {
    return event.eventType === 'decision' || event.eventType === 'verification_result' || event.eventType === 'send_confirmed' || event.eventType === 'external_wait_required' || event.eventType === 'recovery_required' || event.eventType === 'paused';
  });
  const result = candidates.at(-1) ?? round.technicalEvents.at(-1) ?? null;
  if (!result || result.eventType !== 'decision') return result;
  const rawDecision = asRecord(result.details.decision);
  const action = stringValue(rawDecision?.action);
  const summary = action === 'DONE' ? '任务完成判断' : action === 'WAIT_EXTERNAL' ? '任务进入外部等待' : action === 'CONTINUE' ? '任务继续推进' : 'supervisor 已返回判断';
  return { ...result, summary };
}

function makeRounds(events: Record<string, unknown>[]): WorkRound[] {
  const rounds = new Map<string, WorkRound>();
  for (const raw of events) {
    const id = stringValue(raw.turn_id) ?? stringValue(raw.worker_turn_id) ?? stringValue(raw.source_turn_id) ?? 'run';
    let round = rounds.get(id);
    if (!round) {
      const at = eventTime(raw);
      round = { id, startedAt: at, endedAt: at, worker: null, supervisor: [], result: null, technicalEvents: [] };
      rounds.set(id, round);
    }
    round.startedAt = round.startedAt < eventTime(raw) ? round.startedAt : eventTime(raw);
    round.endedAt = round.endedAt > eventTime(raw) ? round.endedAt : eventTime(raw);
    const human = technicalEvent(raw);
    round.technicalEvents.push(human);
    if (human.role === 'worker') {
      round.worker ??= human;
    } else if (human.role === 'supervisor') {
      round.supervisor.push(human);
    }
  }
  return [...rounds.values()].map((round) => ({ ...round, result: resultForRound(round) }));
}

function snapshotIds(directory: string): string[] {
  const path = resolve(directory, 'snapshots');
  if (!existsSync(path) || !statSync(path).isDirectory()) return [];
  return readdirSync(path).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
}

function taskDirectory(root: string, taskId: string): string {
  if (!/^[\w.-]+$/.test(taskId) || taskId === '.' || taskId === '..') throw new Error('Invalid task id.');
  const directory = resolve(root, taskId);
  const suffix = relative(root, directory);
  if (!suffix || suffix.startsWith('..') || suffix.includes('\\') || suffix.includes('/')) throw new Error('Invalid task path.');
  return directory;
}

export class TaskCatalog {
  readonly root: string;
  constructor(options: TaskCatalogOptions) {
    this.root = resolve(options.workspace, '.codex-supervisor');
  }

  list(): TaskSummary[] {
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) return [];
    const entries: TaskSummary[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const record = this.read(entry.name);
        const result = record.state.lastDecision?.action ?? record.state.status;
        entries.push({ taskId: record.taskId, status: record.state.status, phase: record.state.phase, updatedAt: record.updatedAt, lastResult: result });
      } catch {
        // A task is only discoverable once its atomically written state is readable.
      }
    }
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  read(taskId: string): TaskRecord {
    const directory = taskDirectory(this.root, taskId);
    const statePath = resolve(directory, 'state.json');
    if (!existsSync(statePath)) throw new Error('Task not found.');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as State;
    if (!state.task || state.task_id !== taskId) throw new Error('Task state identity mismatch.');
    const events = safeEvents(resolve(directory, 'events.jsonl'));
    const summaryPath = resolve(directory, 'summary.md');
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
    return { taskId, state: stateView(state), summary, rounds: makeRounds(events), eventCount: events.length, snapshotIds: snapshotIds(directory), updatedAt: state.updated_at };
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(body);
}

function html(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(WEB_HTML);
}

export interface WebServerOptions {
  workspace: string;
  host?: '127.0.0.1' | 'localhost';
  port?: number;
}

export interface RunningWebServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error('workspace must name an existing directory.');
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer between 0 and 65535.');
  const catalog = new TaskCatalog({ workspace });
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      return json(response, 405, { error: 'read-only' });
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
      try { return json(response, 200, catalog.read(taskId)); }
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

const WEB_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Needs Forever</title>
<style>
:root{color-scheme:light;--bg:#f5f7f8;--panel:#fff;--ink:#1b2529;--muted:#6e7b80;--quiet:#9aa5a8;--line:#e4e9eb;--blue:#2c72d6;--blue-soft:#edf4ff;--green:#25865d;--green-soft:#eaf8f0;--amber:#a76912;--amber-soft:#fff6e5;--purple:#7651a8;--purple-soft:#f5effc;--sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px}.app{min-height:100vh;display:grid;grid-template-columns:238px minmax(0,1fr)}aside{padding:24px 14px;border-right:1px solid var(--line);background:#fbfcfc}.brand{padding:0 10px 24px;font-size:17px;font-weight:700;letter-spacing:-.03em}.brand span{color:var(--blue)}.side-label{padding:0 10px 8px;color:var(--quiet);font-size:10px;letter-spacing:.12em;text-transform:uppercase}.tasks{display:grid;gap:4px}.task{width:100%;padding:10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted);text-align:left;cursor:pointer}.task:hover{background:#f1f4f5}.task.selected{border-color:#d7e5fa;background:var(--blue-soft);color:var(--ink)}.task-name{display:block;font-weight:650}.task-meta{display:flex;justify-content:space-between;gap:8px;margin-top:5px;color:var(--quiet);font-size:11px}.task.selected .task-meta{color:#6383af}.empty-side{padding:10px;color:var(--quiet);font-size:12px}main{min-width:0;padding:28px 34px 52px}.content{width:min(1180px,100%);margin:0 auto}.project{margin:1px 0 20px;color:var(--muted);font-size:12px;font-weight:650;letter-spacing:.08em}.top{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;margin-bottom:24px}.title{min-width:0}.title h1{margin:0;font-size:30px;letter-spacing:-.045em}.goal{max-width:680px;margin:8px 0 0;color:var(--muted);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.meta{text-align:right;color:var(--muted);font-size:12px;line-height:1.55;max-width:52%}.status{display:inline-flex;align-items:center;gap:6px;margin-bottom:6px;font-weight:700}.status::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--blue)}.status.done{color:var(--green)}.status.done::before{background:var(--green)}.status.wait{color:var(--purple)}.status.wait::before{background:var(--purple)}.status.paused{color:var(--muted)}.status.paused::before{background:var(--quiet)}.status.recover{color:var(--amber)}.status.recover::before{background:var(--amber)}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:12px;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.filters{display:flex;gap:5px;flex-wrap:wrap}.filter,.refresh{border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--muted);padding:6px 10px;font-size:12px;cursor:pointer}.filter.active{border-color:#cfe0f7;background:var(--blue-soft);color:var(--blue);font-weight:650}.refresh.on{color:var(--blue);border-color:#cfe0f7;background:var(--blue-soft)}.timeline{display:grid;gap:10px}.round{border:1px solid var(--line);border-radius:11px;background:var(--panel);overflow:hidden}.round-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 16px;border-bottom:1px solid var(--line)}.round-toggle{display:flex;align-items:center;gap:10px;min-width:0;border:0;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer}.chevron{color:var(--quiet);font-size:15px}.round-title{font-weight:700}.round-time{color:var(--quiet);font-size:12px;white-space:nowrap}.round-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:0}.column{min-width:0;padding:15px 16px}.column+.column{border-left:1px solid var(--line)}.column-label{margin-bottom:8px;color:var(--quiet);font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}.event-type{display:inline-block;margin-right:6px;color:var(--blue);font:650 11px ui-monospace,SFMono-Regular,Consolas,monospace}.event-summary{color:var(--ink);line-height:1.45}.event-result{margin-top:7px;color:var(--muted);font-size:12px}.result-continue{color:var(--blue)}.result-done{color:var(--green)}.result-wait{color:var(--purple)}.result-error{color:var(--amber)}.message{margin-top:8px;padding:8px 10px;border-radius:7px;background:#f6f8f9;color:var(--muted);font-size:12px;line-height:1.45}.round-details{display:none;padding:0 16px 16px;border-top:1px solid var(--line);background:#fbfcfc}.round.open .round-details{display:block}.detail-event{padding:10px 0;border-bottom:1px solid var(--line)}.detail-event:last-child{border-bottom:0}.detail-row{display:flex;align-items:baseline;gap:9px}.detail-role{color:var(--muted);font-size:11px}.detail-time{margin-left:auto;color:var(--quiet);font:11px ui-monospace,SFMono-Regular,Consolas,monospace}.detail-json{margin:7px 0 0;padding:9px;overflow:auto;border-radius:7px;background:#f1f4f5;color:#546166;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.drawer{position:fixed;inset:0;display:none;background:rgba(27,37,41,.18)}.drawer.open{display:block}.drawer-panel{position:absolute;top:0;right:0;width:min(430px,92vw);height:100%;overflow:auto;padding:22px;background:var(--panel);box-shadow:-8px 0 24px rgba(27,37,41,.12)}.drawer-close{float:right;border:0;background:transparent;color:var(--muted);font-size:22px;cursor:pointer}.drawer h2{margin:4px 34px 18px 0;font-size:18px}.drawer-section{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}.drawer-section h3{margin:0 0 8px;font-size:12px;color:var(--muted)}.drawer-section p{margin:0;color:var(--ink);line-height:1.5}.empty{padding:38px 16px;border:1px dashed var(--line);border-radius:11px;background:var(--panel);color:var(--muted);text-align:center}.error{padding:14px;border-radius:8px;background:var(--amber-soft);color:var(--amber)}@media(max-width:860px){.app{grid-template-columns:205px minmax(0,1fr)}main{padding:24px 20px}.round-body{grid-template-columns:1fr}.column+.column{border-top:1px solid var(--line);border-left:0}.meta{font-size:11px}}@media(max-width:620px){.app{display:block}aside{border-right:0;border-bottom:1px solid var(--line);padding:16px 12px}.brand{padding-bottom:15px}.tasks{display:flex;overflow:auto}.task{min-width:165px}main{padding:20px 14px}.top{display:block}.meta{margin-top:14px;text-align:left}.toolbar{align-items:flex-start;flex-direction:column}.round-head{align-items:flex-start;flex-direction:column}.round-time{padding-left:25px}}
</style>
</head>
<body>
<div class="app"><aside><div class="brand">Needs <span>Forever</span></div><div class="side-label">任务</div><div id="tasks" class="tasks"><div class="empty-side">正在读取任务…</div></div></aside>
<main><div class="content"><div class="project">needs-forever</div><div id="error" class="error" hidden></div><section id="task-header" class="top" hidden><div class="title"><h1 id="task-title"></h1><p id="task-goal" class="goal"></p></div><div class="meta"><div id="task-status" class="status"></div><div id="task-meta"></div></div></section><div id="toolbar" class="toolbar" hidden><div class="filters"><button class="filter active" data-filter="all">全部</button><button class="filter" data-filter="error">异常</button><button class="filter" data-filter="worker">worker</button><button class="filter" data-filter="supervisor">supervisor</button></div><button id="refresh" class="refresh on">自动刷新：开</button></div><section id="timeline" class="timeline"><div class="empty">选择一个任务查看监督记录。</div></section></div></main></div>
<div id="drawer" class="drawer"><aside class="drawer-panel"><button id="drawer-close" class="drawer-close" aria-label="关闭">×</button><h2 id="drawer-title">轮次详情</h2><div id="drawer-content"></div></aside></div>
<script>
const app={taskId:new URL(location.href).pathname.match(/^\/tasks\/([^/]+)/)?.[1]||null,record:null,filter:'all',auto:true};
const $=s=>document.querySelector(s); const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusLabel={ACTIVE:'正在推进',WAIT_EXTERNAL:'等待外部条件',PAUSED:'已暂停',DONE:'已完成'};
function statusClass(s,p){return s==='DONE'?'done':s==='WAIT_EXTERNAL'?'wait':s==='PAUSED'?'paused':p==='RECOVERING'?'recover':''}
function shortTime(v){try{return new Date(v).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch{return v}}
function resultClass(v){return v==='DONE'?'result-done':v==='WAIT_EXTERNAL'?'result-wait':v==='CONTINUE'?'result-continue':v==='FAIL'?'result-error':''}
function roleName(v){return v==='supervisor'?'supervisor':v==='worker'?'worker':'系统'}
function renderTasks(tasks){const root=$('#tasks');if(!tasks.length){root.innerHTML='<div class="empty-side">暂无可发现的任务</div>';return}root.innerHTML=tasks.map(t=>'<button class="task '+(t.taskId===app.taskId?'selected':'')+'" data-task="'+esc(t.taskId)+'"><span class="task-name">'+esc(t.taskId)+'</span><span class="task-meta"><span>'+esc(statusLabel[t.status]||t.status)+'</span><span>'+esc(shortTime(t.updatedAt))+'</span></span></button>').join('');root.querySelectorAll('[data-task]').forEach(b=>b.onclick=()=>{app.taskId=b.dataset.task;history.pushState({},'', '/tasks/'+encodeURIComponent(app.taskId));loadRecord()})}
function eventHtml(ev){return '<div><span class="event-type">'+esc(ev.eventType)+'</span><span class="event-summary">'+esc(ev.summary)+'</span></div>'+(ev.result?'<div class="event-result '+resultClass(ev.result)+'">'+esc(ev.result)+'</div>':'')}
function matches(round){if(app.filter==='all')return true;const values=round.technicalEvents; if(app.filter==='worker')return values.some(e=>e.role==='worker');if(app.filter==='supervisor')return values.some(e=>e.role==='supervisor');return values.some(e=>e.result==='FAIL'||e.eventType.startsWith('recovery_')||e.eventType.startsWith('stale_')||e.eventType==='external_wait_required'||e.eventType==='paused')}
function roundHtml(r,index){const worker=r.worker?eventHtml(r.worker):'<span class="event-result">暂无 worker 事件</span>';const supervisor=r.supervisor.length?r.supervisor.map(eventHtml).join(''):'<span class="event-result">等待 supervisor 处理</span>';const result=r.result?eventHtml(r.result):'<span class="event-result">暂无结果</span>';const message=r.result?.eventType==='decision'?r.result.details.decision?.next_message||'':r.result?.eventType==='external_wait_required'?r.result.details.resume_when||'':'';const details=r.technicalEvents.map(e=>'<div class="detail-event"><div class="detail-row"><span class="detail-role">'+esc(roleName(e.role))+' · <code>'+esc(e.eventType)+'</code></span><span class="detail-time">'+esc(shortTime(e.at))+'</span></div><div class="event-summary">'+esc(e.summary)+'</div><pre class="detail-json">'+esc(JSON.stringify(e.details,null,2))+'</pre></div>').join('');return '<article class="round" data-round="'+index+'"><div class="round-head"><button class="round-toggle"><span class="chevron">›</span><span class="round-title">第 '+(index+1)+' 轮</span></button><span class="round-time">'+esc(shortTime(r.startedAt))+'–'+esc(shortTime(r.endedAt))+'</span></div><div class="round-body"><div class="column"><div class="column-label">发生了什么</div>'+worker+'</div><div class="column"><div class="column-label">supervisor 怎么处理</div>'+supervisor+'</div><div class="column"><div class="column-label">结果</div>'+result+(message?'<div class="message">'+esc(message)+'</div>':'')+'</div></div><div class="round-details">'+details+'</div></article>'}
function renderRecord(){const r=app.record;if(!r){$('#task-header').hidden=true;$('#toolbar').hidden=true;$('#timeline').innerHTML='<div class="empty">选择一个任务查看监督记录。</div>';return}$('#task-header').hidden=false;$('#toolbar').hidden=false;$('#task-title').textContent=r.taskId;$('#task-goal').textContent=r.state.goal;const s=$('#task-status');s.textContent=(statusLabel[r.state.status]||r.state.status)+' · '+r.state.status;s.className='status '+statusClass(r.state.status,r.state.phase);const thread=r.state.workerThreadId?r.state.workerThreadId.slice(0,12)+'…':'未创建';$('#task-meta').innerHTML='阶段 '+esc(r.state.phase)+' · 更新 '+esc(shortTime(r.updatedAt))+' · worker '+esc(r.state.workerTurnCount)+' 轮<br>工作区 '+esc(r.state.workspace)+' · thread '+esc(thread);const rounds=r.rounds.filter(matches);$('#timeline').innerHTML=rounds.length?rounds.map((x,i)=>roundHtml(x,i)).join(''):'<div class="empty">当前筛选没有记录。</div>';$('#timeline').querySelectorAll('.round-toggle').forEach(b=>b.onclick=()=>b.closest('.round').classList.toggle('open'));}
async function loadTasks(){const response=await fetch('/api/tasks',{cache:'no-store'});if(!response.ok)throw new Error('读取任务列表失败');const data=await response.json();renderTasks(data.tasks||[]);if(!app.taskId&&data.tasks?.[0]){app.taskId=data.tasks[0].taskId;history.replaceState({},'', '/tasks/'+encodeURIComponent(app.taskId))}return data.tasks||[]}
async function loadRecord(){if(!app.taskId){renderRecord();return}const response=await fetch('/api/tasks/'+encodeURIComponent(app.taskId),{cache:'no-store'});if(!response.ok)throw new Error((await response.json()).error||'读取任务失败');app.record=await response.json();renderRecord();}
async function load(){try{$('#error').hidden=true;await loadTasks();if(app.taskId)await loadRecord()}catch(e){$('#error').textContent=e.message;$('#error').hidden=false}}
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{app.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));renderRecord()});$('#refresh').onclick=()=>{app.auto=!app.auto;$('#refresh').textContent='自动刷新：'+(app.auto?'开':'关');$('#refresh').classList.toggle('on',app.auto)};$('#drawer-close').onclick=()=>$('#drawer').classList.remove('open');window.onpopstate=()=>{app.taskId=new URL(location.href).pathname.match(/^\/tasks\/([^/]+)/)?.[1]||null;load()};setInterval(()=>{if(app.auto)load()},1500);load();
</script>
</body></html>`;
