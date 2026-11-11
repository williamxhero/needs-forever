import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve, delimiter, join } from 'node:path';
import { record } from './types.js';
import { redact } from './redact.js';
export const PROTOCOL_VERSION = 'codex-cli 0.166.0';
// The generated protocol remains based on 0.166.0.  0.167.0 is wire
// compatible for the supervisor methods we use and is accepted after the
// installed native host moved forward without changing those shapes.
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, 'codex-cli 0.167.0'];
export const disabledFeatures = ['apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'memories'];
export class RpcServerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export function codexCommand() {
    if (process.platform === 'win32') {
        // Use the native executable; do not put task data through cmd.exe or PowerShell.
        const npmRoot = join(process.env.APPDATA ?? '', 'npm/node_modules/@openai/codex/node_modules/@openai');
        const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
        const executable = join(npmRoot, `codex-win32-${process.arch}`, 'vendor', `${architecture}-pc-windows-msvc/bin/codex.exe`);
        if (existsSync(executable))
            return [executable];
    }
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        const executable = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (existsSync(executable))
            return [executable];
    }
    throw new Error('Native Codex executable was not found. Install/configure Codex explicitly; no automatic install is performed.');
}
export class Rpc {
    signal;
    child;
    sequence = 0;
    pending = new Map();
    notifications = [];
    wake;
    failure;
    closing;
    stderrBuffer = '';
    onAbort = () => { void this.close(); };
    requestHandler;
    constructor(argv, cwd, overrides, signal) {
        this.signal = signal;
        signal?.throwIfAborted();
        const [executable, ...arguments_] = argv;
        if (!executable)
            throw new Error('Empty app-server argv.');
        this.child = spawn(executable, [...arguments_, 'app-server', ...overrides.flatMap((value) => ['-c', value])], { cwd, windowsHide: true, stdio: 'pipe' });
        // stderr may contain configuration/auth details. Keep only a bounded tail
        // in memory so a timeout can explain the transport boundary without
        // persisting an unbounded or unredacted provider log.
        this.child.stderr.on('data', (chunk) => {
            this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-8_192);
        });
        createInterface({ input: this.child.stdout }).on('line', (line) => {
            try {
                const message = record(JSON.parse(line));
                if (typeof message.id === 'number' && !message.method) {
                    const request = this.pending.get(message.id);
                    if (!request)
                        return;
                    this.pending.delete(message.id);
                    if (message.error) {
                        const error = record(message.error);
                        request.reject(new Error(`app-server RPC failed (${error.code ?? 'unknown'}): ${String(redact(error.message ?? 'Unknown error.'))}`));
                    }
                    else
                        request.resolve(message.result);
                }
                else if (typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number')) {
                    const id = message.id;
                    const handler = this.requestHandler;
                    if (!handler)
                        this.respond(id, undefined, { code: -32601, message: 'No server request handler.' });
                    else
                        void handler(id, message.method, message.params).then((result) => this.respond(id, result)).catch((error) => {
                            const messageText = error instanceof Error ? error.message : 'Server request rejected.';
                            const code = error instanceof RpcServerError ? error.code : -32000;
                            this.respond(id, undefined, { code, message: String(redact(messageText)) });
                        });
                }
                else if (typeof message.method === 'string') {
                    this.notifications.push({ method: message.method, params: message.params });
                    this.wake?.();
                }
            }
            catch {
                this.fail(new Error('Invalid app-server JSONL response.'));
            }
        });
        this.child.on('error', () => this.fail(new Error('Unable to start app-server.')));
        this.child.on('exit', (code) => this.fail(new Error(`app-server exited (${code}). Supervisor recovery will reconcile the saved worker history before retrying.`)));
        this.child.stdin.on('error', () => this.fail(new Error('app-server input connection closed.')));
        signal?.addEventListener('abort', this.onAbort, { once: true });
    }
    setRequestHandler(handler) { this.requestHandler = handler; }
    respond(id, result, error) {
        if (this.child.exitCode !== null || this.child.signalCode !== null)
            return;
        const response = error ? { id, error } : { id, result };
        try {
            this.child.stdin.write(`${JSON.stringify(response)}\n`);
        }
        catch { /* exit path */ }
    }
    get processId() { return this.child.pid; }
    get stderrTail() { return String(redact(this.stderrBuffer.slice(-4_096))); }
    fail(error) {
        this.failure = error;
        for (const request of this.pending.values())
            request.reject(error);
        this.pending.clear();
        this.wake?.();
    }
    request(method, params) {
        if (this.failure)
            return Promise.reject(this.failure);
        const id = ++this.sequence;
        return new Promise((resolve_, reject) => {
            this.pending.set(id, { resolve: (value) => resolve_(value), reject });
            this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
    }
    notify(method) { this.child.stdin.write(`${JSON.stringify({ method })}\n`); }
    async next() {
        while (!this.notifications.length) {
            if (this.failure)
                throw this.failure;
            await new Promise((resolve_) => { this.wake = resolve_; });
            this.wake = undefined;
        }
        return this.notifications.shift();
    }
    close() {
        this.closing ??= this.closeChild();
        return this.closing;
    }
    async closeChild() {
        this.signal?.removeEventListener('abort', this.onAbort);
        if (this.child.exitCode !== null || this.child.signalCode !== null)
            return;
        const exited = once(this.child, 'exit');
        this.child.kill();
        const timer = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
        try {
            await exited;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
async function handshake(rpc) {
    const params = { clientInfo: { name: 'codex-supervisor', title: 'Local supervisor', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } };
    await rpc.request('initialize', params);
    rpc.notify('initialized');
}
/** Original-worker recovery preserves the host's plugins, hooks, tools and
 * saved thread permissions. Judge isolation must never be applied to A. */
export async function connectWorker(argv, workspace, signal) {
    const rpc = new Rpc(argv, workspace, [], signal);
    try {
        await rpc.request('initialize', { clientInfo: { name: 'needs-forever-worker-recovery', title: 'Needs Forever worker recovery', version: '0.3.4' }, capabilities: { experimentalApi: true, requestAttestation: false } });
        rpc.notify('initialized');
        return { rpc };
    }
    catch (error) {
        await rpc.close();
        throw error;
    }
}
export async function connect(argv, workspace, signal, versionTimeoutMs = 10_000) {
    signal?.throwIfAborted();
    const [executable, ...arguments_] = argv;
    if (!executable)
        throw new Error('Empty Codex command.');
    const versionResult = spawnSync(executable, [...arguments_, '--version'], { cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: versionTimeoutMs });
    const version = versionResult.stdout?.trim();
    if (versionResult.status !== 0 || !SUPPORTED_PROTOCOL_VERSIONS.includes(version))
        throw new Error(`Unsupported Codex version. Expected one of ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}; generate and validate protocol types before changing the baseline.`);
    const common = [
        ...disabledFeatures.map((feature) => `features.${feature}=false`),
        'web_search="disabled"', 'approval_policy="never"', 'sandbox_mode="workspace-write"',
        'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true',
    ];
    if (process.env.CODEX_SUPERVISOR_TEST_NATIVE_THREAD_UNLOAD === '1')
        common.push('thread_unload_delay_secs=0');
    // Discovery connection never creates a thread or starts a model/tool.
    const probe = new Rpc(argv, workspace, common, signal);
    let names;
    const params = { cwd: workspace, includeLayers: false };
    try {
        await handshake(probe);
        const result = record(await probe.request('config/read', params));
        const config = record(result.config);
        names = Object.keys(record(config.mcp_servers ?? {}));
    }
    finally {
        await probe.close();
    }
    // -c's dotted path parser does not unquote segments. Put escaped MCP keys
    // inside one TOML inline table so names containing punctuation stay exact.
    const mcpOverride = `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(',')}}`;
    const rpc = new Rpc(argv, workspace, [...common, mcpOverride], signal);
    try {
        await handshake(rpc);
        const result = record(await rpc.request('config/read', params));
        const config = record(result.config);
        const features = record(config.features);
        if (disabledFeatures.some((feature) => features[feature] !== false) || config.web_search !== 'disabled')
            throw new Error('app-server isolation feature verification failed.');
        const servers = record(config.mcp_servers ?? {});
        if (Object.values(servers).some((server) => record(server).enabled !== false))
            throw new Error('External MCP isolation verification failed.');
        return { rpc, version, disabled_mcp: names };
    }
    catch (error) {
        await rpc.close();
        throw error;
    }
}
