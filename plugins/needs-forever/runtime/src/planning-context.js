import { activeRouteCatalog } from './route-catalog.js';
import { RouteLedger, routeEvidenceDigest } from './route-ledger.js';
import { redact } from './redact.js';
export function effectiveC2Mode(state) {
    if (state.task.c2?.mode === 'legacy' && state.mode !== 'simulated')
        throw new Error('Legacy C2 mode is restricted to explicit simulated fixtures.');
    return state.task.c2?.mode ?? 'enforce';
}
function substantive(value) {
    // Strip only the protocol envelope. IDs/timestamps inside actual tool output
    // can be substantive business evidence and must continue to affect the hash.
    if (value && typeof value === 'object' && !Array.isArray(value))
        return Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'event_id', 'at', 'ts', 'timestamp', 'observed_at', 'thread_id', 'turn_id', 'item_id'].includes(key)).map(([key, item]) => {
            // NF receipt issuance time/signature is transport identity, not new API
            // evidence. Preserve the actual URL/status/body digest/retry facts only.
            if (['aggregatedOutput', 'tool_response', 'stdout', 'output'].includes(key)) {
                try {
                    const parsed = typeof item === 'string' ? JSON.parse(item) : item;
                    const envelope = parsed && typeof parsed === 'object' ? parsed : {};
                    const receipt = envelope.nf_route_probe;
                    if (receipt?.schema_version === 1 && typeof receipt.signature === 'string')
                        return [key, { nf_route_probe: { url: receipt.url, result: receipt.result } }];
                    if (key === 'tool_response' && parsed && typeof parsed === 'object')
                        return [key, substantive(parsed)];
                }
                catch { /* Ordinary tool output remains substantive verbatim. */ }
            }
            return [key, item];
        }));
    return value;
}
export function snapshotRouteEvidence(snapshot) {
    // A missing/truncated sibling prevents terminal judgment, not observation of
    // another complete result. Historical snapshots without per-entry metadata
    // retain the conservative all-or-nothing behavior when globally incomplete.
    return snapshot.evidence.filter((entry) => entry.complete !== false && (snapshot.evidence_complete !== false || entry.complete === true) && entry.source?.event_id && entry.source.observed_at && Number.isFinite(Date.parse(entry.source.observed_at)) && ['commandExecution', 'fileChange', 'functionCallOutput', 'verification_result'].includes(entry.type)).map((entry) => ({
        id: entry.id, source: entry.type === 'verification_result' ? 'verification' : 'event', reference: entry.source.event_id,
        observed_at: entry.source.observed_at, task_version: snapshot.task_version,
        content_sha256: routeEvidenceDigest({ type: entry.type, value: substantive(entry.value) }),
        summary: `${entry.type} at ${entry.source.event_id}`,
    }));
}
function routePlanRefs(plan) {
    const routeIds = new Set(), evidenceIds = new Set();
    if (!plan)
        return { routeIds, evidenceIds };
    for (const candidate of plan.candidates) {
        routeIds.add(candidate.route_id);
        candidate.evidence_ids.forEach((id) => evidenceIds.add(id));
        candidate.discriminating_check?.evidence_ids.forEach((id) => evidenceIds.add(id));
    }
    return { routeIds, evidenceIds };
}
function catalogSummary(entry) {
    return `${entry.route_id} ${entry.resource.kind}:${entry.resource.id}; ${entry.operation}; status=${entry.status}; auth=${entry.authorization.status}; rate=${entry.rate_limit.status}`.slice(0, 180);
}
function attemptSummary(attempt) {
    return `${attempt.attempt_id} ${attempt.route.route_id}; ${attempt.route.operation}; outcome=${attempt.outcome}; next=${attempt.next_attempt.allowed ? 'allowed' : attempt.next_attempt.reason}`.slice(0, 180);
}
function addOmission(target, omission) {
    if (target.some((item) => item.kind === omission.kind && item.id === omission.id))
        return;
    const aggregate = target.find((item) => item.id === `omitted:${omission.kind}`);
    if (aggregate) {
        const count = Number((aggregate.summary.match(/^(\d+)/)?.[1] ?? '1')) + 1;
        aggregate.summary = `${count} ${omission.kind} sources omitted; additional source-linked summaries remain bounded.`;
        return;
    }
    if (target.length < 4) {
        target.push(omission);
        return;
    }
    target.push({ kind: omission.kind, id: `omitted:${omission.kind}`, summary: `2 ${omission.kind} sources omitted; additional source-linked summaries remain bounded.`, reason: omission.reason });
}
function compactCatalogEntry(entry) {
    return {
        ...entry,
        capabilities: entry.capabilities.slice(0, 4).map((value) => value.slice(0, 180)),
        evidence: entry.evidence.map((proof) => ({ ...proof, summary: proof.summary ?? `${proof.source}:${proof.reference}` })).slice(0, 8),
    };
}
function compactAttempt(attempt) {
    return { ...attempt, route: { ...attempt.route }, evidence: attempt.evidence.map((proof) => ({ ...proof, summary: proof.summary ?? `${proof.source}:${proof.reference}` })).slice(0, 8) };
}
/** Attach the same bounded, read-only planning contract to either Stop path.
 * Current Stop proof and immutable task fields have priority over route history.
 */
