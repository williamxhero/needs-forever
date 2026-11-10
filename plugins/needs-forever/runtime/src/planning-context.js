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
    if (snapshot.evidence_complete === false)
        return [];
    return snapshot.evidence.filter((entry) => entry.source?.event_id && entry.source.observed_at && Number.isFinite(Date.parse(entry.source.observed_at)) && ['commandExecution', 'fileChange', 'functionCallOutput', 'verification_result'].includes(entry.type)).map((entry) => ({
        id: entry.id, source: entry.type === 'verification_result' ? 'verification' : 'event', reference: entry.source.event_id,
        observed_at: entry.source.observed_at, task_version: snapshot.task_version,
        content_sha256: routeEvidenceDigest({ type: entry.type, value: substantive(entry.value) }),
    }));
}
/** Attach the same bounded, read-only planning contract to either Stop path.
 * Current Stop proof and immutable task fields have priority over route history.
 */
export function buildC2Context(snapshot, state, maxChars = 24_000) {
    const scope = { task_id: state.task_id, task_version: state.task_version };
    const catalog = activeRouteCatalog(state);
    const ledger = new RouteLedger(scope, state.route_ledger ? { data: state.route_ledger } : {}).toJSON();
    snapshot.omissions = (snapshot.omissions ?? []).filter((item) => !item.startsWith('HTTP probe URL budget omitted '));
    snapshot.plan ??= { missing: 'No current worker plan observed.' };
    snapshot.recent_verification ??= { missing: 'No independent verification result recorded yet.' };
    snapshot.repeated_failure ??= { instruction: 'Use ledger retry permissions; change hypothesis after repeated failures and gather discriminating evidence.' };
    snapshot.c2 = {
        mode: effectiveC2Mode(state), context_complete: catalog.entries.length > 0 && !state.route_probe?.omitted_url_sha256?.length,
        catalog, ledger, observations: snapshotRouteEvidence(snapshot), current_plan: state.last_decision?.route_plan ?? null,
        instruction: 'Facts come only from NF/B observations. Unknown capability/authentication/network/rate-limit facts require route inventory or a discriminating diagnostic. Never infer availability from resource names or model prose. Check ledger permission before choosing a route; equivalent wording is not progress.',
        ...(state.route_probe ? { http_probe: { argv_prefix: state.route_probe.argv_prefix, instruction: 'Only original A may explicitly invoke this exact single literal Node command with --url <credential-free URL> inside the original authorization. NF performs one bounded unauthenticated GET and signs a metadata-only receipt. B verifies command/source/scope/signature; JSON hints never trigger network. A current 2xx can establish this API operation; missing auth/quota facts remain unknown on failures. Never read credentials or grant new permission.' } } : {}),
    };
    snapshot.c2 = redact(snapshot.c2);
    if (!catalog.entries.length)
        snapshot.omissions.push('Route Catalog has no observed entries; collect a bounded route inventory or discriminating diagnostic.');
    if (state.route_probe?.omitted_url_sha256?.length)
        snapshot.omissions.push(`HTTP probe URL budget omitted ${state.route_probe.omitted_url_sha256.length} unresolved URL observations; inventory/diagnostic required before external waiting.`);
    let omittedCatalog = 0, omittedAttempts = 0, omittedObservations = 0;
    const size = () => JSON.stringify(snapshot).length;
    while (size() > maxChars - 400 && (snapshot.c2.ledger.attempts.length > 1 || snapshot.c2.catalog.entries.length > 1)) {
        const ledgerLarger = JSON.stringify(snapshot.c2.ledger.attempts).length > JSON.stringify(snapshot.c2.catalog.entries).length;
        if (snapshot.c2.ledger.attempts.length > 1 && (ledgerLarger || snapshot.c2.catalog.entries.length <= 1)) {
            snapshot.c2.ledger.attempts.shift();
            omittedAttempts++;
        }
        else {
            snapshot.c2.catalog.entries.pop();
            omittedCatalog++;
        }
    }
    while (size() > maxChars - 400 && snapshot.c2.ledger.attempts.length) {
        snapshot.c2.ledger.attempts.shift();
        omittedAttempts++;
    }
    while (size() > maxChars - 400 && snapshot.c2.catalog.entries.length) {
        snapshot.c2.catalog.entries.pop();
        omittedCatalog++;
    }
    while (size() > maxChars - 400 && snapshot.c2.observations.length) {
        snapshot.c2.observations.pop();
        omittedObservations++;
    }
    if (size() > maxChars - 400 && snapshot.c2.current_plan) {
        snapshot.c2.current_plan = null;
        snapshot.omissions.push('Prior route plan omitted for budget.');
        snapshot.c2.context_complete = false;
    }
    if (omittedCatalog || omittedAttempts || omittedObservations) {
        snapshot.c2.context_complete = false;
        snapshot.omissions.push(`C2 budget omissions: ${omittedCatalog} catalog entries, ${omittedAttempts} route attempts, ${omittedObservations} observation digests. Inventory/diagnostic required before substantive route selection or external waiting.`);
    }
    // A pre-C2/near-limit Stop may already consume the ordinary proof budget.
    // Keep the immutable contract, and make omitted current proof explicit rather
    // than failing before C can request a concise discriminating observation.
    let omittedCurrentProof = 0;
    while (size() > maxChars - 400 && snapshot.evidence.length) {
        const omitted = snapshot.evidence.pop();
        snapshot.c2.observations = snapshot.c2.observations.filter((entry) => entry.id !== omitted.id);
        omittedCurrentProof++;
    }
    if (omittedCurrentProof) {
        snapshot.evidence_complete = false;
        snapshot.c2.context_complete = false;
        snapshot.omissions.push(`${omittedCurrentProof} current Stop proof entries omitted to fit C2 within ${maxChars} characters; gather concise current proof before terminal judgment.`);
    }
    if (size() > maxChars)
        throw new Error('Task contract and current Stop proof leave insufficient room for the bounded C2 context within 24000 characters.');
    return snapshot;
}
