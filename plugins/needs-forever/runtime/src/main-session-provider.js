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
        && nonEmpty(value.run_generation);
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
    if (!nonEmpty(receipt.observed_at) || !Number.isFinite(Date.parse(receipt.observed_at)))
        throw new Error('Capability receipt observed_at must be an ISO timestamp.');
    return clone(receipt);
}
export function createProviderEvent(input) {
    return { schema_version: 1, event_id: input.event_id ?? randomUUID(), at: input.at ?? now(), delivery_id: input.delivery_id ?? null, turn_id: input.turn_id ?? null, ...input };
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
    return createProviderEvent({ type, provider_kind: receipt.provider_kind, evidence_level: receipt.evidence_level, target_thread_id: receipt.target_thread_id, target_session_id: receipt.target_session_id, workspace: receipt.workspace, host_fingerprint: receipt.host_fingerprint, task_version: receipt.task_version, run_generation: receipt.run_generation, delivery_id: deliveryId, turn_id: turnId, payload });
}
export class SimulatedMainSessionProvider {
    kind = 'simulated';
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
    }
    get receipt() { return clone(this._receipt); }
    ensureOpen() { if (this.closed)
        throw new Error('Provider is closed.'); }
    target(request) {
        const candidate = request.target;
        if (!completeIdentity(candidate))
            throw new ProviderIdentityError('Trusted provider identity is unavailable; target thread/session, absolute workspace, host fingerprint, task version and run generation are required.');
        const identity = { ...candidate, main_session_id: candidate.main_session_id ?? candidate.target_thread_id };
        if (!this.identity || !identityMatches(this.identity, identity))
            throw new ProviderIdentityError('Provider target identity does not match the registered original thread, workspace, host or generation.');
        return identity;
    }
    event(type, payload, deliveryId = null, turnId = null) {
        const event = providerEventFrom(this._receipt, type, payload, deliveryId, turnId);
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
        else if (delivery?.status === 'confirmed')
            result = { delivery_id: request.delivery_id, outcome: 'confirmed', matched_by: 'delivery_id', target_turn_id: delivery.target_turn_id, reason: null, observed_at: at };
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
        return; this.event('closed', {}); this.closed = true; this.listeners.clear(); }
}
export function createSimulatedMainSessionProvider(scenario = {}) { return new SimulatedMainSessionProvider(scenario); }
export const createSimulatedProvider = createSimulatedMainSessionProvider;
