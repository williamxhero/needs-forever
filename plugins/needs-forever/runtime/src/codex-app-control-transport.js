import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { sameWorkspacePath } from './main-session-provider.js';
const execFile = promisify(execFileCallback);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const CODEX_APP_NAMESPACE = 'codex_app';
const REQUIRED_TOOLS = new Set(['read_thread', 'send_message_to_thread']);
const DEFAULT_PIPE_ROOT = '\\\\.\\pipe\\';
function objectOf(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function stringOf(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}
function pipePathOf(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith('\\\\.\\pipe\\'))
        return trimmed;
    return `\\\\.\\pipe\\${trimmed}`;
}
function pipeFingerprint(value) {
    return createHash('sha256').update(value).digest('hex');
}
function identityFence(params) {
    const raw = objectOf(params) ?? {};
    const result = {};
    for (const key of ['target_thread_id', 'target_session_id', 'workspace', 'host_instance_id', 'host_fingerprint', 'task_version', 'run_generation', 'input_epoch', 'contract_sha256']) {
        if (raw[key] !== undefined)
            result[key] = raw[key];
    }
    return result;
}
function targetThreadId(params) {
    const raw = objectOf(params) ?? {};
    const threadId = stringOf(raw.target_thread_id) ?? stringOf(raw.threadId);
    if (!threadId)
        throw new Error('Codex app control requires a target thread id.');
    return threadId;
}
function latestTurnId(parsed) {
    const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
    const first = objectOf(turns[0]);
    return stringOf(first?.id) ?? stringOf(first?.turn_id);
}
function threadStatus(parsed) {
    const thread = objectOf(parsed.thread) ?? {};
    const status = objectOf(thread.status);
    return stringOf(status?.type) ?? stringOf(thread.status) ?? 'unknown';
}
function textFromItem(item) {
    const raw = objectOf(item);
    if (!raw)
        return null;
    const direct = stringOf(raw.text) ?? stringOf(raw.message) ?? stringOf(raw.prompt) ?? stringOf(raw.content);
    if (direct)
        return direct;
    if (Array.isArray(raw.content)) {
        for (const part of raw.content) {
            const text = stringOf(objectOf(part)?.text);
            if (text)
                return text;
        }
    }
    return null;
}
function containsMessage(parsed, message) {
    const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
    for (const turn of turns) {
        const items = objectOf(turn)?.items;
        if (!Array.isArray(items))
            continue;
        for (const item of items) {
            if (textFromItem(item) === message)
                return true;
        }
    }
    return false;
}
function parseToolText(result) {
    const raw = objectOf(result) ?? {};
    if (raw.success === false) {
        const item = Array.isArray(raw.contentItems) ? objectOf(raw.contentItems[0]) : null;
        throw new Error(stringOf(item?.text) ?? 'Codex app tool call failed.');
    }
    const item = Array.isArray(raw.contentItems)
        ? raw.contentItems.map(objectOf).find((candidate) => candidate?.type === 'inputText')
        : null;
    const text = stringOf(item?.text);
    if (!text)
        throw new Error('Codex app tool returned no text result.');
    try {
        const parsed = JSON.parse(text);
        return objectOf(parsed) ?? {};
    }
    catch {
        return { text };
    }
}
function responseIdentity(params, parsed, endpointFingerprint, hostId) {
    const fence = identityFence(params);
    const thread = objectOf(parsed.thread) ?? {};
    const threadId = stringOf(thread.id) ?? stringOf(thread.thread_id) ?? stringOf(fence.target_thread_id);
    const workspace = stringOf(thread.cwd) ?? stringOf(thread.workspace) ?? stringOf(fence.workspace);
    return {
        target_thread_id: threadId,
        target_session_id: stringOf(fence.target_session_id) ?? threadId,
        main_session_id: stringOf(fence.target_thread_id) ?? threadId,
        workspace,
        host_instance_id: stringOf(fence.host_instance_id) ?? `codex-desktop:${hostId}`,
        host_fingerprint: stringOf(fence.host_fingerprint) ?? endpointFingerprint,
        task_version: fence.task_version,
        run_generation: fence.run_generation,
        input_epoch: fence.input_epoch ?? null,
        contract_sha256: fence.contract_sha256 ?? null,
    };
}
class FramedPipeClient {
    pipePath;
    socket = null;
    connecting = null;
    nextId = 1;
    pending = new Map();
    buffer = Buffer.alloc(0);
    constructor(pipePath) {
        this.pipePath = pipePath;
    }
    async request(method, params) {
        await this.connect();
        const socket = this.socket;
        if (!socket || socket.destroyed)
            throw new Error('Codex app control pipe is disconnected.');
        const id = this.nextId++;
        const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
        const body = Buffer.from(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
        if (body.length > MAX_FRAME_BYTES)
            throw new Error('Codex app control request is too large.');
        const frame = Buffer.alloc(4 + body.length);
        frame.writeUInt32LE(body.length, 0);
        body.copy(frame, 4);
        socket.write(frame);
        return response;
    }
    close() {
        const error = new Error('Codex app control pipe closed.');
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
        this.socket?.destroy();
        this.socket = null;
        this.buffer = Buffer.alloc(0);
    }
    async connect() {
        if (this.socket && !this.socket.destroyed)
            return;
        if (this.connecting)
            return this.connecting;
        this.connecting = new Promise((resolve, reject) => {
            const socket = net.createConnection(this.pipePath);
            const fail = (error) => { socket.destroy(); reject(error); };
            socket.once('error', fail);
            socket.once('connect', () => {
                socket.off('error', fail);
                this.socket = socket;
                socket.on('data', chunk => this.onData(socket, chunk));
                socket.on('error', error => this.disconnect(socket, error));
                socket.on('close', () => this.disconnect(socket, new Error('Codex app control pipe closed.')));
                resolve();
            });
        }).finally(() => { this.connecting = null; });
        return this.connecting;
    }
    onData(socket, chunk) {
        if (this.socket !== socket)
            return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (length > MAX_FRAME_BYTES) {
                this.disconnect(socket, new Error('Codex app control response is too large.'));
                socket.destroy();
                return;
            }
            if (this.buffer.length < length + 4)
                return;
            const payload = this.buffer.subarray(4, length + 4);
            this.buffer = this.buffer.subarray(length + 4);
            let response;
            try {
                response = JSON.parse(payload.toString('utf8'));
            }
            catch {
                this.disconnect(socket, new Error('Codex app control returned invalid JSON.'));
                socket.destroy();
                return;
            }
            const pending = this.pending.get(Number(response.id));
            if (!pending)
                continue;
            this.pending.delete(Number(response.id));
            if (response.error)
                pending.reject(new Error(response.error.message));
            else
                pending.resolve(response.result);
        }
    }
    disconnect(socket, error) {
        if (this.socket !== socket)
            return;
        this.socket = null;
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
    }
}
export async function discoverCodexAppControlPipe(timeoutMs = 5000) {
    if (process.platform !== 'win32')
        return null;
    // PowerShell's named-pipe provider does not reliably expand a wildcard in
    // the path when launched from a detached Node process. Enumerate the pipe
    // root, then filter names in PowerShell instead.
    const command = `Get-ChildItem -Path '${DEFAULT_PIPE_ROOT}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name | Where-Object { $_ -like 'codex-browser-use-*' }`;
    let stdout = '';
    try {
        const result = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
        stdout = result.stdout;
    }
    catch {
        return null;
    }
    const candidates = [...new Set(stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    for (const candidate of candidates) {
        const client = new FramedPipeClient(pipePathOf(candidate));
        try {
            const listed = objectOf(await client.request('tools/list', { threadStartKind: 'all' }));
            const tools = Array.isArray(listed?.tools) ? listed.tools : [];
            const names = new Set(tools.map(item => stringOf(objectOf(item)?.name)).filter((value) => value !== null));
            if ([...REQUIRED_TOOLS].every(name => names.has(name)))
                return pipePathOf(candidate);
        }
        catch { /* this is another native pipe; continue probing candidates */ }
        finally {
            client.close();
        }
    }
    return null;
}
export class CodexAppControlTransport {
    metadata;
    options;
    pipePath;
    client = null;
    toolsReady = false;
    constructor(options = {}) {
        this.options = options;
        this.pipePath = options.pipePath ? pipePathOf(options.pipePath) : process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim() ? pipePathOf(process.env.CODEX_APP_TOOLS_PIPE_PATH) : null;
        const fingerprint = options.endpointFingerprint ?? (this.pipePath ? pipeFingerprint(this.pipePath) : null);
        this.metadata = {
            provider_kind: 'ui-bridge',
            evidence_level: 'live',
            protocol_version: options.protocolVersion ?? 'codex-app-tools-native-pipe/v1',
            provider_version: options.providerVersion ?? 'codex-app-tools-host',
            endpoint_fingerprint: fingerprint,
            identity: options.identity ?? null,
            capabilities: {
                read_thread: true,
                read_writer: true,
                resume_send: true,
                subscribe_events: false,
                read_history: true,
                reconcile_delivery: true,
            },
        };
    }
    async request(method, params) {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const result = await this.requestOnce(method, params);
                return result;
            }
            catch (error) {
                lastError = error;
                this.resetClient();
                if (attempt === 0)
                    await this.discover();
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    close() { this.resetClient(); }
    async requestOnce(method, params) {
        const threadId = targetThreadId(params);
        const parsed = await this.callTool(method, threadId, params);
        const endpointFingerprint = this.metadata.endpoint_fingerprint ?? (this.pipePath ? pipeFingerprint(this.pipePath) : 'unknown');
        const hostId = this.options.hostId ?? 'local';
        const identity = responseIdentity(params, parsed, endpointFingerprint, hostId);
        if (method === 'provider/probe') {
            const thread = objectOf(parsed.thread) ?? {};
            const actualThreadId = stringOf(thread.id) ?? stringOf(thread.thread_id);
            const actualWorkspace = stringOf(thread.cwd) ?? stringOf(thread.workspace);
            const identityWorkspace = stringOf(identity.workspace);
            const sameThread = actualThreadId === threadId && !!actualWorkspace && !!identityWorkspace && sameWorkspacePath(actualWorkspace, identityWorkspace);
            return { identity, available: sameThread, same_thread_verified: sameThread, capabilities: this.metadata.capabilities, protocol_version: this.metadata.protocol_version, provider_version: this.metadata.provider_version, endpoint_fingerprint: endpointFingerprint, limitation_reason: sameThread ? null : 'Codex app control returned a different thread or workspace.' };
        }
        const thread = objectOf(parsed.thread) ?? {};
        const threadWithWriter = {
            ...thread,
            id: stringOf(thread.id) ?? threadId,
            session_id: stringOf(thread.session_id) ?? identity.target_session_id,
            workspace: stringOf(thread.cwd) ?? stringOf(thread.workspace) ?? identity.workspace,
            status: thread.status,
            writer: {
                status: /active|running|inprogress/i.test(threadStatus(parsed)) ? 'in-progress' : 'idle',
                owner_session_id: identity.target_session_id,
                turn_id: latestTurnId(parsed),
                reason: null,
            },
            turns: Array.isArray(parsed.turns) ? parsed.turns : [],
        };
        if (method === 'thread/reconcile') {
            const requested = stringOf(objectOf(params)?.message);
            const present = requested ? containsMessage(parsed, requested) : false;
            return { identity, outcome: present ? 'confirmed' : 'not_found', matched_by: present ? 'activity' : 'none', target_turn_id: present ? latestTurnId(parsed) : null, reason: present ? null : 'Original thread history contains no exact matching message.' };
        }
        if (method === 'thread/writer')
            return { identity, ...threadWithWriter.writer };
        if (method === 'thread/send')
            return { identity, outcome: 'sent', target_turn_id: null, reason: null };
        if (method === 'thread/read' || method === 'thread/resume')
            return { identity, thread: threadWithWriter };
        if (method === 'thread/history')
            return { identity, turns: threadWithWriter.turns, has_more: objectOf(parsed.page)?.hasMore === true, cursor: stringOf(objectOf(parsed.page)?.nextCursor), readable: true, limitation_reason: null };
        return { identity, thread: threadWithWriter };
    }
    async callTool(method, threadId, params) {
        const tool = method === 'thread/send' ? 'send_message_to_thread' : method === 'provider/probe' || method === 'thread/read' || method === 'thread/writer' || method === 'thread/resume' || method === 'thread/history' || method === 'thread/reconcile' ? 'read_thread' : null;
        if (!tool)
            throw new Error(`Unsupported Codex app control method: ${method}`);
        const args = { threadId, hostId: this.options.hostId ?? 'local' };
        if (tool === 'send_message_to_thread') {
            const raw = objectOf(params) ?? {};
            const message = stringOf(raw.message);
            if (!message)
                throw new Error('Codex app send requires a message.');
            args.prompt = message;
        }
        else {
            args.turnLimit = method === 'thread/history' || method === 'thread/reconcile' ? 10 : 1;
            args.includeOutputs = false;
            args.maxOutputCharsPerItem = 4000;
            const cursor = stringOf(objectOf(params)?.cursor);
            if (cursor)
                args.cursor = cursor;
        }
        const result = await this.toolRequest(tool, threadId, args);
        return parseToolText(result);
    }
    async toolRequest(tool, threadId, args) {
        await this.ensureClient();
        if (!this.client)
            throw new Error('Codex app control pipe is unavailable.');
        return this.client.request('tools/call', { arguments: args, callerSource: 'codex', callId: `nf-${Date.now()}`, namespace: CODEX_APP_NAMESPACE, threadId, tool, turnId: `nf-${Date.now()}` });
    }
    async ensureClient() {
        if (!this.pipePath)
            await this.discover();
        if (!this.pipePath)
            throw new Error('Codex app control pipe is unavailable.');
        if (!this.client)
            this.client = new FramedPipeClient(this.pipePath);
        if (this.toolsReady)
            return;
        const listed = objectOf(await this.client.request('tools/list', { threadStartKind: 'all' }));
        const tools = Array.isArray(listed?.tools) ? listed.tools : [];
        const names = new Set(tools.map(item => stringOf(objectOf(item)?.name)).filter((value) => value !== null));
        if (![...REQUIRED_TOOLS].every(name => names.has(name)))
            throw new Error('Selected pipe is not the Codex app control bridge.');
        this.toolsReady = true;
    }
    async discover() {
        const discovered = this.options.discoverPipePath
            ? await this.options.discoverPipePath()
            : await discoverCodexAppControlPipe(this.options.discoveryTimeoutMs ?? 5000);
        if (!discovered)
            throw new Error('No Codex app control pipe with read_thread/send_message_to_thread was found.');
        this.pipePath = pipePathOf(discovered);
        this.toolsReady = false;
    }
    resetClient() { this.client?.close(); this.client = null; this.toolsReady = false; }
}
