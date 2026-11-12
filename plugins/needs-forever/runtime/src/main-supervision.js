import { randomUUID } from 'node:crypto';
import { AppServerJudge, archiveTerminatedJudge, validateDecision } from './judge.js';
import { codexCommand, connect } from './transport.js';
import { Store } from './store.js';
import { redact } from './redact.js';
import { buildC2Context } from './planning-context.js';
import { completionGate, continueWith } from './completion-gate.js';
const budget = 21_500; // Reserve bounded C2 catalog/ledger metadata after current proof.
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
            const entry = { id: String(event.event_id), type: 'functionCallOutput', value: event.value, complete: event.complete !== false, source: { event_id: String(event.event_id), ...(typeof event.at === 'string' ? { observed_at: event.at } : {}), thread_id: state.main_session_id, ...(typeof event.turn_id === 'string' ? { turn_id: event.turn_id } : {}), item_id: String(event.tool_use_id) } };
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
export async function superviseStop(state, request, fixture, signal, store, snapshot = buildMainSessionSnapshot(state, request, store.events())) {
    store.snapshot(snapshot, null);
    const connection = await connect(commandFor(state, fixture), state.task.workspace, signal);
    const timeout = state.mode === 'simulated' && Number.isFinite(fixture?.judge_timeout_ms) ? Math.max(1, Number(fixture.judge_timeout_ms)) : 120_000;
    const judge = new AppServerJudge(Math.min(timeout, Math.max(1, Date.parse(request.deadline_at) - Date.now() - 1_000)), connection.model);
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
        decision = await completionGate({ state, snapshot, store, rpc: connection.rpc, signal }, decision);
        signal.throwIfAborted();
        return decision;
    }
    finally {
        await connection.rpc.close();
        await pump;
    }
}