export function buildC2Context(snapshot, state, maxChars = 24_000) {
    const scope = { task_id: state.task_id, task_version: state.task_version };
    const sourceCatalog = activeRouteCatalog(state);
    const sourceLedger = new RouteLedger(scope, state.route_ledger ? { data: state.route_ledger } : {}).toJSON();
    const catalog = { ...sourceCatalog, entries: sourceCatalog.entries.map(compactCatalogEntry) };
    const ledger = { ...sourceLedger, attempts: sourceLedger.attempts.map(compactAttempt) };
    snapshot.omissions = (snapshot.omissions ?? []).filter((item) => !item.startsWith('HTTP probe URL budget omitted '));
    snapshot.plan ??= { missing: 'No current worker plan observed.' };
    snapshot.recent_verification ??= { missing: 'No independent verification result recorded yet.' };
    snapshot.repeated_failure ??= { instruction: 'Use ledger retry permissions; change hypothesis after repeated failures and gather discriminating evidence.' };
    const currentPlan = state.last_decision?.route_plan ?? null;
    const refs = routePlanRefs(currentPlan);
    const omissions = { catalog: [], ledger: [], observations: [], current_proof: [], plan: [] };
    snapshot.c2 = {
        mode: effectiveC2Mode(state), context_complete: catalog.entries.length > 0 && !state.route_probe?.omitted_url_sha256?.length,
        catalog, ledger, observations: snapshotRouteEvidence(snapshot), current_plan: currentPlan, omissions,
        instruction: 'Facts come only from NF/B observations. Unknown capability/authentication/network/rate-limit facts require route inventory or a discriminating diagnostic. Never infer availability from resource names or model prose. Check ledger permission before choosing a route; equivalent wording is not progress.',
        ...(state.route_probe ? { http_probe: { argv_prefix: state.route_probe.argv_prefix, instruction: 'Only original A may explicitly invoke this exact single literal Node command with --url <credential-free URL> inside the original authorization. NF performs one bounded unauthenticated GET and signs a metadata-only receipt. B verifies command/source/scope/signature; JSON hints never trigger network. A current 2xx can establish this API operation; missing auth/quota facts remain unknown on failures. Never read credentials or grant new permission.' } } : {}),
    };
    snapshot.c2 = redact(snapshot.c2);
    if (!catalog.entries.length)
        snapshot.omissions.push('Route Catalog has no observed entries; collect a bounded route inventory or discriminating diagnostic.');
    if (state.route_probe?.omitted_url_sha256?.length)
        snapshot.omissions.push(`HTTP probe URL budget omitted ${state.route_probe.omitted_url_sha256.length} unresolved URL observations; inventory/diagnostic required before external waiting.`);
    const size = () => JSON.stringify(snapshot).length;
    const room = maxChars - 400;
    const dropCatalog = (index) => {
        const [item] = snapshot.c2.catalog.entries.splice(index, 1);
        if (!item)
            return;
        const omission = { kind: 'catalog', id: item.route_id, route_id: item.route_id, summary: catalogSummary(item), reason: 'Historical catalog entry omitted to fit the bounded C2 context.' };
        addOmission(snapshot.c2.omissions.catalog, omission);
    };
    const dropAttempt = (index) => {
        const [item] = snapshot.c2.ledger.attempts.splice(index, 1);
        if (!item)
            return;
        addOmission(snapshot.c2.omissions.ledger, { kind: 'ledger', id: item.attempt_id, route_id: item.route.route_id, summary: attemptSummary(item), digest: item.family_fingerprint, reason: 'Historical route attempt omitted to fit the bounded C2 context.' });
    };
    const dropObservation = (index) => {
        const [item] = snapshot.c2.observations.splice(index, 1);
        if (!item)
            return;
        addOmission(snapshot.c2.omissions.observations, { kind: 'observation', id: item.id, source: item.reference, summary: item.summary ?? `source:${item.reference}`, digest: item.content_sha256, reason: 'Historical observation digest omitted to fit the bounded C2 context.' });
    };
    const largestUnreferenced = (items, referenced, measure = (item) => JSON.stringify(item).length) => {
        let selected = -1, length = -1;
        items.forEach((item, index) => { if (!referenced(item)) {
            const size = measure(item);
            if (size > length) {
                selected = index;
                length = size;
            }
        } });
        return selected;
    };
    const unreferencedCatalog = () => snapshot.c2.catalog.entries.length > 1 ? largestUnreferenced(snapshot.c2.catalog.entries, (item) => refs.routeIds.has(item.route_id)) : -1;
    const unreferencedAttempt = () => snapshot.c2.ledger.attempts.length > 1 ? largestUnreferenced(snapshot.c2.ledger.attempts, (item) => refs.routeIds.has(item.route.route_id)) : -1;
    const unreferencedObservation = () => snapshot.c2.observations.length > 1 ? largestUnreferenced(snapshot.c2.observations, (item) => refs.evidenceIds.has(item.id), (item) => JSON.stringify(snapshot.evidence.find((entry) => entry.id === item.id)?.value ?? item).length) : -1;
    while (size() > room && (unreferencedCatalog() >= 0 || unreferencedAttempt() >= 0 || unreferencedObservation() >= 0)) {
        const catalogIndex = unreferencedCatalog(), attemptIndex = unreferencedAttempt(), observationIndex = unreferencedObservation();
        const lengths = [catalogIndex >= 0 ? JSON.stringify(snapshot.c2.catalog.entries[catalogIndex]).length : 0, attemptIndex >= 0 ? JSON.stringify(snapshot.c2.ledger.attempts[attemptIndex]).length : 0, observationIndex >= 0 ? JSON.stringify(snapshot.c2.observations[observationIndex]).length : 0];
        const largest = lengths.indexOf(Math.max(...lengths));
        if (largest === 0 && catalogIndex >= 0)
            dropCatalog(catalogIndex);
        else if (largest === 1 && attemptIndex >= 0)
            dropAttempt(attemptIndex);
        else if (observationIndex >= 0)
            dropObservation(observationIndex);
        else
            break;
    }
    if (size() > room && snapshot.c2.current_plan) {
        snapshot.c2.current_plan = JSON.parse(JSON.stringify(snapshot.c2.current_plan, (_key, value) => typeof value === 'string' ? value.slice(0, 320) : value));
        addOmission(snapshot.c2.omissions.plan, { kind: 'plan', id: snapshot.c2.current_plan.plan_id, summary: 'Current route plan retained with bounded field summaries.', reason: 'Raw plan prose compacted to fit the bounded C2 context.' });
        snapshot.omissions.push('Current route plan prose compacted for budget; route identities and selected actions remain.');
    }
    let omittedCurrentProof = 0;
    while (size() > room && snapshot.evidence.length > 1) {
        const candidates = snapshot.evidence.map((entry, index) => ({ index, referenced: refs.evidenceIds.has(entry.id), incomplete: entry.complete === false, length: JSON.stringify(entry).length }));
        candidates.sort((a, b) => Number(a.referenced) - Number(b.referenced) || Number(b.incomplete) - Number(a.incomplete) || b.length - a.length || b.index - a.index);
        const candidate = candidates.find((item) => !item.referenced) ?? candidates.at(-1);
        const [omitted] = snapshot.evidence.splice(candidate.index, 1);
        if (!omitted)
            break;
        const observed = snapshot.c2.observations.find((entry) => entry.id === omitted.id);
        if (observed)
            observed.omitted = true;
        addOmission(snapshot.c2.omissions.current_proof, { kind: 'current_proof', id: omitted.id, ...(omitted.source?.event_id ? { source: omitted.source.event_id } : {}), summary: `${omitted.type} source ${omitted.source?.event_id ?? 'unknown'}`, reason: 'Current Stop proof omitted to fit the bounded C2 context.', digest: routeEvidenceDigest({ type: omitted.type, value: substantive(omitted.value) }) });
        omittedCurrentProof++;
    }
    if (omittedCurrentProof) {
        snapshot.evidence_complete = false;
        snapshot.c2.context_complete = false;
        snapshot.omissions.push(`${omittedCurrentProof} current Stop proof entries omitted to fit C2 within ${maxChars} characters; gather concise current proof before terminal judgment.`);
    }
    // A referenced proof may itself be very large. Preserve its evidence ID,
    // source and substantive digest in a compact receipt instead of deleting the
    // proof that authorizes the current route.
    while (size() > room && snapshot.evidence.length) {
        const candidate = snapshot.evidence.findLast((entry) => refs.evidenceIds.has(entry.id)) ?? snapshot.evidence.at(-1);
        if (candidate.value && typeof candidate.value === 'object' && candidate.value.omitted === true)
            break;
        const digest = routeEvidenceDigest({ type: candidate.type, value: substantive(candidate.value) });
        candidate.value = { omitted: true, summary: `${candidate.type} source ${candidate.source?.event_id ?? 'unknown'}`, content_sha256: digest };
        candidate.complete = false;
        snapshot.evidence_complete = false;
        omittedCurrentProof++;
        addOmission(snapshot.c2.omissions.current_proof, { kind: 'current_proof', id: candidate.id, ...(candidate.source?.event_id ? { source: candidate.source.event_id } : {}), summary: `${candidate.type} source ${candidate.source?.event_id ?? 'unknown'}`, reason: 'Current Stop proof payload compacted; source and digest retained.', digest });
        if (size() > room && snapshot.evidence.length > 1) {
            const index = snapshot.evidence.indexOf(candidate);
            snapshot.evidence.splice(index, 1);
        }
        if (snapshot.evidence.length === 1 && JSON.stringify(snapshot.evidence[0]?.value).length > 1_000)
            break;
    }
    const omittedCount = snapshot.c2.omissions.catalog.length + snapshot.c2.omissions.ledger.length + snapshot.c2.omissions.observations.length + snapshot.c2.omissions.current_proof.length;
    if (omittedCount) {
        snapshot.c2.context_complete = false;
        const proofOmissions = snapshot.c2.omissions.current_proof.length;
        snapshot.omissions.push(`${proofOmissions ? 'current Stop proof was compacted or omitted for C2; ' : ''}C2 budget omissions: ${omittedCount} source-linked items; inventory/diagnostic required before substantive route selection or external waiting.`);
    }
    snapshot.c2.context_digest = routeEvidenceDigest({ task_id: snapshot.task_id, task_version: snapshot.task_version, catalog: snapshot.c2.catalog, ledger: snapshot.c2.ledger, observations: snapshot.c2.observations, current_plan: snapshot.c2.current_plan, omissions: snapshot.c2.omissions });
    if (size() > maxChars) {
        throw new Error('Task contract and current Stop proof leave insufficient room for the bounded C2 context within 24000 characters.');
    }
    return snapshot;
}
