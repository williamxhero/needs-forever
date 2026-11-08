import { randomUUID } from 'node:crypto';
export function adapterEnvelope(input) {
    return {
        schema_version: 1,
        occurrence_id: input.occurrence_id ?? randomUUID(),
        issued_at: input.issued_at ?? new Date().toISOString(),
        ...input,
    };
}
export function validateAdapterEnvelope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Adapter event must be an object.');
    const event = value;
    const required = ['provider', 'host_instance_id', 'session_id', 'task_id', 'workspace', 'event_type', 'occurrence_id', 'issued_at'];
    for (const key of required)
        if (typeof event[key] !== 'string' || !event[key].trim())
            throw new Error(`Adapter event ${key} is required.`);
    if (event.schema_version !== 1)
        throw new Error('Unsupported adapter event schema.');
    const eventTypes = ['register', 'rebind', 'session_start', 'user_prompt', 'pre_tool', 'post_tool', 'stop', 'interrupt', 'delivery_ack'];
    if (!eventTypes.includes(event.event_type))
        throw new Error('Unsupported adapter event type.');
    if (event.turn_id !== null && event.turn_id !== undefined && typeof event.turn_id !== 'string')
        throw new Error('Adapter event turn_id must be a string or null.');
    if (event.bundle_sha256 !== null && event.bundle_sha256 !== undefined && typeof event.bundle_sha256 !== 'string')
        throw new Error('Adapter event bundle_sha256 must be a string or null.');
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
        throw new Error('Adapter event payload must be an object.');
    if (!Number.isFinite(Date.parse(event.issued_at)))
        throw new Error('Adapter event issued_at must be an ISO timestamp.');
    return {
        schema_version: 1,
        provider: event.provider,
        host_instance_id: event.host_instance_id,
        session_id: event.session_id,
        task_id: event.task_id,
        workspace: event.workspace,
        event_type: event.event_type,
        occurrence_id: event.occurrence_id,
        issued_at: event.issued_at,
        turn_id: event.turn_id ?? null,
        bundle_sha256: event.bundle_sha256 ?? null,
        payload: event.payload,
    };
}
