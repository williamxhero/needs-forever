import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Replays saved evidence into a new, owned C only. Never resumes/interrupts A,
// writes source supervision files, or executes a selected route.
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--source', '--directory', '--runtime', '--live'].includes(process.argv[i]) || flags[process.argv[i]] || !process.argv[i + 1]) throw new Error('Expected unique --source/--directory/--runtime/--live values.');
  flags[process.argv[i]] = process.argv[i + 1];
}
if (!flags['--source'] || (flags['--live'] && !['true', 'false'].includes(flags['--live']))) throw new Error('--source is required; --live is true or false.');
const source = resolve(flags['--source']);
const runtime = resolve(flags['--runtime'] ?? 'plugins/needs-forever/runtime');
const directory = resolve(flags['--directory'] ?? `runs/ticket54/replay-${Date.now()}`);
if (existsSync(directory)) throw new Error('Replay directory must be fresh.');
mkdirSync(directory, { recursive: true });
const moduleAt = (file) => import(pathToFileURL(resolve(runtime, 'src', file)).href);
const [{ buildC2Context, validateDecision }, { AppServerJudge, archiveTerminatedJudge }, { connect, codexCommand }, { redact }] = await Promise.all([moduleAt('index.js'), moduleAt('judge.js'), moduleAt('transport.js'), moduleAt('redact.js')]);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sourceBytes = readFileSync(source), saved = JSON.parse(sourceBytes);
if (!saved.input?.stop_request?.stop_attempt_id || !Array.isArray(saved.input?.evidence)) throw new Error('Expected a saved native Stop snapshot.');
const original = redact(structuredClone(saved.input));
if (original.task.c2?.mode === 'legacy') throw new Error('Live replay cannot retain legacy mode.');
const input = buildC2Context(original, { task_id: original.task_id, task_version: original.task_version, task: original.task, mode: 'live' });
const historical = saved.raw_output ? JSON.parse(saved.raw_output) : null;
const report = { mode: flags['--live'] === 'true' ? 'actual-live-C-historical-Stop-replay' : 'historical-replay-preparation-no-model', source, source_sha256: digest(sourceBytes), historical_input_sha256: digest(JSON.stringify(saved.input)), replay_input_sha256: digest(JSON.stringify(input)), source_stop_attempt_id: input.stop_request.stop_attempt_id, source_snapshot_id: input.snapshot_id, source_thread_id: input.worker_thread_id, source_task_id: input.task_id, original_contract_sha256: digest(JSON.stringify(saved.input.task)), replay_contract_sha256: digest(JSON.stringify(input.task)), historical_action: historical?.action, historical_next_message: historical?.next_message, current_evidence: input.evidence.map((entry) => ({ id: entry.id, type: entry.type, source: entry.source, value_sha256: digest(JSON.stringify(entry.value)) })), c2_mode: input.c2.mode, context_complete: input.c2.context_complete, evidence_complete: input.evidence_complete, input_characters: JSON.stringify(input).length, live_model: 'not_run', original_A_contacted: false, source_written: false, native_live_Stop: false, route_execution: 'not_run', limits: 'Actual C model receives a historical Stop in a new isolated read-only/network-disabled/tool-free judge. Original A and its active state are untouched. Missing historical Route Catalog/Ledger is explicit and requires inventory. This does not prove a native live Stop, live route execution, or completion of the original B0QI task.' };
const save = () => writeFileSync(resolve(directory, 'report.json'), JSON.stringify(redact(report), null, 2) + '\n');
writeFileSync(resolve(directory, 'input.json'), JSON.stringify(input, null, 2) + '\n'); save();
if (flags['--live'] === 'true') {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 100_000);
  let connection, pump;
  try {
    const argv = codexCommand();
    connection = await connect(argv, input.task.workspace, abort.signal, 10_000);
    report.codex_version = connection.version;
    report.disabled_mcp_count = connection.disabled_mcp.length;
    const judge = new AppServerJudge(75_000);
    judge.bind(connection.rpc, (type, detail) => {
      const event = redact({ type, ...detail });
      appendFileSync(resolve(directory, 'judge-events.jsonl'), JSON.stringify(event) + '\n');
      if (type === 'judge_created') report.owned_C_thread_id = detail.thread_id;
      if (type === 'judge_archived') report.owned_C_archived = true;
    }, (thread) => archiveTerminatedJudge(argv, input.task.workspace, thread));
    connection.rpc.setRequestHandler((_id, method, params) => judge.serverRequest(method, params));
    pump = (async () => { try { while (true) { const event = await connection.rpc.next(); judge.observe(event.method, event.params); } } catch (error) { judge.connectionFailed(error); } })();
    report.live_model = 'attempted'; save();
    const decision = await judge.judge(input, abort.signal);
    validateDecision(JSON.stringify(decision), input);
    report.live_model = 'completed'; report.validated = true;
    report.action = decision.action; report.selected_route = decision.route_plan?.selected_route_id ?? null;
    report.diagnosis = decision.diagnosis; report.next_message = decision.next_message;
    writeFileSync(resolve(directory, 'decision.json'), JSON.stringify(redact(decision), null, 2) + '\n');
    if (decision.action !== 'CONTINUE' || !decision.route_plan || !decision.route_plan.candidates.find((route) => route.route_id === decision.route_plan.selected_route_id && route.resource.kind === 'diagnostic')) throw new Error('Missing historical route facts must select a bounded inventory/diagnostic CONTINUE.');
    report.inventory_acceptance_pass = true;
  } catch (error) { report.error = String(redact(error instanceof Error ? error.message : String(error))); process.exitCode = 1; }
  finally { clearTimeout(deadline); abort.abort(); await connection?.rpc.close(); await pump; }
}
report.source_snapshot_unchanged = digest(readFileSync(source)) === report.source_sha256;
save();
console.log(JSON.stringify(redact(report), null, 2));
