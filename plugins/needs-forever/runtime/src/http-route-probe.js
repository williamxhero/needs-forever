import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { activeRouteCatalog, RouteCatalog } from './route-catalog.js';
import { RouteLedger, routeEvidenceDigest } from './route-ledger.js';
import { snapshotRouteEvidence } from './planning-context.js';
import { redact } from './redact.js';
import { literalToolCommand } from './control-intent.js';
import { routeReadAuthorization } from './route-authorization.js';
const keyDirectory = resolve(tmpdir(), 'codex-supervisor-route-probes');
const keyPath = (nonce) => { if (!/^[0-9a-f-]{36}$/.test(nonce))
    throw new Error('Invalid probe scope.'); return resolve(keyDirectory, `${nonce}.key`); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
function scopeDigest(state) {
    const native = state;
    return routeEvidenceDigest({ task: state.task, task_id: state.task_id, task_version: state.task_version, run_generation: native.run_generation ?? null, input_epoch: native.input_epoch ?? null, contract_sha256: native.contract_sha256 ?? null });
}
export function initializeHttpRouteProbe(state, statePath) {
    const digest = scopeDigest(state);
    if (state.route_probe?.scope_sha256 === digest && state.route_probe.state_path === resolve(statePath) && existsSync(keyPath(state.route_probe.nonce)))
        return;
    mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    writeFileSync(keyPath(nonce), randomBytes(32), { flag: 'wx', mode: 0o600 });
    state.route_probe = { state_path: resolve(statePath), nonce, scope_sha256: digest, argv_prefix: [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url)), 'route-probe', '--state', resolve(statePath)] };
}
function targetUrl(value) {
    if (value.length > 2048 || String(redact(value)) !== value)
        throw new Error('Probe URL must not contain credentials.');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some((name) => /token|key|auth|password|secret|credential|cookie/i.test(name)))
        throw new Error('Only credential-free HTTP(S) GET targets are supported.');
    return url;
}
const sign = (payload, key) => createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
const argvPrefix = (statePath) => [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url)), 'route-probe', '--state', resolve(statePath)];
async function readOnlyGet(url) {
    return new Promise((resolve_) => {
        let settled = false, bytes = 0, status = null, truncated = false, retry = null, retrySeconds = null;
        const hash = createHash('sha256');
        const finish = (network_error) => { if (settled)
            return; settled = true; clearTimeout(timer); resolve_({ status_code: status, bytes, body_sha256: hash.digest('hex'), truncated, retry_at: retry, retry_after_seconds: retrySeconds, network_error }); };
        // No auth, cookies, custom headers, proxy, redirects or response bodies
        // reach the receipt. The only request is A's explicit credential-free GET.
        const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, { agent: false, headers: { accept: 'application/json,text/plain;q=0.9,*/*;q=0.1' } }, (response) => {
            status = response.statusCode ?? null;
            if (status === 429) {
                const value = response.headers['retry-after'];
                if (typeof value === 'string' && /^\d{1,5}$/.test(value))
                    retrySeconds = Math.min(Number(value), 86400);
                else if (typeof value === 'string' && Number.isFinite(Date.parse(value)))
                    retry = new Date(value).toISOString();
            }
            response.on('data', (chunk) => { if (settled)
                return; const part = chunk.subarray(0, Math.max(0, 16384 - bytes)); hash.update(part); bytes += part.length; if (chunk.length > part.length) {
                truncated = true;
                finish(false);
                response.destroy();
                request.destroy();
            } });
            response.on('end', () => finish(false));
            response.on('error', () => finish(true));
        });
        const timer = setTimeout(() => { finish(true); request.destroy(); }, 2000);
        request.on('error', () => finish(true));
    });
}
/** The original A must explicitly invoke the NF-owned CLI in its authorization.
 * A JSON inventory hint never invokes this function or grants network access. */
