import { randomUUID } from 'node:crypto';
import { record, text } from './types.js';
import { RouteLedger, canonicalExecutionRoute, fingerprintRoute, routeFamilyFingerprint } from './route-ledger.js';
export function planningEvidenceIds(snapshot) {
    return new Set([...snapshot.evidence.map((entry) => entry.id), ...(snapshot.c2?.catalog.entries.flatMap((entry) => entry.evidence.map((item) => item.id)) ?? []), ...(snapshot.c2?.ledger.attempts.flatMap((entry) => entry.evidence.map((item) => item.id)) ?? [])]);
}
function refs(value, snapshot, field) {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !planningEvidenceIds(snapshot).has(id)))
        throw new Error(`${field} references unknown evidence IDs.`);
    return value;
}
function fields(value, required) {
    if (required.some((name) => !Object.hasOwn(value, name)) || Object.keys(value).some((name) => !required.includes(name)))
        throw new Error('C2 route plan has missing or unknown fields.');
}
function routeCandidate(raw, snapshot) {
    const value = record(raw);
    fields(value, ['route_id', 'resource', 'operation', 'hypothesis_id', 'hypothesis', 'expected_evidence', 'status', 'evidence_ids', 'actions', 'expected_signal', 'risk', 'fallback', 'discriminating_check']);
    const route = value;
    fingerprintRoute(route);
    fields(record(route.resource), ['kind', 'id']);
    if (!['observed', 'candidate', 'blocked', 'exhausted', 'forbidden', 'unknown'].includes(route.status))
        throw new Error('Invalid C2 candidate status.');
    refs(route.evidence_ids, snapshot, 'candidate.evidence_ids');
    for (const key of ['expected_signal', 'risk'])
        text(value[key], key);
    if (!Array.isArray(route.actions) || !route.actions.length)
        throw new Error('C2 candidates need concrete actions.');
    route.actions.forEach((action) => text(action, 'candidate.actions'));
    const fallback = record(route.fallback);
    fields(fallback, ['route_id', 'when']);
    text(fallback.when, 'fallback.when');
    if (fallback.route_id !== null)
        text(fallback.route_id, 'fallback.route_id');
    if (route.discriminating_check !== null) {
        const check = record(route.discriminating_check);
        fields(check, ['description', 'evidence_ids']);
        text(check.description, 'discriminating_check.description');
        refs(check.evidence_ids, snapshot, 'discriminating_check.evidence_ids');
    }
    const catalog = snapshot.c2?.catalog.entries.find((entry) => entry.route_id === route.route_id);
    if (catalog && (catalog.resource.kind !== route.resource.kind || catalog.resource.id !== route.resource.id || catalog.operation !== route.operation))
        throw new Error('C2 route identity must match its catalog resource and operation.');
    if (route.status === 'observed' && (!catalog || catalog.status !== 'observed' || !catalog.evidence.length || !catalog.evidence.some((entry) => route.evidence_ids.includes(entry.id))))
        throw new Error('Ungrounded provider/capability claim: observed routes require catalog evidence.');
    if (['blocked', 'forbidden', 'exhausted'].includes(route.status) && (!catalog || catalog.status !== route.status || !catalog.evidence.some((entry) => route.evidence_ids.includes(entry.id))))
        throw new Error('Ungrounded route exclusion requires matching catalog evidence.');
    // Unknown candidates may be proposed, but must not claim tested availability.
    const prose = [route.hypothesis, ...route.actions, route.expected_signal].join(' ');
    if (route.status !== 'observed' && /\b(?:is available|is authenticated|credentials? (?:are|is) present|rate.limit (?:is )?clear|verified available)\b|已验证可用|凭据已就绪|已认证可用/i.test(prose))
        throw new Error('Ungrounded provider availability/authentication claim in route wording.');
    return route;
}
export function validateC2Decision(decision, snapshot) {
    const mode = snapshot.c2?.mode ?? 'enforce';
    if (mode === 'legacy')
        return decision;
    if (decision.action === 'CONTINUE') {
        if (!decision.route_plan || !decision.diagnosis) {
            if (mode === 'shadow')
                return decision;
            throw new Error('C2 CONTINUE requires diagnosis and route_plan.');
        }
        const diagnosis = record(decision.diagnosis);
        fields(diagnosis, ['class', 'statement', 'evidence_ids']);
        if (!['provider_limit', 'authentication', 'implementation', 'evidence_gap', 'external_dependency', 'unknown'].includes(String(diagnosis.class)))
            throw new Error('Invalid diagnosis class.');
        text(diagnosis.statement, 'diagnosis.statement');
        refs(diagnosis.evidence_ids, snapshot, 'diagnosis.evidence_ids');
        if (!['evidence_gap', 'unknown'].includes(String(diagnosis.class)) && !diagnosis.evidence_ids.length)
            throw new Error('A factual diagnosis requires evidence references.');
        const raw = record(decision.route_plan);
        fields(raw, ['plan_id', 'candidates', 'selected_route_id', 'selection_reason', 'single_route_reason', 'success_condition', 'stop_condition']);
        for (const name of ['plan_id', 'selected_route_id', 'selection_reason', 'success_condition', 'stop_condition'])
            text(raw[name], name);
        if (raw.single_route_reason !== null)
            text(raw.single_route_reason, 'single_route_reason');
        if (!Array.isArray(raw.candidates) || !raw.candidates.length || raw.candidates.length > 8)
            throw new Error('C2 needs one to eight candidate routes.');
        const candidates = raw.candidates.map((entry) => routeCandidate(entry, snapshot));
        if (new Set(candidates.map((route) => route.route_id)).size !== candidates.length)
            throw new Error('Duplicate C2 route IDs.');
        const selected = candidates.find((route) => route.route_id === raw.selected_route_id);
        if (!selected)
            throw new Error('Selected route is absent from candidates.');
        for (const route of candidates)
            if (route.fallback.route_id !== null && (!candidates.some((entry) => entry.route_id === route.fallback.route_id) || route.fallback.route_id === route.route_id))
                throw new Error('Invalid C2 fallback route.');
        const distinct = new Set(candidates.map(routeFamilyFingerprint));
        const knownAlternatives = snapshot.c2?.catalog.entries.filter((entry) => !entry.inventory_only && entry.status === 'observed' && entry.authorization.status === 'authorized') ?? [];
        if (distinct.size < 2 && (!raw.single_route_reason || (selected.resource.kind !== 'diagnostic' && knownAlternatives.length > 1)))
            throw new Error('C2 requires materially different candidates or a justified single route.');
        if (selected.resource.kind !== 'diagnostic' && knownAlternatives.length > 1 && new Set(candidates.filter((route) => route.resource.kind !== 'diagnostic' && route.status === 'observed').map(routeFamilyFingerprint)).size < 2)
            throw new Error('C2 needs two substantive candidates when multiple executable catalog directions exist.');
        if (['blocked', 'exhausted', 'forbidden'].includes(selected.status))
            throw new Error('Selected C2 route is not executable.');
        const catalog = snapshot.c2?.catalog.entries.find((entry) => entry.route_id === selected.route_id);
        if (selected.resource.kind !== 'diagnostic' && (!snapshot.c2?.context_complete || !catalog || catalog.status !== 'observed' || selected.status !== 'observed'))
            throw new Error('Missing route context requires route-inventory or discriminating diagnostic CONTINUE.');
        if (decision.next_message !== selected.actions.join('\n') || decision.next_message.length > 3_000)
            throw new Error('C2 next_message must be a short instruction derived from selected route actions.');
        if (snapshot.c2) {
            const ledger = new RouteLedger({ task_id: snapshot.task_id, task_version: snapshot.task_version }, { data: snapshot.c2.ledger });
            const evidence = snapshot.c2.observations.filter((entry) => selected.evidence_ids.includes(entry.id));
            const permission = ledger.evaluateAttempt(canonicalExecutionRoute(selected, snapshot.c2.catalog.entries), { evidence_ids: selected.evidence_ids, evidence, ...(selected.discriminating_check ? { discriminating_check: selected.discriminating_check } : {}) });
            if (!permission.allowed)
                throw new Error(`C2 repeated route rejected: ${permission.reason}.`);
        }
    }
    else {
        if (decision.route_plan != null || decision.diagnosis != null)
            throw new Error('Only CONTINUE may carry diagnosis and route_plan.');
        if (decision.action === 'WAIT_EXTERNAL') {
            const context = snapshot.c2;
            if (!context?.context_complete || !context.catalog.entries.length)
                throw new Error('Missing route context requires inventory CONTINUE before WAIT_EXTERNAL.');
            for (const route of context.catalog.entries) {
                // B already performed this read-only inventory operation. It proves
                // readability, never relevance or unfinished work toward acceptance.
                if (route.inventory_only && route.last_success && route.evidence.some((proof) => proof.source === 'probe' && proof.reference === `workspace-file:${route.resource.id}`) && decision.external?.attempted.some((reason) => reason.includes(route.route_id)))
                    continue;
                const attempt = context.ledger.attempts.findLast((attempt) => attempt.route.resource.kind === route.resource.kind && attempt.route.resource.id === route.resource.id && attempt.route.operation === route.operation);
                if (!['forbidden', 'exhausted', 'blocked'].includes(route.status) || !route.evidence.length || (route.status !== 'forbidden' && !attempt) || !decision.external?.attempted.some((reason) => reason.includes(route.route_id)))
                    throw new Error(`WAIT_EXTERNAL requires explicit attempted/excluded route ${route.route_id} with evidence and reason.`);
            }
        }
    }
    return decision;
}
/** A safe executable direction; it makes no provider or authentication claim. */
export function routeInventoryDecision(snapshot, reason = 'Required route facts are missing or the planner could not produce a valid decision.', message) {
    const action = message ?? 'Collect a bounded read-only route inventory for the remaining acceptance items: inspect authorized local artifacts, configured provider/API capabilities and prior failures; record actual authorization, network, authentication and retry evidence with source references. Do not retry a failed provider blindly. Report one discriminating check and concise proof before choosing an execution route.';
    const evidenceIds = snapshot.c2?.observations.map((entry) => entry.id) ?? [];
    return { action: 'CONTINUE', reason, evidence_ids: [], next_message: action, external: null,
        diagnosis: { class: 'evidence_gap', statement: reason, evidence_ids: [] },
        route_plan: { plan_id: randomUUID(), candidates: [{
                    route_id: 'route-inventory', resource: { kind: 'diagnostic', id: 'authorized-route-inventory' }, operation: 'inspect-authorized-route-facts', hypothesis_id: 'missing-route-facts', hypothesis: 'A bounded inspection can establish the next authorized route without assuming provider availability.', expected_evidence: ['Source-linked capability and blocker facts for the remaining acceptance items'], status: 'candidate', evidence_ids: evidenceIds, actions: [action], expected_signal: 'A source-linked catalog or a concise discriminating observation.', risk: 'Inspection may find that an external condition is necessary; do not infer that before inspection.', fallback: { route_id: null, when: 'If inspection cannot establish a route, record the missing facts and the exact required observation.' }, discriminating_check: null,
                }], selected_route_id: 'route-inventory', selection_reason: 'Gather missing facts before selecting a substantive route.', single_route_reason: 'One bounded inventory step is sufficient before route facts support distinct executable candidates.', success_condition: 'Record concise, independently traceable route facts.', stop_condition: 'Stop inspection after producing the bounded inventory or a precise missing-fact record; do not execute an unverified provider.' },
    };
}
