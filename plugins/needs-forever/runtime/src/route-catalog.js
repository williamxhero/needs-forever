import { clone, RouteStorage, strings, timestamp, validateEnvelope, validateEvidence } from './route-storage.js';
import { record, text } from './types.js';
function validateEntry(value) {
    const entry = record(value);
    text(entry.route_id, 'route_id');
    text(entry.operation, 'operation');
    const resource = record(entry.resource);
    text(resource.id, 'resource.id');
    if (!['provider', 'artifact', 'api', 'command', 'diagnostic'].includes(String(resource.kind)))
        throw new Error('Invalid route resource kind.');
    if (!['observed', 'candidate', 'blocked', 'exhausted', 'forbidden', 'unknown'].includes(String(entry.status)))
        throw new Error('Invalid route status.');
    strings(entry.capabilities, 'capabilities');
    if (!Array.isArray(entry.evidence))
        throw new Error('Route evidence must include observation provenance.');
    const ids = new Set();
    for (const value of entry.evidence) {
        validateEvidence(value);
        const evidence = record(value);
        const id = text(evidence.id, 'evidence.id');
        if (ids.has(id))
            throw new Error('Duplicate route evidence ID.');
        ids.add(id);
    }
    const authorization = record(entry.authorization), network = record(entry.network), authentication = record(entry.authentication), rate = record(entry.rate_limit);
    function fact(fact, known, field) {
        const references = strings(fact.evidence_ids, `${field}.evidence_ids`);
        if (references.some((id) => !ids.has(id)))
            throw new Error(`Unknown evidence reference in ${field}.`);
        if (known && references.length === 0)
            throw new Error(`${field} requires observed evidence.`);
    }
    if (!['authorized', 'forbidden', 'unknown'].includes(String(authorization.status)))
        throw new Error('Invalid authorization status.');
    if (![true, false, null].includes(network.required) || ![true, false, null].includes(network.available))
        throw new Error('Invalid network facts.');
    if (!['present', 'missing', 'not_required', 'unknown'].includes(String(authentication.status)))
        throw new Error('Invalid authentication status.');
    if (!['clear', 'limited', 'unknown'].includes(String(rate.status)))
        throw new Error('Invalid rate-limit status.');
    if (rate.retry_at !== null)
        timestamp(rate.retry_at, 'rate_limit.retry_at');
    fact(authorization, authorization.status !== 'unknown', 'authorization');
    fact(network, network.required !== null || network.available !== null, 'network');
    fact(authentication, authentication.status !== 'unknown', 'authentication');
    fact(rate, rate.status !== 'unknown' || rate.retry_at !== null, 'rate_limit');
    if (entry.last_success !== null) {
        const success = record(entry.last_success);
        timestamp(success.at, 'last_success.at');
        fact(success, true, 'last_success');
    }
    if (entry.status === 'observed' && (ids.size === 0 || authorization.status !== 'authorized' || !['present', 'not_required'].includes(String(authentication.status)) || rate.status !== 'clear' || network.required === null || (network.required && network.available !== true))) {
        throw new Error('Observed routes require independently evidenced authorization, authentication, network and rate-limit facts.');
    }
    if (entry.inventory_only !== undefined && (entry.inventory_only !== true || resource.kind !== 'artifact' || entry.operation !== 'read-local-artifact' || entry.last_success === null || !entry.evidence.some((proof) => proof.source === 'probe' && proof.reference === `workspace-file:${resource.id}`)))
        throw new Error('Completed generic inventory requires a source-linked local file probe.');
}
function validateData(value) {
    validateEnvelope(value);
    const data = record(value);
    if (!Array.isArray(data.entries))
        throw new Error('Invalid Route Catalog entries.');
    const ids = new Set();
    for (const entry of data.entries) {
        validateEntry(entry);
        const id = entry.route_id;
        if (ids.has(id))
            throw new Error('Duplicate catalog route_id.');
        ids.add(id);
    }
}
export class RouteCatalog {
    storage;
    constructor(scope, options = {}) {
        this.storage = new RouteStorage(scope, options, { schema_version: 1, scope, revision: 0, entries: [] }, validateData);
    }
    upsert(entry) {
        validateEntry(entry);
        this.storage.update((data) => {
            const index = data.entries.findIndex((existing) => existing.route_id === entry.route_id);
            if (index < 0)
                data.entries.push(clone(entry));
            else
                data.entries[index] = clone(entry);
        });
    }
    list() { return this.storage.read().entries; }
    get(route_id) { return this.list().find((entry) => entry.route_id === route_id); }
    toJSON() { return this.storage.read(); }
}
