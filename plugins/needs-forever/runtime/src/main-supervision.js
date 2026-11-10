import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { setImmediate as yieldControl } from 'node:timers/promises';
import { dirname, isAbsolute, resolve, relative } from 'node:path';
import { AppServerJudge, archiveTerminatedJudge, validateDecision } from './judge.js';
import { codexCommand, connect } from './transport.js';
import { Store } from './store.js';
import { redact } from './redact.js';
import { buildC2Context } from './planning-context.js';
import { routeInventoryDecision } from './planning.js';
const budget = 21_500; // Reserve bounded C2 catalog/ledger metadata after current proof.
async function retryRead(operation, path, read, signal) {
    const deadline = Date.now() + 5_000;
    while (true) {
        signal.throwIfAborted();
        try {
            return await read();
        }
        catch (error) {
            const code = error.code;
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() >= deadline) {
                throw new Error(`${operation} ${path}: ${error.message}`, { cause: error });
            }
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, 10 + Math.floor(Math.random() * 40));
                signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
            });
        }
    }
}
async function readFileRetry(path, signal) {
    return retryRead('read', path, () => readFile(path), signal);
}
function verificationWorkspace(state) {
    const verify = state.task.verify;
    if (!verify || verify.argv.length < 2 || !isAbsolute(verify.argv[1]))
        return state.task.workspace;
    const workspace = resolve(state.task.workspace);
    const candidates = [dirname(resolve(verify.argv[1])), ...verify.protected_files.map((file) => dirname(resolve(file)))];
    const first = candidates[0];
    const prefix = process.platform === 'win32' ? first.toLowerCase() : first;
    if (candidates.some((candidate) => {
        const value = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
        return value !== prefix;
    }))
        return state.task.workspace;
    const suffix = relative(workspace, first);
    if (suffix === '' || isAbsolute(suffix) || suffix === '..' || suffix.startsWith('../') || suffix.startsWith('..\\'))
        return state.task.workspace;
    return first;
}
function continueWith(snapshot, message, reason) {
    const concise = message.length <= 3_000 ? message : `${message.slice(0, 2700)}\nRead the persisted verification_result and protected baseline for the complete evidence and original protected contents.`;
    const decision = snapshot.c2?.mode === 'legacy' ? { action: 'CONTINUE', reason, evidence_ids: [], next_message: concise, external: null } : routeInventoryDecision(snapshot, reason, concise);
    return validateDecision(JSON.stringify(decision), snapshot);
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
export function buildMainSessionSnapshot(state, request, events) {
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
            const entry = { id: String(event.event_id), type: 'functionCallOutput', value: event.value, source: { event_id: String(event.event_id), ...(typeof event.at === 'string' ? { observed_at: event.at } : {}), thread_id: state.main_session_id, ...(typeof event.turn_id === 'string' ? { turn_id: event.turn_id } : {}), item_id: String(event.tool_use_id) } };
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
    const planEvent = [...events].reverse().find((event) => event.type === 'main_tool_result' && currentEvents.has(event) && event.session_id === state.main_session_id && event.run_generation === state.run_generation && event.input_epoch === (state.input_epoch ?? 0) && event.contract_sha256 === state.contract_sha256 && typeof event.value === 'object' && event.value !== null && /(?:update_plan|plan)/.test(String(event.value.tool_name)));
    if (planEvent && JSON.stringify(planEvent.value).length < 1_500)
        snapshot.plan = { observed: planEvent.value, source_event_id: planEvent.event_id };
    return buildC2Context(snapshot, state);
}
async function workspaceDigest(state, store, signal) {
    const hash = createHash('sha256');
    const statePath = resolve(store.path);
    const temporaryState = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
    let visited = 0;
    const walk = async (directory) => {
        signal.throwIfAborted();
        const entries = await retryRead('readdir', directory, () => readdir(directory, { withFileTypes: true }), signal);
        for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            signal.throwIfAborted();
            if (++visited % 16 === 0)
                await yieldControl(undefined, { signal });
            const path = resolve(directory, item.name);
            const name = relative(state.task.workspace, path).replaceAll('\\', '/');
            if (name === '.codex-supervisor' || name === '.git')
                continue;
            // Historical Desktop acceptance profiles are generated supervision
            // fixtures, not task business files. Chromium keeps files such as
            // Network/Cookies open with a deny-read handle on Windows; traversing
            // this directory makes an otherwise valid DONE verification fail with
            // EBUSY. Keep the current task artifacts hashable while excluding only
            // this known generated fixture root.
            const lowerPath = name.toLowerCase();
            if (lowerPath === '.scratch/main-session-supervision' || lowerPath.startsWith('.scratch/main-session-supervision/'))
                continue;
            const lowerName = item.name.toLowerCase();
            const generatedLock = (lowerName === 'lock' || lowerName === 'lock.reclaim' || lowerName.endsWith('.lock') || lowerName.endsWith('.lock.reclaim'))
                && !new Set(['cargo.lock', 'flake.lock', 'module.bazel.lock']).has(lowerName);
            // A checkpoint can live beside task files in any configured directory.
            // Omit only Store-owned writes, not that whole directory or its verifier.
            const local = relative(store.directory, path).replaceAll('\\', '/');
            if (relative(statePath, path) === '' || local === 'summary.md' || local === 'events.jsonl'
                || generatedLock || path === `${statePath}.lock` || path === `${statePath}.lock.reclaim`
                || (path.startsWith(statePath) && temporaryState.test(path.slice(statePath.length))))
                continue;
            hash.update(name);
            if (item.isSymbolicLink())
                hash.update(`link:${await retryRead('readlink', path, () => readlink(path), signal)}`);
            else if (item.isDirectory())
                await walk(path);
            else if (item.isFile()) {
                hash.update(await readFileRetry(path, signal));
                await yieldControl(undefined, { signal });
            }
        }
    };
    await walk(state.task.workspace);
    signal.throwIfAborted();
    return hash.digest('hex');
}
async function verification(state, store, rpc, signal, snapshot) {
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
    const sandboxWorkspace = verificationWorkspace(state);
    if (before.length)
        result = { exitCode: null, stdout: '', stderr: 'Protected files changed before verification.' };
    else {
        try {
            result = await Promise.race([
                rpc.request('command/exec', { command: verify.argv, cwd: sandboxWorkspace, timeoutMs: verify.timeout_seconds * 1_000, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [sandboxWorkspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }),
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
    return continueWith(snapshot, `Independent verification failed. Repair the task and restore changed protected files; keep the original fixed argv. Rerun concise acceptance checks, then prepare to stop. Evidence: ${JSON.stringify(evidence)}. Original protected content (base64): ${JSON.stringify(original)}`, 'The fixed independent completion gate did not pass.');
}
export async function superviseStop(state, request, fixture, signal, store) {
    const snapshot = buildMainSessionSnapshot(state, request, store.events());
    store.snapshot(snapshot, null);
    const connection = await connect(commandFor(state, fixture), state.task.workspace, signal);
    const timeout = state.mode === 'simulated' && Number.isFinite(fixture?.judge_timeout_ms) ? Math.max(1, Number(fixture.judge_timeout_ms)) : 120_000;
    const judge = new AppServerJudge(Math.min(timeout, Math.max(1, Date.parse(request.deadline_at) - Date.now() - 1_000)));
    judge.bind(connection.rpc, (type, details) => {
        if (type === 'judge_created' && typeof details.thread_id === 'string') {
            state.judge_thread_ids ??= [];
            state.judge_thread_ids.push(details.thread_id);
            if (!signal.aborted && state.status === 'ACTIVE')
                store.save(state);
        }
        store.event(state, type, { ...details, stop_attempt_id: request.stop_attempt_id, main_session_id: state.main_session_id });
    }, (threadId) => archiveTerminatedJudge(commandFor(state, fixture), state.task.workspace, threadId));
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
                decision = continueWith(snapshot, `Gather concise structured tool or file-check evidence for every original acceptance item (${state.task.acceptance.map((item) => item.id).join(', ')}). Check remaining authorized routes and implement unfinished work; a final assistant claim alone cannot establish completion or external waiting. Rejected audit: ${error.message}`, 'Supervisor terminal decision lacked sufficient independent evidence.');
            }
            else
                throw error;
        }
        signal.throwIfAborted();
        store.event(state, 'decision', { role: 'judge', thread_id: state.judge_thread_ids?.at(-1), snapshot_id: snapshot.snapshot_id, stop_attempt_id: request.stop_attempt_id, worker_thread_id: state.main_session_id, decision });
        if (decision.action === 'DONE')
            decision = await verification(state, store, connection.rpc, signal, snapshot) ?? decision;
        signal.throwIfAborted();
        return decision;
    }
    finally {
        await connection.rpc.close();
        await pump;
    }
}
