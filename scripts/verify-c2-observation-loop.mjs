import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const flags = {};
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--runtime', '--directory'].includes(process.argv[index]) || !process.argv[index + 1] || flags[process.argv[index]]) throw new Error('Expected unique --runtime and --directory values.');
  flags[process.argv[index]] = process.argv[index + 1];
}
if (!flags['--runtime'] || !flags['--directory']) throw new Error('--runtime and --directory are required.');
const runtime = resolve(flags['--runtime']), directory = resolve(flags['--directory']), workspace = resolve(directory, 'workspace');
if (existsSync(directory)) throw new Error('Observation verification directory must be fresh.');
mkdirSync(resolve(workspace, 'cache'), { recursive: true });
writeFileSync(resolve(workspace, 'cache', 'prices.csv'), 'date,close\n2026-11-09,17\n');
const taskId = 'installed-observation-loop', statePath = resolve(directory, 'state.json');
const descriptor = { nf_route_inventory: { schema_version: 1, task_id: taskId, task_version: 1, routes: [{ route_id: 'verified-cache', resource: { kind: 'artifact', id: 'cache/prices.csv' }, operation: 'read-local-artifact' }] } };
const trace = resolve(directory, 'protocol.jsonl'), scenario = resolve(directory, 'server.json'), fixture = resolve(directory, 'fixture.json'), task = resolve(directory, 'task.json');
writeFileSync(scenario, JSON.stringify({ trace, state_file: statePath, real_judge: true, judge_actions: ['CONTINUE', 'CONTINUE', 'DONE'], judge_select_observed_artifact: true, worker_commands: [
  [[process.execPath, '-e', 'console.log("Synthetic quota blocker; inspect the local alternative.");process.exit(1)']],
  [[process.execPath, '-e', 'console.log(process.argv[1])', JSON.stringify(descriptor)]],
  [[process.execPath, '-e', 'const assert=require("node:assert/strict"),fs=require("node:fs");const csv=fs.readFileSync("cache/prices.csv","utf8");assert.equal(csv,"date,close\\n2026-11-09,17\\n");console.log(JSON.stringify({checked:true,dates:["2026-11-09"],close:17}))']],
] }));
writeFileSync(fixture, JSON.stringify({ real_judge: true, app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), scenario] }));
writeFileSync(task, JSON.stringify({ schema_version: 1, task_id: taskId, workspace, goal: 'Verify the local cache after the synthetic provider limit.', acceptance: [{ id: 'A1', text: 'Independently check the exact generated CSV contents.' }], authorization: 'Local workspace inspection.' }));
const result = spawnSync(process.execPath, [resolve(runtime, 'src/cli.js'), 'start', '--task', task, '--state', statePath, '--test-fixture', fixture], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
assert.equal(result.status, 0, result.stderr);
const state = JSON.parse(readFileSync(statePath, 'utf8'));
assert.equal(state.status, 'DONE');
const artifact = state.route_catalog.entries.find((entry) => entry.route_id === 'verified-cache');
assert.equal(artifact.status, 'observed');
assert.ok(artifact.evidence.some((entry) => entry.source === 'probe'));
assert.ok(artifact.evidence.some((entry) => entry.reference === `task-contract:${taskId}:1`));
const events = readFileSync(resolve(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const selected = events.find((event) => event.type === 'send_prepared' && event.route_id === artifact.route_id);
assert.ok(selected);
for (const type of ['send_prepared', 'send_attempted', 'send_confirmed', 'route_outcome']) {
  const matches = events.filter((event) => event.type === type && event.delivery_id === selected.delivery_id);
  assert.equal(matches.length, 1, type);
  for (const key of ['plan_id', 'route_id', 'source_stop_attempt_id']) assert.equal(matches[0][key], selected[key]);
}
const protocol = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(protocol.filter((entry) => entry.message?.method === 'turn/start' && entry.message.params.threadId === 'worker-from-server' && entry.message.params.input[0]?.text.includes('Read cache/prices.csv')).length, 1);
const report = { mode: 'installed-production-CLI-simulated-planner-actual-local-tools', runtime, runtime_index_sha256: createHash('sha256').update(readFileSync(resolve(runtime, 'src/index.js'))).digest('hex'), task_id: taskId, status: state.status,
  decisions: events.filter((entry) => entry.type === 'decision').map((entry) => ({ action: entry.decision.action, route_id: entry.decision.route_plan?.selected_route_id ?? null })),
  source_linked_artifact: artifact, correlation: { delivery_id: selected.delivery_id, plan_id: selected.plan_id, route_id: selected.route_id, source_stop_attempt_id: selected.source_stop_attempt_id },
  tool_execution_count: 3, alternate_deliveries: 1, manually_injected_catalog: false, live_model: false, live_provider: false,
  limitations: 'The installed production CLI executes actual local subprocesses and ingests real protocol results. The planner/server and quota blocker are deterministic fixtures; no native live Stop or original B0QI completion is claimed.' };
// Exercise the actual installed CLI's signed public-API route too. The server
// lives here, so use an asynchronous child while it handles the real requests.
let requests = 0;
const server = createServer((request, response) => {
  requests++;
  assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
  response.end('{"rows":17}');
});
await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_));
try {
  const url = `http://127.0.0.1:${server.address().port}/prices`, httpDirectory = resolve(directory, 'http-fixture'), httpWorkspace = resolve(httpDirectory, 'workspace');
  mkdirSync(httpWorkspace, { recursive: true });
  const httpState = resolve(httpDirectory, 'state.json'), httpScenario = resolve(httpDirectory, 'server.json'), httpFixture = resolve(httpDirectory, 'fixture.json'), httpTask = resolve(httpDirectory, 'task.json');
  writeFileSync(httpScenario, JSON.stringify({ trace: resolve(httpDirectory, 'protocol.jsonl'), state_file: httpState, real_judge: true, judge_actions: ['CONTINUE', 'CONTINUE', 'DONE'], judge_select_observed_api: true, worker_commands: [[[process.execPath, '-e', 'console.log("Synthetic original provider failed; probe authorized API.")']]], worker_probe_urls: [[], [url], [url]] }));
  writeFileSync(httpFixture, JSON.stringify({ real_judge: true, app_server_argv: [process.execPath, resolve('test/fixtures/app-server.mjs'), httpScenario] }));
  writeFileSync(httpTask, JSON.stringify({ schema_version: 1, task_id: 'installed-http-loop', workspace: httpWorkspace, goal: 'Read the authorized alternate API.', acceptance: [{ id: 'A1', text: 'Actual local fixture GET success.' }], authorization: `Read-only GET to ${url}. No credentials or writes.` }));
  const child = spawn(process.execPath, [resolve(runtime, 'src/cli.js'), 'start', '--task', httpTask, '--state', httpState, '--test-fixture', httpFixture], { windowsHide: true });
  child.stdout.resume(); let stderr = ''; child.stderr.on('data', (part) => { stderr += part; });
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve_) => child.once('exit', resolve_)); clearTimeout(timer); assert.equal(code, 0, stderr);
  const checkpoint = JSON.parse(readFileSync(httpState, 'utf8')), api = checkpoint.route_catalog.entries.find((entry) => entry.resource.kind === 'api');
  assert.equal(checkpoint.status, 'DONE'); assert.equal(api.status, 'observed'); assert.equal(api.resource.id, url); assert.equal(requests, 2);
  const httpEvents = readFileSync(resolve(httpDirectory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const deliveries = httpEvents.filter((entry) => entry.type === 'send_prepared' && entry.route_id === api.route_id); assert.equal(deliveries.length, 1);
  for (const type of ['send_attempted', 'send_confirmed', 'route_outcome']) assert.equal(httpEvents.filter((entry) => entry.type === type && entry.delivery_id === deliveries[0].delivery_id).length, 1);
  report.http_loop = { status: checkpoint.status, selected_route: api.route_id, actual_requests: requests, alternate_deliveries: 1, manually_injected_catalog: false, source_linked_api: api, limits: 'Local real HTTP fixture, simulated planner, original Task unchanged, no credential access or live external provider.' };
} finally { server.close(); }
writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
