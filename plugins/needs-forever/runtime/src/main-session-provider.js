import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
export const ALL_PROVIDER_CAPABILITIES = {
    read_thread: true,
    read_writer: true,
    resume_send: true,
    subscribe_events: true,
    read_history: true,
    reconcile_delivery: true,
};
export const DEFAULT_DESKTOP_PROVIDER_RPC_METHODS = {
    probe: 'provider/probe',
    read_thread: 'thread/read',
    read_writer: 'thread/writer',
    resume: 'thread/resume',
    send: 'thread/send',
    read_history: 'thread/history',
    reconcile_delivery: 'thread/reconcile',
};
export class ProviderIdentityError extends Error {
    code = 'provider_identity_unavailable';
    constructor(message) { super(message); this.name = 'ProviderIdentityError'; }
}
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function now() { return new Date().toISOString(); }
function completeIdentity(value) {
    return !!value
        && nonEmpty(value.target_thread_id)
        && nonEmpty(value.target_session_id)
        && nonEmpty(value.workspace)
        && isAbsolute(value.workspace)
        && nonEmpty(value.host_instance_id)
        && nonEmpty(value.host_fingerprint)
        && typeof value.task_version === 'number'
        && Number.isInteger(value.task_version)
        && value.task_version > 0
        && nonEmpty(value.run_generation)
        && (value.input_epoch === undefined || (typeof value.input_epoch === 'number' && Number.isInteger(value.input_epoch) && value.input_epoch >= 0));
}
function identityMatches(expected, actual) {
    return expected.target_thread_id === actual.target_thread_id
        && expected.target_session_id === actual.target_session_id
        && (expected.main_session_id ?? expected.target_thread_id) === (actual.main_session_id ?? actual.target_thread_id)
        && expected.workspace === actual.workspace
        && expected.host_instance_id === actual.host_instance_id
        && expected.host_fingerprint === actual.host_fingerprint
        && expected.task_version === actual.task_version
        && expected.run_generation === actual.run_generation
        && (expected.input_epoch ?? null) === (actual.input_epoch ?? null)
        && (expected.contract_sha256 ?? null) === (actual.contract_sha256 ?? null);
}
function unavailableReceipt(target, reason) {
    return {
        schema_version: 1,
        provider_kind: 'unavailable',
        evidence_level: 'unavailable',
        available: false,
        attached: false,
        same_thread_verified: false,
        capabilities: { read_thread: false, read_writer: false, resume_send: false, subscribe_events: false, read_history: false, reconcile_delivery: false },
        target_thread_id: nonEmpty(target?.target_thread_id) ? target.target_thread_id : null,
        target_session_id: nonEmpty(target?.target_session_id) ? target.target_session_id : null,
        main_session_id: nonEmpty(target?.main_session_id) ? target.main_session_id : null,
        workspace: nonEmpty(target?.workspace) ? target.workspace : null,
        host_instance_id: nonEmpty(target?.host_instance_id) ? target.host_instance_id : null,
        host_fingerprint: nonEmpty(target?.host_fingerprint) ? target.host_fingerprint : null,
        protocol_version: null,
        provider_version: null,
        endpoint_fingerprint: null,
        task_version: typeof target?.task_version === 'number' && Number.isInteger(target.task_version) ? target.task_version : null,
        run_generation: nonEmpty(target?.run_generation) ? target.run_generation : null,
        input_epoch: typeof target?.input_epoch === 'number' && Number.isInteger(target.input_epoch) && target.input_epoch >= 0 ? target.input_epoch : null,
        contract_sha256: nonEmpty(target?.contract_sha256) ? target.contract_sha256 : null,
        limitation_reason: reason,
        observed_at: now(),
    };
}
export function createCapabilityReceipt(input) {
    const capabilities = { ...{ read_thread: false, read_writer: false, resume_send: false, subscribe_events: false, read_history: false, reconcile_delivery: false }, ...input.capabilities };
    return {
        schema_version: 1,
        provider_kind: input.provider_kind,
        evidence_level: input.evidence_level,
        available: input.available ?? false,
        attached: input.attached ?? false,
        same_thread_verified: input.same_thread_verified ?? false,
        capabilities,
        target_thread_id: input.target_thread_id ?? null,
        target_session_id: input.target_session_id ?? null,
        main_session_id: input.main_session_id ?? input.target_thread_id ?? null,
        workspace: input.workspace ?? null,
        host_instance_id: input.host_instance_id ?? null,
        host_fingerprint: input.host_fingerprint ?? null,
        protocol_version: input.protocol_version ?? null,
        provider_version: input.provider_version ?? null,
        endpoint_fingerprint: input.endpoint_fingerprint ?? null,
        task_version: input.task_version ?? null,
        run_generation: input.run_generation ?? null,
        input_epoch: input.input_epoch ?? null,
        contract_sha256: input.contract_sha256 ?? null,
        limitation_reason: input.limitation_reason ?? null,
        observed_at: input.observed_at ?? now(),
    };
}
export function validateCapabilityReceipt(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Capability receipt must be an object.');
    const receipt = value;
    if (receipt.schema_version !== 1)
        throw new Error('Unsupported capability receipt schema.');
    if (!['shared-server', 'daemon', 'native-hook', 'ui-bridge', 'simulated', 'unavailable'].includes(String(receipt.provider_kind)))
        throw new Error('Invalid capability receipt provider kind.');
    if (!['live', 'simulated', 'unverified', 'unavailable'].includes(String(receipt.evidence_level)))
        throw new Error('Invalid capability receipt evidence level.');
    if (typeof receipt.available !== 'boolean' || typeof receipt.attached !== 'boolean' || typeof receipt.same_thread_verified !== 'boolean')
        throw new Error('Capability receipt availability fields are invalid.');
    if (!receipt.capabilities || typeof receipt.capabilities !== 'object' || Array.isArray(receipt.capabilities))
        throw new Error('Capability receipt capabilities are required.');
    for (const key of Object.keys(ALL_PROVIDER_CAPABILITIES))
        if (typeof receipt.capabilities[key] !== 'boolean')
            throw new Error(`Capability receipt capability ${key} is invalid.`);
    for (const key of ['target_thread_id', 'target_session_id', 'main_session_id', 'workspace', 'host_instance_id', 'host_fingerprint', 'protocol_version', 'provider_version', 'endpoint_fingerprint', 'run_generation', 'contract_sha256', 'limitation_reason'])
        if (receipt[key] !== null && receipt[key] !== undefined && typeof receipt[key] !== 'string')
            throw new Error(`Capability receipt ${key} must be a string or null.`);
    if (receipt.task_version !== null && receipt.task_version !== undefined && (typeof receipt.task_version !== 'number' || !Number.isInteger(receipt.task_version) || receipt.task_version <= 0))
        throw new Error('Capability receipt task_version is invalid.');
    if (receipt.input_epoch !== null && receipt.input_epoch !== undefined && (typeof receipt.input_epoch !== 'number' || !Number.isInteger(receipt.input_epoch) || receipt.input_epoch < 0))
        throw new Error('Capability receipt input_epoch is invalid.');
    if (!nonEmpty(receipt.observed_at) || !Number.isFinite(Date.parse(receipt.observed_at)))
        throw new Error('Capability receipt observed_at must be an ISO timestamp.');
    return clone(receipt);
}
export function createProviderEvent(input) {
    return { schema_version: 1, event_id: input.event_id ?? randomUUID(), at: input.at ?? now(), input_epoch: input.input_epoch ?? null, delivery_id: input.delivery_id ?? null, turn_id: input.turn_id ?? null, ...input };
}
export function validateProviderEvent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Provider event must be an object.');
    const event = value;
    if (event.schema_version !== 1 || !nonEmpty(event.event_id) || !nonEmpty(event.at) || !Number.isFinite(Date.parse(event.at)))
        throw new Error('Provider event identity or timestamp is invalid.');
    if (!['capability_probe', 'thread_read', 'writer_state', 'resume', 'send_prepared', 'send_sent', 'delivery_reconciled', 'activity', 'disconnected', 'closed'].includes(String(event.type)))
        throw new Error('Unsupported provider event type.');
    if (!['shared-server', 'daemon', 'native-hook', 'ui-bridge', 'simulated', 'unavailable'].includes(String(event.provider_kind)))
        throw new Error('Invalid provider event kind.');
    if (!['live', 'simulated', 'unverified', 'unavailable'].includes(String(event.evidence_level)))
        throw new Error('Invalid provider event evidence level.');
    for (const key of ['target_thread_id', 'target_session_id', 'workspace', 'host_fingerprint', 'run_generation', 'delivery_id', 'turn_id'])
        if (event[key] !== null && event[key] !== undefined && typeof event[key] !== 'string')
            throw new Error(`Provider event ${key} must be a string or null.`);
    if (event.task_version !== null && event.task_version !== undefined && (typeof event.task_version !== 'number' || !Number.isInteger(event.task_version) || event.task_version <= 0))
        throw new Error('Provider event task_version is invalid.');
    if (event.input_epoch !== null && event.input_epoch !== undefined && (typeof event.input_epoch !== 'number' || !Number.isInteger(event.input_epoch) || event.input_epoch < 0))
        throw new Error('Provider event input_epoch is invalid.');
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
        throw new Error('Provider event payload is required.');
    return clone(event);
}
export function createProviderState(receipt) {
    const validated = validateCapabilityReceipt(receipt);
    return {
        schema_version: 1,
        provider_kind: validated.provider_kind,
        status: validated.available && validated.attached ? 'attached' : 'unavailable',
        evidence_level: validated.evidence_level,
        capabilities: clone(validated.capabilities),
        target_thread_id: validated.target_thread_id,
        target_session_id: validated.target_session_id,
        workspace: validated.workspace,
        host_fingerprint: validated.host_fingerprint,
        same_thread_verified: validated.same_thread_verified,
        writer: null,
        a_activity: null,
        last_delivery: null,
        continuation_confirmation: null,
        limitation_reason: validated.limitation_reason,
        next_action: validated.available ? null : 'Wait for a trusted provider receipt or native lifecycle receipt.',
        updated_at: validated.observed_at,
    };
}
export function validateProviderState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Provider state must be an object.');
    const state = value;
    if (state.schema_version !== 1 || !['shared-server', 'daemon', 'native-hook', 'ui-bridge', 'simulated', 'unavailable'].includes(String(state.provider_kind)))
        throw new Error('Provider state identity is invalid.');
    if (!['unavailable', 'probing', 'attached', 'disconnected', 'closed'].includes(String(state.status)))
        throw new Error('Provider state status is invalid.');
    if (!['live', 'simulated', 'unverified', 'unavailable'].includes(String(state.evidence_level)))
        throw new Error('Provider state evidence level is invalid.');
    if (!state.capabilities || typeof state.capabilities !== 'object' || Array.isArray(state.capabilities))
        throw new Error('Provider state capabilities are required.');
    for (const key of Object.keys(ALL_PROVIDER_CAPABILITIES))
        if (typeof state.capabilities[key] !== 'boolean')
            throw new Error(`Provider state capability ${key} is invalid.`);
    for (const key of ['target_thread_id', 'target_session_id', 'workspace', 'host_fingerprint', 'limitation_reason', 'next_action'])
        if (state[key] !== null && state[key] !== undefined && typeof state[key] !== 'string')
            throw new Error(`Provider state ${key} must be a string or null.`);
    if (typeof state.same_thread_verified !== 'boolean' || !nonEmpty(state.updated_at) || !Number.isFinite(Date.parse(state.updated_at)))
        throw new Error('Provider state verification or timestamp is invalid.');
    return clone(state);
}
function providerEventFrom(receipt, type, payload, deliveryId = null, turnId = null) {
    return createProviderEvent({ type, provider_kind: receipt.provider_kind, evidence_level: receipt.evidence_level, target_thread_id: receipt.target_thread_id, target_session_id: receipt.target_session_id, workspace: receipt.workspace, host_fingerprint: receipt.host_fingerprint, task_version: receipt.task_version, run_generation: receipt.run_generation, input_epoch: receipt.input_epoch ?? null, delivery_id: deliveryId, turn_id: turnId, payload });
}
function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function statusOf(value) {
    const text = typeof value === 'string' ? value.toLowerCase() : '';
    if (text === 'inprogress' || text === 'in-progress' || text === 'active' || text === 'running')
        return 'in-progress';
    if (text === 'idle' || text === 'notloaded' || text === 'not-loaded' || text === 'completed')
        return 'idle';
    if (text === 'unavailable' || text === 'closed')
        return 'unavailable';
    return 'unknown';
}
function writerOf(value) {
    const raw = asObject(value) ?? {};
    const status = typeof raw.status === 'string' ? raw.status : typeof raw.type === 'string' ? raw.type : '';
    const normalized = statusOf(status);
    const writerStatus = normalized === 'in-progress' ? 'in-progress' : status.toLowerCase().includes('writer') ? 'active-writer' : normalized === 'idle' ? 'idle' : normalized === 'unavailable' ? 'unavailable' : 'unknown';
    return { status: writerStatus, owner_session_id: typeof raw.owner_session_id === 'string' ? raw.owner_session_id : typeof raw.ownerSessionId === 'string' ? raw.ownerSessionId : null, turn_id: typeof raw.turn_id === 'string' ? raw.turn_id : typeof raw.turnId === 'string' ? raw.turnId : null, reason: typeof raw.reason === 'string' ? raw.reason : null, observed_at: now() };
}
function turnOf(value) {
    const raw = asObject(value) ?? {};
    const items = Array.isArray(raw.items) ? raw.items.map((item) => {
        const entry = asObject(item) ?? {};
        const type = typeof entry.type === 'string' && ['user_message', 'assistant_message', 'tool_activity', 'other'].includes(entry.type) ? entry.type : 'other';
        return { type, client_message_id: typeof entry.client_message_id === 'string' ? entry.client_message_id : typeof entry.clientMessageId === 'string' ? entry.clientMessageId : null, delivery_id: typeof entry.delivery_id === 'string' ? entry.delivery_id : typeof entry.deliveryId === 'string' ? entry.deliveryId : null, value: entry.value };
    }) : [];
    const turnId = typeof raw.turn_id === 'string' ? raw.turn_id : typeof raw.id === 'string' ? raw.id : '';
    if (!turnId)
        throw new ProviderIdentityError('Desktop provider returned a turn without an identity.');
    const status = typeof raw.status === 'string' && raw.status.toLowerCase().includes('progress') ? 'in-progress' : raw.status === 'completed' || raw.status === 'complete' ? 'completed' : 'unknown';
    return { turn_id: turnId, status, items, started_at: typeof raw.started_at === 'string' ? raw.started_at : null, completed_at: typeof raw.completed_at === 'string' ? raw.completed_at : null };
}
function identityFrom(value) {
    const raw = asObject(value);
    if (!raw)
        return null;
    const nested = asObject(raw.identity) ?? raw;
    const result = {};
    const thread = typeof nested.target_thread_id === 'string' ? nested.target_thread_id : typeof nested.thread_id === 'string' ? nested.thread_id : typeof nested.threadId === 'string' ? nested.threadId : null;
    const session = typeof nested.target_session_id === 'string' ? nested.target_session_id : typeof nested.session_id === 'string' ? nested.session_id : typeof nested.sessionId === 'string' ? nested.sessionId : null;
    const workspace = typeof nested.workspace === 'string' ? nested.workspace : typeof nested.cwd === 'string' ? nested.cwd : null;
    if (thread)
        result.target_thread_id = thread;
    if (session)
        result.target_session_id = session;
    if (typeof nested.main_session_id === 'string')
        result.main_session_id = nested.main_session_id;
    if (workspace)
        result.workspace = workspace;
    if (typeof nested.host_instance_id === 'string')
        result.host_instance_id = nested.host_instance_id;
    if (typeof nested.host_fingerprint === 'string')
        result.host_fingerprint = nested.host_fingerprint;
    if (typeof nested.task_version === 'number')
        result.task_version = nested.task_version;
    if (typeof nested.run_generation === 'string')
        result.run_generation = nested.run_generation;
    if (typeof nested.input_epoch === 'number')
        result.input_epoch = nested.input_epoch;
    if (typeof nested.contract_sha256 === 'string')
        result.contract_sha256 = nested.contract_sha256;
    return result;
}
function fenceFor(identity) {
    return { target_thread_id: identity.target_thread_id, main_session_id: identity.main_session_id ?? identity.target_thread_id, target_session_id: identity.target_session_id, workspace: identity.workspace, host_instance_id: identity.host_instance_id, host_fingerprint: identity.host_fingerprint, task_version: identity.task_version, run_generation: identity.run_generation, input_epoch: identity.input_epoch ?? null, contract_sha256: identity.contract_sha256 ?? null };
}
function activeWriterError(error) {
    return /active writer|writer.*active|in.?progress|already.*writing|已有.*写入|进行中/i.test(error instanceof Error ? error.message : String(error));
}
export class ProviderSemanticsCore {
    _identity;
    _receipt;
    _state;
    ledger = new Map();
    listeners = new Set();
    closed = false;
    disconnected = false;
    constructor(options = {}) {
        this._identity = completeIdentity(options.identity)
            ? { ...options.identity, main_session_id: options.identity.main_session_id ?? options.identity.target_thread_id }
            : null;
        if (options.receipt)
            this._receipt = validateCapabilityReceipt(options.receipt);
        else if (this._identity) {
            const kind = options.provider_kind ?? 'unavailable';
            const evidence = options.evidence_level ?? (kind === 'simulated' ? 'simulated' : kind === 'unavailable' ? 'unavailable' : 'unverified');
            this._receipt = createCapabilityReceipt({
                provider_kind: kind,
                evidence_level: evidence,
                available: false,
                attached: false,
                same_thread_verified: false,
                capabilities: { ...ALL_PROVIDER_CAPABILITIES, ...(options.capabilities ?? {}) },
                target_thread_id: this._identity.target_thread_id,
                target_session_id: this._identity.target_session_id,
                main_session_id: this._identity.main_session_id ?? this._identity.target_thread_id,
                workspace: this._identity.workspace,
                host_instance_id: this._identity.host_instance_id,
                host_fingerprint: this._identity.host_fingerprint,
                protocol_version: options.protocol_version ?? null,
                provider_version: options.provider_version ?? null,
                endpoint_fingerprint: options.endpoint_fingerprint ?? null,
                task_version: this._identity.task_version,
                run_generation: this._identity.run_generation,
                input_epoch: this._identity.input_epoch ?? null,
                contract_sha256: this._identity.contract_sha256 ?? null,
                limitation_reason: 'Provider capability receipt has not been accepted.',
            });
        }
        else
            this._receipt = unavailableReceipt(options.identity, 'Trusted provider identity is unavailable.');
        this._state = createProviderState(this._receipt);
        for (const delivery of options.deliveries ?? [])
            this.seedDelivery(delivery);
    }
    get identity() { return this._identity ? clone(this._identity) : null; }
    get receipt() { return clone(this._receipt); }
    get state() { return clone(this._state); }
    get isClosed() { return this.closed; }
    get isDisconnected() { return this.disconnected; }
    /** Return the complete transport fence for a request. */
    fence(target) {
        this.assertTarget(target);
        return fenceFor(target);
    }
    /** Validate the full original-thread identity and all generation fences. */
    assertTarget(candidate) {
        if (!completeIdentity(candidate))
            throw new ProviderIdentityError('Trusted provider identity is unavailable; target thread/session, absolute workspace, host fingerprint, task version and run generation are required.');
        const target = { ...candidate, main_session_id: candidate.main_session_id ?? candidate.target_thread_id };
        if (!this._identity || !identityMatches(this._identity, target))
            throw new ProviderIdentityError('Provider target identity does not match the registered original thread, workspace, host or generation fence.');
        return clone(target);
    }
    /** Accept a new capability receipt while retaining the durable ledger. */
    acceptReceipt(receipt) {
        const validated = validateCapabilityReceipt(receipt);
        const next = { ...validated, input_epoch: validated.input_epoch ?? this._identity?.input_epoch ?? null };
        if (this._identity && next.target_thread_id && next.target_session_id && next.workspace && next.host_instance_id && next.host_fingerprint && next.task_version && next.run_generation) {
            this.assertTarget({
                target_thread_id: next.target_thread_id,
                target_session_id: next.target_session_id,
                main_session_id: next.main_session_id ?? next.target_thread_id,
                workspace: next.workspace,
                host_instance_id: next.host_instance_id,
                host_fingerprint: next.host_fingerprint,
                task_version: next.task_version,
                run_generation: next.run_generation,
                ...(next.input_epoch === null || next.input_epoch === undefined ? {} : { input_epoch: next.input_epoch }),
                contract_sha256: next.contract_sha256,
            });
        }
        this._receipt = next;
        this._state = {
            ...this._state,
            provider_kind: next.provider_kind,
            evidence_level: next.evidence_level,
            capabilities: clone(next.capabilities),
            target_thread_id: next.target_thread_id,
            target_session_id: next.target_session_id,
            workspace: next.workspace,
            host_fingerprint: next.host_fingerprint,
            same_thread_verified: next.same_thread_verified,
            status: next.available && next.attached ? 'attached' : this.closed ? 'closed' : this.disconnected ? 'disconnected' : 'unavailable',
            limitation_reason: next.limitation_reason,
            next_action: next.available ? null : 'Wait for a trusted provider receipt or native lifecycle receipt.',
            updated_at: next.observed_at,
        };
        this.disconnected = false;
        return this.receipt;
    }
    requireAvailable(target) {
        this.assertTarget(target);
        if (this.closed)
            throw new Error('Provider is closed.');
        if (this.disconnected || !this._receipt.available || !this._receipt.same_thread_verified)
            throw new ProviderIdentityError(this._receipt.limitation_reason ?? 'Provider is unavailable or same-thread identity is unverified.');
    }
    classifyWriter(value) {
        return writerOf(value);
    }
    seedDelivery(delivery) {
        if (!nonEmpty(delivery.delivery_id))
            throw new Error('Delivery identity is required.');
        const entry = {
            ...clone(delivery),
            task_version: this._receipt.task_version ?? this._identity?.task_version ?? 0,
            run_generation: this._receipt.run_generation ?? this._identity?.run_generation ?? '',
            input_epoch: this._receipt.input_epoch ?? this._identity?.input_epoch ?? null,
            contract_sha256: this._receipt.contract_sha256 ?? this._identity?.contract_sha256 ?? null,
        };
        this.ledger.set(entry.delivery_id, entry);
        return clone(entry);
    }
    ledgerEntry(deliveryId) {
        const entry = this.ledger.get(deliveryId);
        return entry ? clone(entry) : null;
    }
    ledgerSnapshot() { return [...this.ledger.values()].map(clone); }
    prepareDelivery(target, delivery) {
        this.requireAvailable(target);
        const existing = this.ledger.get(delivery.delivery_id);
        if (existing)
            return clone(existing);
        const entry = this.seedDelivery({ delivery_id: delivery.delivery_id, message: delivery.message, status: 'prepared', target_turn_id: null, client_message_id: delivery.delivery_id, observed_at: now() });
        this.emit('send_prepared', { message_length: delivery.message.length }, delivery.delivery_id);
        return entry;
    }
    recordSend(target, request, result) {
        this.requireAvailable(target);
        const status = result.outcome;
        const entry = this.seedDelivery({ delivery_id: request.delivery_id, message: request.message, status, target_turn_id: result.target_turn_id, client_message_id: request.delivery_id, observed_at: result.observed_at });
        this.emit('send_sent', { outcome: status, reason: result.reason }, request.delivery_id, result.target_turn_id);
        return entry;
    }
    reconcileHistory(target, input) {
        this.requireAvailable(target);
        const at = now();
        const local = this.ledger.get(input.delivery_id);
        if (!input.history.readable) {
            const result = { delivery_id: input.delivery_id, outcome: 'unknown', matched_by: 'none', target_turn_id: null, reason: input.history.limitation_reason ?? 'Original thread history is unreadable.', observed_at: at };
            this.recordReconciliation(result);
            return result;
        }
        const client = input.client_message_id ?? input.delivery_id;
        const byDelivery = input.history.turns.find(turn => turn.items.some(item => item.delivery_id === input.delivery_id));
        const byClient = input.history.turns.find(turn => turn.items.some(item => item.client_message_id === client));
        const byTurn = input.target_turn_id ? input.history.turns.find(turn => turn.turn_id === input.target_turn_id) : undefined;
        const match = byDelivery ?? byClient ?? byTurn;
        const matchedBy = byDelivery ? 'delivery_id' : byClient ? 'client_message_id' : byTurn ? 'target_turn_id' : 'none';
        const observedActivity = this._state.continuation_confirmation?.delivery_id === input.delivery_id;
        let result;
        if (match) {
            result = { delivery_id: input.delivery_id, outcome: observedActivity ? 'confirmed' : 'sent', matched_by: observedActivity ? 'activity' : matchedBy, target_turn_id: match.turn_id, reason: observedActivity ? null : 'A matching user message exists, but A activity is not confirmed.', observed_at: at };
        }
        else if (local?.status === 'unknown') {
            result = { delivery_id: input.delivery_id, outcome: 'unknown', matched_by: 'none', target_turn_id: null, reason: 'Send outcome is unknown; no history proof permits a resend.', observed_at: at };
        }
        else {
            result = { delivery_id: input.delivery_id, outcome: 'not_found', matched_by: 'none', target_turn_id: null, reason: 'No matching delivery, client message or target turn exists in the original thread history.', observed_at: at };
        }
        this.recordReconciliation(result);
        return result;
    }
    recordReconciliation(result) {
        const activity = this._state.continuation_confirmation;
        if (result.outcome === 'sent' && activity?.delivery_id === result.delivery_id) {
            result = { ...result, outcome: 'confirmed', matched_by: 'activity', target_turn_id: result.target_turn_id ?? activity.turn_id, reason: null };
        }
        const local = this.ledger.get(result.delivery_id);
        if (local) {
            const status = result.outcome === 'confirmed' ? 'confirmed' : result.outcome === 'sent' ? 'sent' : result.outcome === 'active_writer' ? 'active-writer' : result.outcome === 'unavailable' || result.outcome === 'unknown' ? result.outcome : local.status;
            this.ledger.set(result.delivery_id, { ...local, status, target_turn_id: result.target_turn_id ?? local.target_turn_id, observed_at: result.observed_at });
        }
        this._state = { ...this._state, last_delivery: clone(result), updated_at: result.observed_at };
        this.emit('delivery_reconciled', { outcome: result.outcome, matched_by: result.matched_by, reason: result.reason }, result.delivery_id, result.target_turn_id);
        return clone(result);
    }
    recordActivity(input) {
        if (this.closed || !this._identity || input.target_thread_id !== this._identity.target_thread_id || input.target_session_id !== this._identity.target_session_id)
            return null;
        const activity = { event_id: randomUUID(), type: 'activity', target_thread_id: input.target_thread_id, target_session_id: input.target_session_id, turn_id: input.turn_id ?? null, delivery_id: input.delivery_id ?? null, observed_at: input.observed_at ?? now(), details: clone(input.details ?? {}) };
        this._state = { ...this._state, a_activity: activity, continuation_confirmation: input.delivery_id && this.ledger.has(input.delivery_id) ? activity : this._state.continuation_confirmation, updated_at: activity.observed_at };
        if (input.delivery_id) {
            const local = this.ledger.get(input.delivery_id);
            if (local)
                this.ledger.set(input.delivery_id, { ...local, status: 'confirmed', target_turn_id: input.turn_id ?? local.target_turn_id, observed_at: activity.observed_at });
        }
        this.emit('activity', activity.details, activity.delivery_id, activity.turn_id);
        return clone(activity);
    }
    subscribe(listener) {
        if (this.closed)
            throw new Error('Provider is closed.');
        this.listeners.add(listener);
        return { unsubscribe: () => { this.listeners.delete(listener); } };
    }
    emit(type, payload, deliveryId = null, turnId = null) {
        const event = providerEventFrom(this._receipt, type, payload, deliveryId, turnId);
        for (const listener of [...this.listeners]) {
            try {
                listener(clone(event));
            }
            catch { /* observers cannot break provider state */ }
        }
        return event;
    }
    disconnect(reason = 'Provider disconnected.') {
        if (this.closed || this.disconnected)
            return;
        this.disconnected = true;
        this._receipt = { ...this._receipt, attached: false, available: false, limitation_reason: reason, observed_at: now() };
        this._state = { ...this._state, status: 'disconnected', limitation_reason: reason, next_action: 'Probe a fresh trusted provider receipt before delivery.', updated_at: this._receipt.observed_at };
        this.emit('disconnected', { reason });
        this.listeners.clear();
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this._receipt = { ...this._receipt, attached: false, observed_at: now() };
        this._state = { ...this._state, status: 'closed', updated_at: this._receipt.observed_at };
        this.emit('closed', {});
        this.listeners.clear();
    }
}
/** Adapter for an already-owned Desktop/shared app-server connection. It never
 * starts a process or creates a thread; all identity and generation fields are
 * sent on every operation and mismatches fail closed. */
