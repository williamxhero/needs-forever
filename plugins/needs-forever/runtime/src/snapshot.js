import { randomUUID } from 'node:crypto';
import { record } from './types.js';
import { redact } from './redact.js';
import { buildC2Context } from './planning-context.js';
const MAX_CHARS = 24_000;
const PROOF_BUDGET = MAX_CHARS - 2_500;
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? record(value) : {}; }
function clip(value, max) {
    if (typeof value === 'string')
        return value.length <= max ? value : `${value.slice(0, max)} [TRUNCATED: ${value.length - max} chars]`;
    if (Array.isArray(value))
        return value.map((entry) => clip(entry, max));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clip(entry, max)]));
    return value;
}
function items(event) {
    const params = object(event.params);
    if (event.method === 'item/completed')
        return [object(params.item)];
    const turn = object(params.turn);
    return Array.isArray(turn.items) ? turn.items.map(object) : [];
}
function turnId(event) { const params = object(event.params); return params.turnId ?? object(params.turn).id; }
// The sources are the persisted protocol events, never inferred model claims.
export function buildSnapshot(state, workerTurnId, events) {
    const workerEvents = events.filter((entry) => entry.type === 'worker_evidence' && entry.thread_id === state.worker_thread_id);
    const current = workerEvents.filter((entry) => turnId(entry) === workerTurnId);
    const observed = new Map();
    for (const event of current)
        for (const item of items(event))
            if (typeof item.id === 'string')
                observed.set(item.id, { item, event });
    const latestPlan = current.findLast((entry) => entry.method === 'turn/plan/updated');
    const planItem = [...observed.values()].findLast((entry) => entry.item.type === 'plan');
    const plans = latestPlan ? object(latestPlan.params).plan : planItem?.item.text;
    const verification = events.findLast((entry) => ['verification_result', 'verification_passed', 'verification_failed', 'protected_file_changed'].includes(String(entry.type)));
    const instructions = events.filter((entry) => entry.type === 'send_prepared' && entry.source_turn_id).slice(-2).map((entry) => {
        const confirmation = events.find((event) => event.type === 'send_confirmed' && event.delivery_id === entry.delivery_id);
        const result = workerEvents.findLast((event) => event.method === 'turn/completed' && turnId(event) === confirmation?.turn_id);
        const replies = new Map();
        for (const event of workerEvents.filter((event) => turnId(event) === confirmation?.turn_id))
            for (const item of items(event))
                if (item.type === 'agentMessage')
                    replies.set(String(item.id), item.text);
        return { delivery_id: entry.delivery_id, message: clip(entry.message, 1500), turn_id: confirmation?.turn_id ?? null, result: result ? { event_id: result.event_id, status: object(object(result.params).turn).status, replies: clip([...replies.values()], 600) } : { missing: 'Worker terminal result not observed.' } };
    });
    const failures = new Map();
    for (const event of workerEvents)
        for (const item of items(event))
            if (item.type === 'commandExecution' && (item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0))) {
                const signature = JSON.stringify([item.command, item.exitCode]);
                const turns = failures.get(signature) ?? new Set();
                turns.add(String(turnId(event)));
                failures.set(signature, turns);
            }
    const repeated = [...failures.entries()].filter(([, turns]) => turns.size >= 3).map(([signature, turns]) => ({ signature, count: turns.size }));
    const repeatedRecovery = (state.recovery_failures ?? [])
        .filter((failure) => failure.count >= 3)
        .map((failure) => ({ signature: failure.signature, count: failure.count, kind: failure.kind, message: failure.message }));
    const repeatedSignatures = [...repeated, ...repeatedRecovery];
    const recoveryInstruction = [...(state.recovery_failures ?? [])].findLast((failure) => failure.count >= 3)?.instruction;
    const snapshot = {
        snapshot_id: randomUUID(), task_id: state.task_id, task_version: state.task_version, worker_thread_id: state.worker_thread_id, worker_turn_id: workerTurnId,
        task: redact(state.task), evidence: [],
        plan: plans ? { observed: clip(plans, 1800), remaining: Array.isArray(plans) ? clip(plans.filter((entry) => object(entry).status !== 'completed'), 1800) : 'See observed worker plan; not independently verified.' } : { missing: 'No current plan or remaining-items update observed.' },
        recent_verification: verification ? clip(verification, 1800) : { missing: 'No independent verification result recorded yet.' },
        recent_instructions: instructions,
        repeated_failure: {
            investigate: repeatedSignatures.length > 0,
            signatures: repeatedSignatures,
            instruction: recoveryInstruction ?? (repeated.length ? 'Investigate a different hypothesis, check an authorized alternative provider or local artifact, or use a materially different verifiable route; retries alone never justify WAIT_EXTERNAL.' : 'No repeated failure threshold observed.'),
        },
        omissions: [], evidence_complete: true,
    };
    if (!plans)
        snapshot.omissions.push('Current plan and remaining items were not observed.');
    if (!verification)
        snapshot.omissions.push('Independent verification has not run.');
    if (JSON.stringify(snapshot).length > PROOF_BUDGET - 1800)
        throw new Error('Task contract and mandatory snapshot metadata exceed the 24000-character budget; goal, acceptance and authorization were not truncated.');
    const candidates = [...observed.values()].sort((left, right) => {
        const priority = (item) => item.type === 'commandExecution' && (item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)) ? 0 : item.type === 'fileChange' ? 1 : item.type === 'commandExecution' ? 2 : 3;
        return priority(left.item) - priority(right.item);
    });
    let omitted = 0;
    for (const { item, event } of candidates) {
        if (!['commandExecution', 'fileChange', 'functionCallOutput', 'agentMessage', 'plan'].includes(String(item.type)))
            continue;
        const entry = { id: `E${snapshot.evidence.length + 1}`, type: String(item.type), value: item, complete: true, source: { event_id: String(event.event_id), ...(typeof event.at === 'string' ? { observed_at: event.at } : {}), thread_id: state.worker_thread_id, turn_id: workerTurnId, item_id: String(item.id) } };
        snapshot.evidence.push(entry);
        if (JSON.stringify(snapshot).length > PROOF_BUDGET - 600) {
            snapshot.evidence_complete = false;
            entry.complete = false;
            snapshot.omissions.push(`${entry.id}: item payload truncated; full record is at source.event_id.`);
            for (const limit of [1800, 600, 160]) {
                entry.value = clip(item, limit);
                if (JSON.stringify(snapshot).length <= PROOF_BUDGET - 600)
                    break;
            }
            if (JSON.stringify(snapshot).length > PROOF_BUDGET - 600) {
                snapshot.evidence.pop();
                snapshot.omissions.pop();
                omitted++;
            }
        }
    }
    if (verification) {
        const value = clip(verification, 1800);
        const complete = JSON.stringify(value) === JSON.stringify(verification);
        if (!complete) {
            snapshot.evidence_complete = false;
            snapshot.omissions.push('Fixed verification output truncated; gather concise independent verification proof before a terminal decision.');
        }
        const entry = { id: `E${snapshot.evidence.length + 1}`, type: 'verification_result', value, complete, source: { event_id: String(verification.event_id), ...(typeof verification.at === 'string' ? { observed_at: verification.at } : {}) } };
        snapshot.evidence.push(entry);
        if (JSON.stringify(snapshot).length > PROOF_BUDGET - 600) {
            snapshot.evidence.pop();
            omitted++;
            snapshot.evidence_complete = false;
        }
    }
    if (omitted)
        snapshot.omissions.push(`${omitted} additional items omitted for budget; gather concise evidence before a terminal decision.`);
    return buildC2Context(snapshot, state);
}