export async function executeHttpRouteProbe(statePath, value) {
    const state = JSON.parse(readFileSync(resolve(statePath), 'utf8'));
    const context = state.route_probe;
    if (!context || context.state_path !== resolve(statePath) || context.scope_sha256 !== scopeDigest(state) || JSON.stringify(context.argv_prefix) !== JSON.stringify(argvPrefix(statePath)) || state.status !== 'ACTIVE')
        throw new Error('A current NF probe scope must be prepared by B.');
    const url = targetUrl(value);
    if (routeReadAuthorization(state.task, url.href) !== 'authorized')
        throw new Error('The current task contract does not establish read access to this probe target.');
    const result = await readOnlyGet(url);
    const payload = { schema_version: 1, task_id: state.task_id, task_version: state.task_version, scope_sha256: context.scope_sha256, nonce: context.nonce, url: url.href, observed_at: new Date().toISOString(), result };
    return { nf_route_probe: { ...payload, signature: sign(payload, readFileSync(keyPath(context.nonce))) } };
}
function literalArgv(command) {
    if (typeof command !== 'string' || command.length > 8000)
        return null;
    try {
        const parsed = JSON.parse(command);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'))
            return parsed;
    }
    catch { /* Literal shell form follows. */ }
    const source = command.trim().replace(/^&\s+/, '');
    const args = [];
    let index = 0;
    while (index < source.length) {
        while (/\s/.test(source[index] ?? '') && index < source.length)
            index++;
        if (index === source.length)
            break;
        const quote = source[index] === "'" || source[index] === '"' ? source[index++] : null;
        let token = '';
        while (index < source.length && (quote ? source[index] !== quote : !/\s/.test(source[index]))) {
            const char = source[index++];
            if ((!quote && /[;&|<>`$()"']/.test(char)) || (quote === '"' && /[`$]/.test(char)) || /[\r\n]/.test(char))
                return null;
            token += char;
        }
        if (quote && source[index++] !== quote)
            return null;
        if (index < source.length && !/\s/.test(source[index]))
            return null;
        args.push(token);
    }
    return args;
}
function sourceData(entry) {
    const value = object(entry.value), native = entry.type === 'functionCallOutput' && value.hook_event_name === 'PostToolUse' && ['Bash', 'exec_command', 'functions.exec_command', 'functions.exec'].includes(String(value.tool_name));
    const response = object(value.tool_response);
    return { command: entry.type === 'commandExecution' ? value.command : native ? literalToolCommand(value.tool_input) : null, output: entry.type === 'commandExecution' ? value.aggregatedOutput : native ? (response.stdout ?? response.output ?? value.tool_response) : null };
}
function receiptTime(entry) {
    try {
        return Date.parse(object(object(JSON.parse(String(sourceData(entry).output))).nf_route_probe).observed_at) || 0;
    }
    catch {
        return 0;
    }
}
export function ingestHttpRouteProbes(state, snapshot) {
    const context = state.route_probe;
    if (!context || context.scope_sha256 !== scopeDigest(state) || JSON.stringify(context.argv_prefix) !== JSON.stringify(argvPrefix(context.state_path)) || snapshot.evidence_complete === false || snapshot.task_id !== state.task_id || snapshot.task_version !== state.task_version || routeEvidenceDigest(snapshot.task) !== routeEvidenceDigest(redact(state.task)))
        return 0;
    const worker = state.main_session_id ?? state.worker_thread_id;
    if (snapshot.worker_thread_id !== worker)
        return 0;
    const catalog = new RouteCatalog({ task_id: state.task_id, task_version: state.task_version }, { data: activeRouteCatalog(state) });
    const proofs = snapshotRouteEvidence(snapshot);
    let accepted = 0;
    const ordered = snapshot.evidence.slice(0, 32).sort((left, right) => receiptTime(left) - receiptTime(right) || Date.parse(left.source?.observed_at ?? '') - Date.parse(right.source?.observed_at ?? ''));
    for (const entry of ordered) {
        if (accepted >= 4)
            break;
        const proof = proofs.find((item) => item.id === entry.id);
        if (!proof || entry.source?.thread_id !== worker || (entry.source.turn_id && entry.source.turn_id !== snapshot.worker_turn_id) || Math.abs(Date.now() - Date.parse(proof.observed_at)) > 600000)
            continue;
        const source = sourceData(entry), argv = literalArgv(source.command), output = source.output;
        if (!argv || typeof output !== 'string' || output.length > 8000)
            continue;
        try {
            const envelope = object(JSON.parse(output));
            if (Object.keys(envelope).length !== 1 || !envelope.nf_route_probe)
                continue;
            const receipt = object(envelope.nf_route_probe);
            if (receipt.schema_version !== 1 || receipt.task_id !== state.task_id || receipt.task_version !== state.task_version || receipt.scope_sha256 !== context.scope_sha256 || receipt.nonce !== context.nonce || !Number.isFinite(Date.parse(receipt.observed_at)) || Math.abs(Date.now() - Date.parse(receipt.observed_at)) > 600000 || !/^[0-9a-f]{64}$/.test(receipt.signature))
                continue;
            if (targetUrl(receipt.url).href !== receipt.url || argv.length !== context.argv_prefix.length + 2 || JSON.stringify(argv.slice(0, -2)) !== JSON.stringify(context.argv_prefix) || argv.at(-2) !== '--url' || targetUrl(argv.at(-1)).href !== receipt.url)
                continue;
            const { signature, ...payload } = receipt;
            if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(payload, readFileSync(keyPath(context.nonce))), 'hex')))
                continue;
            if (routeReadAuthorization(state.task, receipt.url) !== 'authorized')
                continue;
            const result = receipt.result;
            if (Object.keys(result).sort().join(',') !== 'body_sha256,bytes,network_error,retry_after_seconds,retry_at,status_code,truncated' || !/^[0-9a-f]{64}$/.test(result.body_sha256) || !Number.isInteger(result.bytes) || result.bytes < 0 || result.bytes > 16384 || ![true, false].includes(result.truncated) || ![true, false].includes(result.network_error) || (result.status_code !== null && (!Number.isInteger(result.status_code) || result.status_code < 100 || result.status_code > 599)) || (result.retry_at !== null && !Number.isFinite(Date.parse(result.retry_at))) || (result.retry_after_seconds !== null && (!Number.isInteger(result.retry_after_seconds) || result.retry_after_seconds < 0 || result.retry_after_seconds > 86400)))
                continue;
            const retryAt = result.retry_at ?? (result.retry_after_seconds !== null ? new Date(Date.parse(receipt.observed_at) + result.retry_after_seconds * 1000).toISOString() : null);
            const digest = routeEvidenceDigest({ url: receipt.url, result }), id = `http-probe:${digest}`, refs = [id];
            const observed = result.status_code !== null && result.status_code >= 200 && result.status_code < 300 && !result.network_error;
            const receiptId = routeEvidenceDigest(receipt), seen = context.seen_receipts ?? [];
            if (seen.includes(receiptId))
                continue;
            context.seen_receipts = [...seen, receiptId].slice(-128);
            const routeId = `http-api:${routeEvidenceDigest(receipt.url).slice(0, 24)}`, previous = catalog.get(routeId);
            const priorReceipt = previous?.evidence.find((item) => item.reference === `nf-http-get:${receipt.url}`);
            const priorSource = previous?.evidence.find((item) => item.id.startsWith('http-source:'));
            const delta = priorReceipt ? Date.parse(receipt.observed_at) - Date.parse(priorReceipt.observed_at) : 1;
            const sourceDelta = priorSource ? Date.parse(proof.observed_at) - Date.parse(priorSource.observed_at) : 1;
            if (delta < 0 || (delta === 0 && sourceDelta < 0) || (delta === 0 && sourceDelta === 0 && previous?.status === 'blocked' && observed))
                continue;
            catalog.upsert({ route_id: `http-api:${routeEvidenceDigest(receipt.url).slice(0, 24)}`, resource: { kind: 'api', id: receipt.url }, operation: 'http-get', status: observed ? 'observed' : 'blocked', authorization: { status: 'authorized', evidence_ids: refs }, network: { required: true, available: result.status_code !== null, evidence_ids: refs }, authentication: { status: observed ? 'not_required' : result.status_code === 401 ? 'missing' : 'unknown', evidence_ids: observed || result.status_code === 401 ? refs : [] }, rate_limit: { status: observed ? 'clear' : result.status_code === 429 ? 'limited' : 'unknown', retry_at: retryAt, evidence_ids: observed || result.status_code === 429 ? refs : [] }, last_success: observed ? { at: receipt.observed_at, evidence_ids: refs } : null, capabilities: [`Explicit A invocation of NF performed a credential-free GET; HTTP ${result.status_code ?? 'transport failure'}, ${result.bytes} bytes hashed, truncated=${result.truncated}. This proves only this request, not future quota or task completeness.`], evidence: [{ ...proof, id: `http-source:${routeEvidenceDigest({ reference: proof.reference, digest: proof.content_sha256 })}` }, { id, source: 'probe', reference: `nf-http-get:${receipt.url}`, observed_at: receipt.observed_at, task_version: state.task_version, content_sha256: digest }] });
            const route = catalog.list().find((item) => item.resource.kind === 'api' && item.resource.id === receipt.url);
            const ledger = new RouteLedger({ task_id: state.task_id, task_version: state.task_version }, state.route_ledger ? { data: state.route_ledger } : {});
            const executionOwnsResult = state.route_execution?.route.resource.kind === 'api' && state.route_execution.route.resource.id === receipt.url && !state.route_execution.completed_stop_attempt_id;
            if (!executionOwnsResult && !ledger.list().some((attempt) => attempt.evidence.some((item) => item.reference === proof.reference))) {
                const identity = { route_id: route.route_id, resource: route.resource, operation: route.operation, hypothesis_id: 'explicit-nf-http-probe', hypothesis: 'An explicit NF-owned read-only GET can establish the actual API response.', expected_evidence: ['Actual HTTP status and bounded response digest.'] };
                const evidence_ids = route.evidence.map((item) => item.id);
                if (ledger.evaluateAttempt(identity, { evidence_ids, evidence: route.evidence }).allowed) {
                    ledger.recordAttempt({ route: identity, outcome: observed ? 'diagnostic' : 'blocked', evidence_ids, evidence: route.evidence, ...(!observed ? { failure_class: `http_${result.status_code ?? 'transport_failure'}` } : {}) });
                    state.route_ledger = ledger.toJSON();
                }
            }
            accepted++;
        }
        catch { /* Unsigned, forged, foreign or unsupported outputs prove nothing. */ }
    }
    if (accepted)
        state.route_catalog = catalog.toJSON();
    return accepted;
}
