import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicJson, canonicalPath, contractHash, indexPath, readJson } from './main-session.js';
import { Store } from './store.js';
import { record, text } from './types.js';
import { redact } from './redact.js';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizedCommand = (value) => value.replace(/\\+/g, '/').toLowerCase();
function strings(value) {
    if (typeof value === 'string')
        return [value];
    if (Array.isArray(value))
        return value.flatMap(strings);
    if (value && typeof value === 'object')
        return Object.values(value).flatMap(strings);
    return [];
}
function isAgent(event) {
    return event.agent_id != null || event.agent_type != null || event.agent_transcript_path != null || event.hook_event_name === 'SubagentStop' || event.hook_event_name === 'SubagentStart';
}
export function handleLifecycle(input, host, pluginRoot) {
    const event = record(input);
    const name = text(event.hook_event_name, 'hook_event_name');
    if (isAgent(event))
        return {};
    const workspace = text(event.cwd, 'cwd');
    if (canonicalPath(workspace) !== canonicalPath(process.cwd()))
        return {};
    const session = text(event.session_id, 'session_id');
    if (host.source === 'unverified')
        return {};
    const toolId = typeof event.tool_use_id === 'string' ? event.tool_use_id : null;
    const observation = toolId ? resolve(workspace, '.codex-supervisor', 'hook-observations', `${hash([session, toolId])}.json`) : null;
    if (name === 'PreToolUse' && observation) {
        const command = normalizedCommand(strings(event.tool_input).join('\n'));
        if (!command.includes(normalizedCommand(resolve(pluginRoot, 'scripts/main-session.mjs'))) || !command.includes('prepare'))
            return {};
        // Only fingerprints are retained; command bodies can contain credentials.
        atomicJson(observation, { session_id: session, tool_use_id: toolId, cwd: canonicalPath(workspace), input_sha256: hash(event.tool_input), source: host.source, at: Date.now(), plugin_root: canonicalPath(pluginRoot) });
        return {};
    }
    const index = indexPath(workspace);
    if (!existsSync(index))
        return {};
    const entries = readJson(index).states;
    for (const path of entries) {
        if (!existsSync(path))
            continue;
        const state = readJson(path);
        if (state.control_mode !== 'main-session' || state.status === 'DONE' || canonicalPath(state.task.workspace) !== canonicalPath(workspace))
            continue;
        if (state.contract_sha256 !== contractHash(state.task))
            continue;
        if ((state.mode === 'simulated') !== (host.source === 'simulated'))
            continue;
        if (name === 'Stop' && state.binding.status === 'BOUND' && state.main_session_id === session && !state.pause_reason) {
            const request = {
                schema_version: 1, task_id: state.task_id, task_version: state.task_version, contract_sha256: state.contract_sha256,
                run_generation: state.run_generation, session_id: session, turn_id: typeof event.turn_id === 'string' ? event.turn_id : null,
                stop_attempt_id: randomUUID(), stop_hook_active: event.stop_hook_active === true,
                created_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 590_000).toISOString(), mode: state.mode,
                last_assistant_message: typeof event.last_assistant_message === 'string' ? String(redact(event.last_assistant_message)).slice(0, 32_000) : null,
            };
            state.last_stop = request;
            const store = new Store(path);
            store.save(state);
            store.event(state, 'main_session_stop_observed', { session_id: session, turn_id: request.turn_id, stop_attempt_id: request.stop_attempt_id, run_generation: state.run_generation, host_source: host.source });
            // This only creates the request. The B adapter must validate an active
            // lease and return a supported host decision before claiming readiness.
            return state.status === 'ACTIVE' ? { state_path: path, stop_request: request } : {};
        }
        if (state.binding.status !== 'PENDING_NATIVE_HOOK' || name !== 'PostToolUse' || !observation || !existsSync(observation))
            continue;
        const prior = readJson(observation);
        if (prior.session_id !== session || prior.tool_use_id !== toolId || prior.input_sha256 !== hash(event.tool_input) || prior.source !== host.source || prior.cwd !== canonicalPath(workspace) || prior.plugin_root !== canonicalPath(pluginRoot) || Date.now() - prior.at > 10 * 60_000)
            continue;
        const command = normalizedCommand(strings(event.tool_input).join('\n'));
        // Actual receipt output (unknown before preparation) correlates a registered
        // host's pre/post pair to this one task. A session-id flag cannot do this.
        if (!command.includes(normalizedCommand(resolve(pluginRoot, 'scripts/main-session.mjs'))) || !command.includes('prepare') || !command.includes(normalizedCommand(state.binding.task_path)) || !command.includes(normalizedCommand(path)))
            continue;
        if (!strings(event.tool_response).some((value) => value.includes(state.binding.challenge)))
            continue;
        state.main_session_id = session;
        state.binding = { ...state.binding, status: 'BOUND', tool_use_id: toolId, bound_at: new Date().toISOString() };
        state.host = { ...host, hook_effective: false, reason: 'Main-session identity correlated; awaiting a real Stop callback and background control readiness.' };
        state.recovery_condition = { kind: 'stop_hook_required', message: 'Main-session bound; supervision is not active until background control and Stop callback are confirmed.', resume_when: 'Start the bound background controller and observe its native Stop callback.' };
        const store = new Store(path);
        store.save(state);
        store.event(state, 'main_session_bound', { main_session_id: session, tool_use_id: toolId, host_source: host.source, desktop_version: host.desktop_version, cli_version: host.cli_version });
        return { bound: true, state_path: path };
    }
    return {};
}