export class DesktopMainSessionProvider {
    kind;
    semantics;
    identity;
    transport;
    methods;
    listeners = new Set();
    deliveries = new Map();
    _receipt;
    closed = false;
    constructor(options = {}) {
        this.transport = options.transport ?? null;
        this.identity = completeIdentity(options.identity) ? { ...options.identity, main_session_id: options.identity.main_session_id ?? options.identity.target_thread_id } : null;
        this.methods = { ...DEFAULT_DESKTOP_PROVIDER_RPC_METHODS, ...options.methods };
        this.kind = options.provider_kind ?? this.transport?.metadata?.provider_kind ?? (this.transport ? 'shared-server' : 'unavailable');
        const meta = this.transport?.metadata ?? {};
        this._receipt = this.identity && this.transport ? createCapabilityReceipt({ provider_kind: this.kind, evidence_level: options.transport?.metadata?.evidence_level ?? 'live', available: false, attached: false, same_thread_verified: false, capabilities: { ...ALL_PROVIDER_CAPABILITIES, ...(meta.capabilities ?? {}) }, target_thread_id: this.identity.target_thread_id, target_session_id: this.identity.target_session_id, main_session_id: this.identity.main_session_id ?? this.identity.target_thread_id, workspace: this.identity.workspace, host_instance_id: this.identity.host_instance_id, host_fingerprint: this.identity.host_fingerprint, task_version: this.identity.task_version, run_generation: this.identity.run_generation, contract_sha256: this.identity.contract_sha256 ?? null, protocol_version: options.protocol_version ?? meta.protocol_version ?? null, provider_version: options.provider_version ?? meta.provider_version ?? null, endpoint_fingerprint: options.endpoint_fingerprint ?? meta.endpoint_fingerprint ?? null }) : unavailableReceipt(options.identity, 'Desktop shared transport or trusted original-thread identity is unavailable.');
        this.semantics = new ProviderSemanticsCore({ identity: this.identity, receipt: this._receipt });
    }
    get receipt() { return this.semantics.receipt; }
    ensureOpen() { if (this.closed || this.semantics.isClosed)
        throw new Error('Provider is closed.'); }
    target(request) {
        return this.semantics.assertTarget(request.target);
    }
    event(type, payload, deliveryId = null, turnId = null) {
        const event = this.semantics.emit(type, payload, deliveryId, turnId);
        for (const listener of [...this.listeners]) {
            try {
                listener(clone(event));
            }
            catch { /* observers cannot break provider state */ }
        }
    }
    async call(method, identity, params = {}) {
        if (!this.transport)
            throw new ProviderIdentityError('Desktop shared transport is unavailable.');
        return this.transport.request(method, { ...fenceFor(identity), ...params });
    }
    verifyReturnedIdentity(value, identity) {
        const observed = identityFrom(value);
        if (observed && !identityMatches(identity, { ...identity, ...observed, target_thread_id: observed.target_thread_id ?? identity.target_thread_id, target_session_id: observed.target_session_id ?? identity.target_session_id, workspace: observed.workspace ?? identity.workspace, host_instance_id: observed.host_instance_id ?? identity.host_instance_id, host_fingerprint: observed.host_fingerprint ?? identity.host_fingerprint, task_version: observed.task_version ?? identity.task_version, run_generation: observed.run_generation ?? identity.run_generation }))
            throw new ProviderIdentityError('Desktop provider returned a different thread, session, workspace, host or generation.');
    }
    async probe(request = {}) {
        this.ensureOpen();
        if (!this.transport || !completeIdentity(request.target) || !this.identity) {
            this._receipt = unavailableReceipt(request.target, 'Desktop shared transport or trusted original-thread identity is unavailable.');
            this.semantics.acceptReceipt(this._receipt);
            return this.receipt;
        }
        const identity = this.target(request);
        try {
            const response = await this.call(this.methods.probe, identity, { identity: fenceFor(identity) });
            this.verifyReturnedIdentity(response, identity);
            const raw = asObject(response) ?? {};
            const caps = asObject(raw.capabilities) ?? this.transport.metadata?.capabilities ?? ALL_PROVIDER_CAPABILITIES;
            const observedIdentity = { ...(identityFrom(this.transport.metadata) ?? {}), ...(identityFrom(response) ?? {}) };
            const requiredIdentityFields = ['target_thread_id', 'target_session_id', 'workspace', 'host_instance_id', 'host_fingerprint', 'task_version', 'run_generation'];
            const identityVerified = requiredIdentityFields.every((key) => observedIdentity[key] !== undefined)
                && identityMatches(identity, { ...identity, ...observedIdentity });
            const protocolVersion = typeof raw.protocol_version === 'string' ? raw.protocol_version : this.transport.metadata?.protocol_version ?? null;
            const providerVersion = typeof raw.provider_version === 'string' ? raw.provider_version : this.transport.metadata?.provider_version ?? null;
            const endpointFingerprint = typeof raw.endpoint_fingerprint === 'string' ? raw.endpoint_fingerprint : this.transport.metadata?.endpoint_fingerprint ?? null;
            const metadataComplete = nonEmpty(protocolVersion) && nonEmpty(providerVersion) && nonEmpty(endpointFingerprint);
            if (!identityVerified)
                throw new ProviderIdentityError('Desktop transport did not return verifiable original-thread identity.');
            const available = raw.available !== false && raw.same_thread_verified !== false && identityVerified && metadataComplete;
            const limitation = available ? null : String(raw.limitation_reason ?? (metadataComplete ? 'Desktop provider did not verify same-thread identity.' : 'Desktop provider handshake did not prove protocol, provider and endpoint identity.'));
            this._receipt = createCapabilityReceipt({ ...this._receipt, provider_kind: this.kind, evidence_level: this.transport.metadata?.evidence_level ?? 'live', available, attached: available, same_thread_verified: available, capabilities: { ...ALL_PROVIDER_CAPABILITIES, ...caps }, protocol_version: protocolVersion, provider_version: providerVersion, endpoint_fingerprint: endpointFingerprint, limitation_reason: limitation });
            this.semantics.acceptReceipt(this._receipt);
            this.event('capability_probe', { available: this._receipt.available, same_thread_verified: this._receipt.same_thread_verified });
        }
        catch (error) {
            this._receipt = unavailableReceipt(identity, error instanceof Error ? error.message : 'Desktop provider capability probe failed.');
            this.semantics.acceptReceipt(this._receipt);
            this.event('capability_probe', { available: false, limitation_reason: this._receipt.limitation_reason });
        }
        return this.receipt;
    }
    available(identity) { this.semantics.requireAvailable(identity); }
    snapshot(value, identity) {
        this.verifyReturnedIdentity(value, identity);
        const raw = asObject(value) ?? {};
        const thread = asObject(raw.thread) ?? raw;
        const threadId = typeof thread.thread_id === 'string' ? thread.thread_id : typeof thread.id === 'string' ? thread.id : identity.target_thread_id;
        const sessionId = typeof thread.session_id === 'string' ? thread.session_id : identity.target_session_id;
        if (threadId !== identity.target_thread_id || sessionId !== identity.target_session_id)
            throw new ProviderIdentityError('Desktop provider returned a different thread or session.');
        const turns = Array.isArray(thread.turns) ? thread.turns.map(turnOf) : [];
        const writer = writerOf(thread.writer ?? raw.writer ?? thread.status);
        const threadStatus = asObject(thread.status)?.type ?? thread.status;
        return { thread_id: threadId, session_id: sessionId, workspace: typeof thread.workspace === 'string' ? thread.workspace : identity.workspace, status: statusOf(threadStatus), writer, turns, latest_activity_at: typeof thread.latest_activity_at === 'string' ? thread.latest_activity_at : turns.at(-1)?.completed_at ?? turns.at(-1)?.started_at ?? null, observed_at: now() };
    }
    async readThread(request) {
        this.ensureOpen();
        const identity = this.target(request);
        this.available(identity);
        const result = this.snapshot(await this.call(this.methods.read_thread, identity, { threadId: identity.target_thread_id, includeTurns: true }), identity);
        this.event('thread_read', { status: result.status, writer: result.writer.status, turn_count: result.turns.length });
        return result;
    }
    async readWriter(request) {
        this.ensureOpen();
        const identity = this.target(request);
        this.available(identity);
        try {
            const result = writerOf(await this.call(this.methods.read_writer, identity, { threadId: identity.target_thread_id }));
            this.event('writer_state', { status: result.status, reason: result.reason }, null, result.turn_id);
            return result;
        }
        catch {
            const snapshot = await this.readThread(request);
            this.event('writer_state', { status: snapshot.writer.status, reason: snapshot.writer.reason }, null, snapshot.writer.turn_id);
            return snapshot.writer;
        }
    }
    async resume(request) {
        this.ensureOpen();
        const identity = this.target(request);
        this.available(identity);
        try {
            const result = this.snapshot(await this.call(this.methods.resume, identity, { threadId: identity.target_thread_id }), identity);
            const status = result.writer.status === 'in-progress' || result.writer.status === 'active-writer' ? 'active_writer' : 'attached';
            this.event('resume', { status, created_worker: false }, null, result.writer.turn_id);
            return { ...result, status, created_worker: false };
        }
        catch (error) {
            if (activeWriterError(error)) {
                const writer = await this.readWriter(request).catch(() => ({ status: 'active-writer', owner_session_id: identity.target_session_id, turn_id: null, reason: String(error), observed_at: now() }));
                const snapshot = { thread_id: identity.target_thread_id, session_id: identity.target_session_id, workspace: identity.workspace, status: 'in-progress', writer: { ...writer, status: 'active-writer' }, turns: [], latest_activity_at: null, observed_at: now() };
                this.event('resume', { status: 'active_writer', created_worker: false }, null, snapshot.writer.turn_id);
                return { ...snapshot, status: 'active_writer', created_worker: false };
            }
            throw error;
        }
    }
    async send(request) {
        this.ensureOpen();
        const identity = this.target(request);
        this.available(identity);
        const existing = this.deliveries.get(request.delivery_id);
        if (existing)
            return { delivery_id: request.delivery_id, outcome: existing.status === 'confirmed' ? 'confirmed' : 'already-present', target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: existing.target_turn_id, created_worker: false, reason: 'Delivery is already recorded; provider will not send a duplicate.', observed_at: now() };
        const remote = await this.reconcileDelivery({ target: identity, delivery_id: request.delivery_id, message: request.message, client_message_id: request.delivery_id, target_turn_id: null });
        if (remote.outcome !== 'not_found') {
            const mapped = remote.outcome === 'confirmed' ? 'confirmed' : remote.outcome === 'active_writer' ? 'active-writer' : remote.outcome === 'unavailable' ? 'unavailable' : remote.outcome === 'sent' ? 'already-present' : 'unknown';
            this.deliveries.set(request.delivery_id, { delivery_id: request.delivery_id, message: request.message, status: mapped, target_turn_id: remote.target_turn_id, client_message_id: request.delivery_id, observed_at: now() });
            return { delivery_id: request.delivery_id, outcome: mapped, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: remote.target_turn_id, created_worker: false, reason: remote.reason ?? 'Remote history did not prove that this delivery is absent; send is fenced.', observed_at: now() };
        }
        this.deliveries.set(request.delivery_id, { delivery_id: request.delivery_id, message: request.message, status: 'prepared', target_turn_id: null, client_message_id: request.delivery_id, observed_at: now() });
        this.semantics.seedDelivery(this.deliveries.get(request.delivery_id));
        this.event('send_prepared', { message_length: request.message.length }, request.delivery_id);
        try {
            const raw = asObject(await this.call(this.methods.send, identity, { threadId: identity.target_thread_id, delivery_id: request.delivery_id, client_message_id: request.delivery_id, message: request.message })) ?? {};
            this.verifyReturnedIdentity(raw, identity);
            const outcome = ['sent', 'confirmed', 'already-present', 'unknown', 'active-writer', 'unavailable'].includes(String(raw.outcome)) ? String(raw.outcome) : 'unknown';
            const turnId = typeof raw.target_turn_id === 'string' ? raw.target_turn_id : typeof raw.turn_id === 'string' ? raw.turn_id : null;
            this.deliveries.set(request.delivery_id, { delivery_id: request.delivery_id, message: request.message, status: outcome, target_turn_id: turnId, client_message_id: request.delivery_id, observed_at: now() });
            this.semantics.seedDelivery(this.deliveries.get(request.delivery_id));
            this.event('send_sent', { outcome }, request.delivery_id, turnId);
            return { delivery_id: request.delivery_id, outcome, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: turnId, created_worker: false, reason: typeof raw.reason === 'string' ? raw.reason : outcome === 'unknown' ? 'Send outcome is unknown; reconcile original-thread history before retrying.' : null, observed_at: now() };
        }
        catch (error) {
            if (error instanceof ProviderIdentityError)
                throw error;
            const reason = error instanceof Error ? error.message : String(error);
            const outcome = activeWriterError(error) ? 'active-writer' : 'unknown';
            this.deliveries.set(request.delivery_id, { delivery_id: request.delivery_id, message: request.message, status: outcome, target_turn_id: null, client_message_id: request.delivery_id, observed_at: now() });
            this.semantics.seedDelivery(this.deliveries.get(request.delivery_id));
            this.event('send_sent', { outcome, reason }, request.delivery_id);
            return { delivery_id: request.delivery_id, outcome, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: null, created_worker: false, reason, observed_at: now() };
        }
    }
    async subscribe(request, listener) {
        this.ensureOpen();
        const identity = this.target(request);
        this.available(identity);
        this.listeners.add(listener);
        const upstream = this.transport?.subscribe ? await this.transport.subscribe((raw) => {
            const observed = identityFrom(raw);
            if (observed && !identityMatches(identity, { ...identity, ...observed, target_thread_id: observed.target_thread_id ?? identity.target_thread_id, target_session_id: observed.target_session_id ?? identity.target_session_id, workspace: observed.workspace ?? identity.workspace, host_instance_id: observed.host_instance_id ?? identity.host_instance_id, host_fingerprint: observed.host_fingerprint ?? identity.host_fingerprint, task_version: observed.task_version ?? identity.task_version, run_generation: observed.run_generation ?? identity.run_generation }))
                return;
            const event = asObject(raw);
            if (event && typeof event.type === 'string') {
                const deliveryId = typeof event.delivery_id === 'string' ? event.delivery_id : null;
                const turnId = typeof event.turn_id === 'string' ? event.turn_id : null;
                if (event.type === 'activity')
                    this.semantics.recordActivity({ target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, delivery_id: deliveryId, turn_id: turnId, details: event.payload && typeof event.payload === 'object' ? event.payload : {} });
                listener(createProviderEvent({ type: event.type, provider_kind: this._receipt.provider_kind, evidence_level: this._receipt.evidence_level, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, workspace: identity.workspace, host_fingerprint: identity.host_fingerprint, task_version: identity.task_version, run_generation: identity.run_generation, delivery_id: deliveryId, turn_id: turnId, payload: event.payload && typeof event.payload === 'object' ? event.payload : {} }));
            }
        }) : null;
        return { unsubscribe: () => { this.listeners.delete(listener); upstream?.unsubscribe(); } };
    }
    async readHistory(request) {
        this.ensureOpen();
        const identity = this.target(request);
        this.available(identity);
        try {
            const raw = asObject(await this.call(this.methods.read_history, identity, { threadId: identity.target_thread_id, cursor: request.cursor ?? null })) ?? {};
            this.verifyReturnedIdentity(raw, identity);
            const turns = Array.isArray(raw.turns) ? raw.turns.map(turnOf) : [];
            return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns, has_more: raw.has_more === true, cursor: typeof raw.cursor === 'string' ? raw.cursor : null, readable: raw.readable !== false, limitation_reason: typeof raw.limitation_reason === 'string' ? raw.limitation_reason : null, observed_at: now() };
        }
        catch (error) {
            if (error instanceof ProviderIdentityError)
                throw error;
            return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns: [], has_more: false, cursor: null, readable: false, limitation_reason: error instanceof Error ? error.message : String(error), observed_at: now() };
        }
    }
    async reconcileDelivery(request) {
        this.ensureOpen();
        const identity = this.target(request);
        this.available(identity);
        const at = now();
        const local = this.deliveries.get(request.delivery_id);
        const activity = this.semantics.state.continuation_confirmation;
        if (activity?.delivery_id === request.delivery_id)
            return { delivery_id: request.delivery_id, outcome: 'confirmed', matched_by: 'activity', target_turn_id: activity.turn_id, reason: null, observed_at: at };
        if (local?.status === 'confirmed')
            return { delivery_id: request.delivery_id, outcome: 'confirmed', matched_by: 'delivery_id', target_turn_id: local.target_turn_id, reason: null, observed_at: at };
        if (local?.status === 'unknown') {
            // Unknown is a hard no-resend fence. Reconciliation may still ask the host.
        }
        try {
            const raw = asObject(await this.call(this.methods.reconcile_delivery, identity, { threadId: identity.target_thread_id, delivery_id: request.delivery_id, client_message_id: request.client_message_id ?? request.delivery_id, target_turn_id: request.target_turn_id ?? null, message: request.message ?? null })) ?? {};
            this.verifyReturnedIdentity(raw, identity);
            const outcome = ['confirmed', 'sent', 'unknown', 'not_found', 'active_writer', 'unavailable'].includes(String(raw.outcome)) ? String(raw.outcome) : 'unknown';
            const matched = ['delivery_id', 'client_message_id', 'target_turn_id', 'activity', 'none'].includes(String(raw.matched_by)) ? String(raw.matched_by) : 'none';
            const targetTurn = typeof raw.target_turn_id === 'string' ? raw.target_turn_id : null;
            if (local)
                this.deliveries.set(request.delivery_id, { ...local, status: outcome === 'confirmed' ? 'confirmed' : outcome === 'sent' ? 'sent' : outcome === 'active_writer' ? 'active-writer' : outcome === 'unavailable' ? 'unavailable' : outcome === 'unknown' ? 'unknown' : local.status, target_turn_id: targetTurn, observed_at: at });
            const result = { delivery_id: request.delivery_id, outcome, matched_by: matched, target_turn_id: targetTurn, reason: typeof raw.reason === 'string' ? raw.reason : null, observed_at: at };
            this.event('delivery_reconciled', { outcome, matched_by: matched, reason: result.reason }, request.delivery_id, targetTurn);
            return result;
        }
        catch (error) {
            if (error instanceof ProviderIdentityError)
                throw error;
            const result = { delivery_id: request.delivery_id, outcome: 'unknown', matched_by: 'none', target_turn_id: null, reason: error instanceof Error ? error.message : String(error), observed_at: at };
            this.event('delivery_reconciled', { outcome: result.outcome, reason: result.reason }, request.delivery_id);
            return result;
        }
    }
    async close() { if (this.closed)
        return; this.closed = true; this.listeners.clear(); this._receipt = { ...this._receipt, attached: false }; this.event('closed', {}); await this.transport?.close?.(); }
}
export class SimulatedMainSessionProvider {
    kind = 'simulated';
    semantics;
    identity;
    scenario;
    writer;
    threadStatus;
    turns;
    deliveries = new Map();
    listeners = new Set();
    sendOutcomes;
    closed = false;
    _receipt;
    constructor(scenario = {}) {
        this.scenario = scenario;
        this.identity = completeIdentity(scenario.identity) ? { ...scenario.identity, main_session_id: scenario.identity.main_session_id ?? scenario.identity.target_thread_id } : null;
        this.writer = clone(scenario.writer_state ?? { status: 'idle', owner_session_id: null, turn_id: null, reason: null, observed_at: now() });
        this.threadStatus = scenario.thread_status ?? (this.writer.status === 'in-progress' || this.writer.status === 'active-writer' ? 'in-progress' : 'idle');
        this.turns = clone(scenario.turns ?? []);
        for (const delivery of scenario.deliveries ?? [])
            this.deliveries.set(delivery.delivery_id, clone(delivery));
        this.sendOutcomes = [...(scenario.send_outcomes ?? [])];
        this._receipt = this.identity
            ? createCapabilityReceipt({ provider_kind: 'simulated', evidence_level: 'simulated', available: true, attached: true, same_thread_verified: true, capabilities: ALL_PROVIDER_CAPABILITIES, target_thread_id: this.identity.target_thread_id, target_session_id: this.identity.target_session_id, main_session_id: this.identity.main_session_id ?? this.identity.target_thread_id, workspace: this.identity.workspace, host_instance_id: this.identity.host_instance_id, host_fingerprint: this.identity.host_fingerprint, task_version: this.identity.task_version, run_generation: this.identity.run_generation, contract_sha256: this.identity.contract_sha256 ?? null, protocol_version: scenario.protocol_version ?? 'simulated-provider/1', provider_version: scenario.provider_version ?? 'simulated', endpoint_fingerprint: scenario.endpoint_fingerprint ?? 'simulated-endpoint' })
            : unavailableReceipt(scenario.identity, 'Trusted provider identity is unavailable; target thread/session and host fingerprint are required.');
        this.semantics = new ProviderSemanticsCore({ identity: this.identity, receipt: this._receipt, ...(scenario.deliveries ? { deliveries: scenario.deliveries } : {}) });
    }
    get receipt() { return this.semantics.receipt; }
    ensureOpen() { if (this.closed || this.semantics.isClosed)
        throw new Error('Provider is closed.'); }
    target(request) {
        return this.semantics.assertTarget(request.target);
    }
    event(type, payload, deliveryId = null, turnId = null) {
        const event = this.semantics.emit(type, payload, deliveryId, turnId);
        for (const listener of [...this.listeners]) {
            try {
                listener(clone(event));
            }
            catch { /* observers cannot break provider state */ }
        }
        return event;
    }
    snapshot(identity) {
        return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, workspace: identity.workspace, status: this.threadStatus, writer: clone(this.writer), turns: clone(this.turns), latest_activity_at: this.turns.at(-1)?.completed_at ?? this.turns.at(-1)?.started_at ?? null, observed_at: now() };
    }
    async probe(request = {}) {
        this.ensureOpen();
        if (!completeIdentity(request.target) || !this.identity) {
            this._receipt = unavailableReceipt(request.target, 'Trusted provider identity is unavailable; target thread/session, absolute workspace, host fingerprint, task version and run generation are required.');
        }
        else if (!identityMatches(this.identity, { ...request.target, main_session_id: request.target.main_session_id ?? request.target.target_thread_id })) {
            this._receipt = unavailableReceipt(request.target, 'Provider target identity does not match the registered original thread, workspace, host or generation.');
        }
        else {
            this._receipt = createCapabilityReceipt({ ...this._receipt, provider_kind: 'simulated', evidence_level: 'simulated', available: true, attached: true, same_thread_verified: true, limitation_reason: null });
        }
        this.semantics.acceptReceipt(this._receipt);
        this.event('capability_probe', { available: this._receipt.available, limitation_reason: this._receipt.limitation_reason });
        return this.receipt;
    }
    async readThread(request) {
        this.ensureOpen();
        const identity = this.target(request);
        if (!this._receipt.available)
            throw new ProviderIdentityError(this._receipt.limitation_reason ?? 'Provider unavailable.');
        const result = this.snapshot(identity);
        this.event('thread_read', { status: result.status, turn_count: result.turns.length });
        return result;
    }
    async readWriter(request) {
        this.ensureOpen();
        this.target(request);
        if (!this._receipt.available)
            throw new ProviderIdentityError(this._receipt.limitation_reason ?? 'Provider unavailable.');
        const result = { ...clone(this.writer), observed_at: now() };
        this.writer = result;
        this.event('writer_state', { status: result.status }, null, result.turn_id);
        return clone(result);
    }
    async resume(request) {
        const thread = await this.readThread(request);
        const status = this.writer.status === 'in-progress' || this.writer.status === 'active-writer' ? 'active_writer' : 'attached';
        this.event('resume', { status, created_worker: false });
        return { ...thread, status, created_worker: false };
    }
    async send(request) {
        this.ensureOpen();
        const identity = this.target(request);
        if (!this._receipt.available)
            return { delivery_id: request.delivery_id, outcome: 'unavailable', target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: null, created_worker: false, reason: this._receipt.limitation_reason ?? 'Provider unavailable.', observed_at: now() };
        this.event('send_prepared', { message_length: request.message.length }, request.delivery_id);
        const existing = this.deliveries.get(request.delivery_id);
        if (existing)
            return { delivery_id: request.delivery_id, outcome: 'already-present', target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: existing.target_turn_id, created_worker: false, reason: 'Delivery already exists in the original thread history.', observed_at: now() };
        if (this.writer.status === 'in-progress' || this.writer.status === 'active-writer') {
            this.event('writer_state', { status: this.writer.status, reason: 'active writer; send deferred' }, request.delivery_id, this.writer.turn_id);
            return { delivery_id: request.delivery_id, outcome: 'active-writer', target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: null, created_worker: false, reason: 'The original A currently owns an active writer.', observed_at: now() };
        }
        const outcome = this.sendOutcomes.shift() ?? 'sent';
        const turnId = outcome === 'sent' ? `turn-${this.turns.length + 1}` : null;
        const delivery = { delivery_id: request.delivery_id, message: request.message, status: outcome, target_turn_id: turnId, client_message_id: request.delivery_id, observed_at: now() };
        this.deliveries.set(request.delivery_id, delivery);
        this.semantics.seedDelivery(delivery);
        if (turnId)
            this.turns.push({ turn_id: turnId, status: 'in-progress', started_at: now(), completed_at: null, items: [{ type: 'user_message', client_message_id: request.delivery_id, delivery_id: request.delivery_id, value: request.message }] });
        this.event('send_sent', { outcome }, request.delivery_id, turnId);
        return { delivery_id: request.delivery_id, outcome, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: turnId, created_worker: false, reason: outcome === 'unknown' ? 'The send outcome is unknown; reconcile against the original thread history before retrying.' : null, observed_at: now() };
    }
    async subscribe(request, listener) {
        this.ensureOpen();
        this.target(request);
        if (!this._receipt.available)
            throw new ProviderIdentityError(this._receipt.limitation_reason ?? 'Provider unavailable.');
        this.listeners.add(listener);
        return { unsubscribe: () => { this.listeners.delete(listener); } };
    }
    async readHistory(request) {
        this.ensureOpen();
        const identity = this.target(request);
        if (!this._receipt.available)
            return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns: [], has_more: false, cursor: null, readable: false, limitation_reason: this._receipt.limitation_reason ?? 'Provider unavailable.', observed_at: now() };
        if (this.scenario.history_readable === false)
            return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns: [], has_more: false, cursor: null, readable: false, limitation_reason: 'Original thread history is unreadable.', observed_at: now() };
        return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns: clone(this.turns), has_more: false, cursor: null, readable: true, limitation_reason: null, observed_at: now() };
    }
    async reconcileDelivery(request) {
        this.ensureOpen();
        this.target(request);
        const at = now();
        const delivery = this.deliveries.get(request.delivery_id);
        let result;
        if (!this._receipt.available)
            result = { delivery_id: request.delivery_id, outcome: 'unavailable', matched_by: 'none', target_turn_id: null, reason: this._receipt.limitation_reason ?? 'Provider unavailable.', observed_at: at };
        else if (delivery?.status === 'confirmed') {
            const activity = this.semantics.state.continuation_confirmation;
            result = activity?.delivery_id === request.delivery_id
                ? { delivery_id: request.delivery_id, outcome: 'confirmed', matched_by: 'activity', target_turn_id: activity.turn_id ?? delivery.target_turn_id, reason: null, observed_at: at }
                : { delivery_id: request.delivery_id, outcome: 'confirmed', matched_by: 'delivery_id', target_turn_id: delivery.target_turn_id, reason: null, observed_at: at };
        }
        else if (delivery?.status === 'sent' || delivery?.status === 'already-present')
            result = { delivery_id: request.delivery_id, outcome: 'sent', matched_by: 'delivery_id', target_turn_id: delivery.target_turn_id, reason: 'A matching user message exists, but A activity is not confirmed.', observed_at: at };
        else if (delivery?.status === 'active-writer')
            result = { delivery_id: request.delivery_id, outcome: 'active_writer', matched_by: 'none', target_turn_id: delivery.target_turn_id, reason: 'The original A owns an active writer.', observed_at: at };
        else if (delivery?.status === 'unavailable')
            result = { delivery_id: request.delivery_id, outcome: 'unavailable', matched_by: 'none', target_turn_id: delivery.target_turn_id, reason: 'The provider could not confirm delivery.', observed_at: at };
        else if (delivery?.status === 'unknown')
            result = { delivery_id: request.delivery_id, outcome: 'unknown', matched_by: 'none', target_turn_id: null, reason: 'No matching history or A activity confirmation exists yet.', observed_at: at };
        else {
            const match = this.turns.find(turn => turn.items.some(item => item.client_message_id === (request.client_message_id ?? request.delivery_id) || item.delivery_id === request.delivery_id || (request.target_turn_id !== null && request.target_turn_id !== undefined && turn.turn_id === request.target_turn_id)));
            result = match ? { delivery_id: request.delivery_id, outcome: 'sent', matched_by: match.turn_id === request.target_turn_id ? 'target_turn_id' : 'client_message_id', target_turn_id: match.turn_id, reason: 'A matching message exists in the original thread history.', observed_at: at } : { delivery_id: request.delivery_id, outcome: 'not_found', matched_by: 'none', target_turn_id: null, reason: 'No matching delivery, client message or target turn exists in the original thread history.', observed_at: at };
        }
        this.event('delivery_reconciled', { outcome: result.outcome, matched_by: result.matched_by, reason: result.reason }, request.delivery_id, result.target_turn_id);
        return result;
    }
    /** Simulated host control used by tests to represent native A activity. */
    confirmActivity(deliveryId, turnId) {
        const delivery = this.deliveries.get(deliveryId);
        const targetTurn = turnId ?? delivery?.target_turn_id ?? `turn-${this.turns.length + 1}`;
        if (delivery) {
            delivery.status = 'confirmed';
            delivery.target_turn_id = targetTurn;
            delivery.observed_at = now();
        }
        else
            this.deliveries.set(deliveryId, { delivery_id: deliveryId, message: '', status: 'confirmed', target_turn_id: targetTurn, client_message_id: deliveryId, observed_at: now() });
        this.semantics.recordActivity({ target_thread_id: this._receipt.target_thread_id, target_session_id: this._receipt.target_session_id, turn_id: targetTurn, delivery_id: deliveryId, details: { confirmed: true } });
        const turn = this.turns.find(value => value.turn_id === targetTurn);
        if (turn) {
            turn.status = 'completed';
            turn.completed_at = now();
        }
        else
            this.turns.push({ turn_id: targetTurn, status: 'completed', started_at: now(), completed_at: now(), items: [{ type: 'user_message', client_message_id: deliveryId, delivery_id: deliveryId }] });
        this.threadStatus = 'idle';
        this.writer = { status: 'idle', owner_session_id: null, turn_id: null, reason: null, observed_at: now() };
        const activity = { event_id: randomUUID(), type: 'activity', target_thread_id: this._receipt.target_thread_id, target_session_id: this._receipt.target_session_id, turn_id: targetTurn, delivery_id: deliveryId, observed_at: now(), details: { confirmed: true } };
        this.event('activity', activity.details, deliveryId, targetTurn);
        return activity;
    }
    setWriterState(writer) { this.writer = clone({ ...writer, observed_at: now() }); this.threadStatus = writer.status === 'in-progress' || writer.status === 'active-writer' ? 'in-progress' : 'idle'; this.event('writer_state', { status: writer.status, reason: writer.reason }, null, writer.turn_id); }
    async close() { if (this.closed)
        return; this.event('closed', {}); this.closed = true; this.listeners.clear(); await this.semantics.close(); }
}
export function createSimulatedMainSessionProvider(scenario = {}) { return new SimulatedMainSessionProvider(scenario); }
export const createSimulatedProvider = createSimulatedMainSessionProvider;
