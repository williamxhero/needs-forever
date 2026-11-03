import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readlink } from 'node:fs/promises';
import { setImmediate as yieldControl } from 'node:timers/promises';
import { resolve, relative } from 'node:path';
import { AppServerJudge, validateDecision } from './judge.js';
import { codexCommand, connect } from './transport.js';
import { Store } from './store.js';
import { redact } from './redact.js';
const budget = 24_000;
function continueWith(message, reason) {
    return { action: 'CONTINUE', reason, evidence_ids: [], next_message: message, external: null };
}
function commandFor(state, fixture) {
    if (state.mode === 'simulated') {
        if (!Array.isArray(fixture?.app_server_argv) || !fixture.app_server_argv.length || !fixture.app_server_argv.every((value) => typeof value === 'string' && value.length))
            throw new Error('Simulated supervisor requires an explicit external app-server argv.');
        return fixture.app_server_argv;
    }
    if (fixture)
        throw new Error('A live supervisor cannot use fixture results.');
    return codexCommand();
}
export async function preflightSupervisor(state, fixture, signal) {
    // Host-only and legacy transport fixtures do not claim model availability.
    if (state.mode === 'simulated' && !fixture?.app_server_argv)
        return;
    const timeout = AbortSignal.timeout(15_000);
    const connection = await connect(commandFor(state, fixture), state.task.workspace, signal ? AbortSignal.any([signal, timeout]) : timeout);
    try {
        state.codex_version = connection.version;
    }
    finally {
        await connection.rpc.close();
    }
}
function snapshotFor(state, request, store) {
    const events = store.events();
    // A later Stop after real work is a new evidence window, including within
    // the same turn. Old truncated output must not poison new concise proof.
    const stopPositions = events.flatMap((event, index) => event.type === 'main_session_stop_observed' ? [index] : []);
    const priorStop = stopPositions.length > 1 ? stopPositions.at(-2) : -1;
    const currentEvents = new Set(events.slice(priorStop + 1));
    const snapshot = {
        snapshot_id: randomUUID(), task_id: state.task_id, task_version: state.task_version,
        worker_thread_id: state.main_session_id, worker_turn_id: request.turn_id ?? `stop:${request.stop_attempt_id}`,
        task: redact(state.task), control_mode: 'main-session', main_session_id: state.main_session_id, stop_request: { ...request, last_assistant_message: request.last_assistant_message?.slice(0, 2_000) ?? null }, input_epoch: state.input_epoch ?? 0,
        evidence: [], evidence_complete: true, omissions: [], recent_instructions: [],
    };
    if ((request.last_assistant_message?.length ?? 0) > 2_000)
        snapshot.omissions.push('Last assistant wording truncated to 2000 characters; it is an untrusted claim, never independent completion evidence.');
    if (state.latest_human_input)
        snapshot.recent_instructions.push({ source: 'native-human-input', ...state.latest_human_input, scope: 'Context only. Original acceptance and authorization remain binding.' });
    // Keep the original contract and Stop identity intact, even when logs are large.
    if (JSON.stringify(snapshot).length > budget - 1_000)
        throw new Error('Original task contract exceeds the 24k snapshot budget; provide a concise contract without dropping acceptance or authorization.');
    const append = (entry) => {
        snapshot.evidence.push(entry);
        if (JSON.stringify(snapshot).length > budget - 500) {
            snapshot.evidence.pop();
            snapshot.evidence_complete = false;
            return false;
        }
        return true;
    };
    let omitted = 0;
    for (const event of [...events].reverse()) {
        if (event.task_version !== state.task_version)
            continue;
        if (event.type === 'main_tool_result' && currentEvents.has(event) && event.session_id === state.main_session_id && event.run_generation === state.run_generation && event.input_epoch === (state.input_epoch ?? 0) && event.contract_sha256 === state.contract_sha256) {
            const entry = { id: String(event.event_id), type: 'functionCallOutput', value: event.value, source: { event_id: String(event.event_id), thread_id: state.main_session_id, ...(typeof event.turn_id === 'string' ? { turn_id: event.turn_id } : {}), item_id: String(event.tool_use_id) } };
            if (!append(entry))
                omitted++;
            if (event.complete === false)
                snapshot.evidence_complete = false;
        }
        else if (event.type === 'verification_result' && snapshot.recent_verification === undefined) {
            const raw = JSON.stringify(redact(event));
            snapshot.recent_verification = raw.length <= 2_000 ? JSON.parse(raw) : { truncated: true, prefix: raw.slice(0, 2_000) };
            if (JSON.stringify(snapshot).length > budget - 500) {
                delete snapshot.recent_verification;
                omitted++;
            }
        }
        else if (event.type === 'decision' && snapshot.recent_instructions.length < 4) {
            const candidate = redact({ stop_attempt_id: event.stop_attempt_id, decision: event.decision });
            snapshot.recent_instructions.push(candidate);
            if (JSON.stringify(snapshot).length > budget - 500) {
                snapshot.recent_instructions.pop();
                omitted++;
                snapshot.evidence_complete = false;
            }
        }
    }
    const earlierTools = events.slice(0, Math.max(0, priorStop)).filter((event) => event.type === 'main_tool_result').length;
    if (earlierTools)
        snapshot.omissions.push(`${earlierTools} older tool results belong to previous Stop attempts. Terminal decisions require current concise proof for every original acceptance item; previous directions and the latest fixed verifier result remain context.`);
    if (omitted)
        snapshot.omissions.push(`${omitted} earlier evidence/direction entries omitted to preserve the 24k budget; gather concise current proof before a terminal decision.`);
    if (snapshot.evidence_complete === false)
        snapshot.omissions.push('At least one tool result was truncated or omitted. Worker wording cannot replace missing proof.');
    snapshot.repeated_failure = redact(state.recovery_failures?.slice(-3) ?? []);
    if (JSON.stringify(snapshot).length > budget) {
        snapshot.repeated_failure = 'Earlier recovery details omitted for size.';
        snapshot.evidence_complete = false;
    }
    return snapshot;
}
async function workspaceDigest(state, store, signal) {
    const hash = createHash('sha256');
    const statePath = resolve(store.path);
    const generatedJson = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
    const temporaryState = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
    let visited = 0;
    const walk = async (directory) => {
        signal.throwIfAborted();
        for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            signal.throwIfAborted();
            if (++visited % 16 === 0)
                await yieldControl(undefined, { signal });
            const path = resolve(directory, item.name);
            const name = relative(state.task.workspace, path).replaceAll('\\', '/');
            if (name === '.codex-supervisor' || name === '.git')
                continue;
            // A checkpoint can live beside task files in any configured directory.
            // Omit only Store-owned writes, not that whole directory or its verifier.
            const local = relative(store.directory, path).replaceAll('\\', '/');
            if (relative(statePath, path) === '' || local === 'summary.md' || local === 'events.jsonl'
                || (local.startsWith('snapshots/') && generatedJson.test(local.slice('snapshots/'.length)))
                || (path.startsWith(statePath) && temporaryState.test(path.slice(statePath.length))))
                continue;
            hash.update(name);
            if (item.isSymbolicLink())
                hash.update(`link:${await readlink(path)}`);
            else if (item.isDirectory())
                await walk(path);
            else if (item.isFile()) {
                for await (const chunk of createReadStream(path, { signal })) {
                    signal.throwIfAborted();
                    hash.update(chunk);
                    await yieldControl(undefined, { signal });
                }
            }
        }
    };
    await walk(state.task.workspace);
    signal.throwIfAborted();
    return hash.digest('hex');
}
async function verification(state, store, rpc, signal) {
    const verify = state.task.verify;
    if (!verify)
        return null;
    signal.throwIfAborted();
    if (!state.protected_baseline)
        throw new Error('Missing initial protected baseline; a resumed verifier baseline must never be invented.');
    state.phase = 'VERIFY';
    store.save(state);
    const before = store.protectedChanges(state);
    const workspaceBefore = await workspaceDigest(state, store, signal);
    let timer;
    let result;
    if (before.length)
        result = { exitCode: null, stdout: '', stderr: 'Protected files changed before verification.' };
    else {
        try {
            result = await Promise.race([
                rpc.request('command/exec', { command: verify.argv, cwd: state.task.workspace, timeoutMs: verify.timeout_seconds * 1_000, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [state.task.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Independent verification timeout.')), verify.timeout_seconds * 1_000 + 1_000); }),
            ]);
            if (!result || (result.exitCode !== null && !Number.isInteger(result.exitCode)) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string')
                throw new Error('Invalid independent verification response; exitCode/stdout/stderr required.');
        }
        catch (error) {
            signal.throwIfAborted();
            result = { exitCode: null, stdout: '', stderr: error.message, timed_out: /tim(e|ed)[ -]?out/i.test(error.message) };
            if (result.timed_out) {
                await rpc.close();
                store.event(state, 'verification_terminated', { via: 'owned_app_server_exit', server_process_id: rpc.processId });
            }
        }
        finally {
            clearTimeout(timer);
        }
    }
    signal.throwIfAborted();
    const after = store.protectedChanges(state);
    const workspaceChanged = workspaceBefore !== await workspaceDigest(state, store, signal);
    signal.throwIfAborted();
    const passed = result.exitCode === 0 && !before.length && !after.length && !workspaceChanged;
    const evidence = redact({ argv: verify.argv, ...result, protected_before: before, protected_after: after, workspace_changed: workspaceChanged, passed });
    store.event(state, 'verification_result', evidence);
    if (passed)
        return null;
    const changed = new Set([...before, ...after].map((file) => file.path));
    const original = state.protected_baseline.filter((file) => changed.has(file.path));
    return continueWith(`Independent verification failed. Repair the task and restore changed protected files; keep the original fixed argv. Rerun concise acceptance checks, then prepare to stop. Evidence: ${JSON.stringify(evidence)}. Original protected content (base64): ${JSON.stringify(original)}`, 'The fixed independent completion gate did not pass.');
}
export async function superviseStop(state, request, fixture, signal, store) {
    const snapshot = snapshotFor(state, request, store);
    store.snapshot(snapshot, null);
    const connection = await connect(commandFor(state, fixture), state.task.workspace, signal);
    const judge = new AppServerJudge(Math.min(120_000, Math.max(1, Date.parse(request.deadline_at) - Date.now() - 1_000)));
    judge.bind(connection.rpc, (type, details) => {
        if (type === 'judge_created' && typeof details.thread_id === 'string') {
            state.judge_thread_ids ??= [];
            state.judge_thread_ids.push(details.thread_id);
            if (!signal.aborted && state.status === 'ACTIVE')
                store.save(state);
        }
        store.event(state, type, { ...details, stop_attempt_id: request.stop_attempt_id, main_session_id: state.main_session_id });
    });
    connection.rpc.setRequestHandler((_id, method, params) => judge.serverRequest(method, params));
    const pump = (async () => { try {
        while (true) {
            const event = await connection.rpc.next();
            judge.observe(event.method, event.params);
        }
    }
    catch (error) {
        judge.connectionFailed(error);
    } })();
    try {
        let decision;
        try {
            decision = await judge.judge(snapshot, signal);
            // Validate once more at the controller boundary so fixtures never bypass gates.
            decision = validateDecision(JSON.stringify(decision), snapshot);
            store.snapshot(snapshot, judge.rawOutput, 'valid');
        }
        catch (error) {
            store.snapshot(snapshot, judge.rawOutput, 'invalid');
            if (!signal.aborted && judge.rawOutput && /evidence|worker claims|unknown evidence/i.test(error.message)) {
                decision = continueWith(`Gather concise structured tool or file-check evidence for every original acceptance item (${state.task.acceptance.map((item) => item.id).join(', ')}). Check remaining authorized routes and implement unfinished work; a final assistant claim alone cannot establish completion or external waiting. Rejected audit: ${error.message}`, 'Supervisor terminal decision lacked sufficient independent evidence.');
            }
            else
                throw error;
        }
        signal.throwIfAborted();
        store.event(state, 'decision', { role: 'judge', thread_id: state.judge_thread_ids?.at(-1), snapshot_id: snapshot.snapshot_id, stop_attempt_id: request.stop_attempt_id, worker_thread_id: state.main_session_id, decision });
        if (decision.action === 'DONE')
            decision = await verification(state, store, connection.rpc, signal) ?? decision;
        signal.throwIfAborted();
        return decision;
    }
    finally {
        await connection.rpc.close();
        await pump;
    }
}
