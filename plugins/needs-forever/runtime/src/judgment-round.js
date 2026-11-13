import { setTimeout as delay } from 'node:timers/promises';
import { AppServerJudge, archiveTerminatedJudge, validateDecision } from './judge.js';
import { connect } from './transport.js';
import { Store } from './store.js';
import { classifyRecoveryError, nextBackoff, recordRecoveryFailure, recoverySignature } from './recovery.js';
import { PlannerFallbackUnavailableError } from './route-execution.js';
import { redact } from './redact.js';
import { completionGate, continueWith } from './completion-gate.js';
const DEFAULT_MAX_ATTEMPTS = 3;
const ESCALATION_STRATEGIES = [
    { hypothesis_id: 'preserve-current-proof', resource_family: 'current-evidence', diagnostic_class: 'evidence_gap' },
    { hypothesis_id: 'discriminate-authorized-route', resource_family: 'authorized-route', diagnostic_class: 'route_discrimination' },
    { hypothesis_id: 'exclude-external-or-interrupt', resource_family: 'external-exclusion', diagnostic_class: 'external_dependency' },
];
function maxAttempts(fixture) {
    const configured = Number(fixture?.judgment_max_attempts);
    return Number.isInteger(configured) ? Math.min(DEFAULT_MAX_ATTEMPTS, Math.max(1, configured)) : DEFAULT_MAX_ATTEMPTS;
}
function strategyFor(attempt) {
    return ESCALATION_STRATEGIES[Math.min(attempt - 1, ESCALATION_STRATEGIES.length - 1)];
}
function roundState(state, request, limit) {
    return state.judgment_round?.stop_attempt_id === request.stop_attempt_id
        ? state.judgment_round
        : { stop_attempt_id: request.stop_attempt_id, attempt: 0, max_attempts: limit, status: 'running', attempts: [] };
}
function interruptionReason(round, lastError) {
    const failures = round.attempts.filter((entry) => entry.failure_kind).map((entry) => `${entry.failure_kind}:${entry.hypothesis_id}`).join(', ');
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    return `C 在同一个 native Stop 内达到 ${round.max_attempts} 次有界判断预算，未产生可验证方向；已尝试 ${failures || '无可用假设'}。最后失败：${message}。需要新的 native Stop 或明确人工恢复。`;
}
/**
 * Own one fresh, read-only C judgment round for one admitted native Stop.
 * B supplies the snapshot and fence; this module owns C transport, event
 * pumping, validation, archive cleanup and the completion gate handoff.
 */
export async function runJudgmentRound(context) {
    const { state, request, fixture, signal, store, snapshot, command } = context;
    store.snapshot(snapshot, null);
    const connection = await connect(command, state.task.workspace, signal);
    const timeout = state.mode === 'simulated' && Number.isFinite(fixture?.judge_timeout_ms) ? Math.max(1, Number(fixture.judge_timeout_ms)) : 120_000;
    const judge = new AppServerJudge(Math.min(timeout, Math.max(1, Date.parse(request.deadline_at) - Date.now() - 1_000)), connection.model);
    judge.bind(connection.rpc, (type, details) => {
        if (type === 'judge_created' && typeof details.thread_id === 'string') {
            state.judge_thread_ids ??= [];
            state.judge_thread_ids.push(details.thread_id);
            if (!signal.aborted && state.status === 'ACTIVE')
                store.save(state);
        }
        store.event(state, type, { ...details, stop_attempt_id: request.stop_attempt_id, main_session_id: state.main_session_id });
    }, (threadId) => archiveTerminatedJudge(command, state.task.workspace, threadId));
    connection.rpc.setRequestHandler((_id, method, params) => judge.serverRequest(method, params));
    const pump = (async () => {
        try {
            while (true) {
                const event = await connection.rpc.next();
                judge.observe(event.method, event.params);
            }
        }
        catch (error) {
            judge.connectionFailed(error);
        }
    })();
    try {
        let decision;
        try {
            const rawDecision = await judge.judge(snapshot, signal);
            const rawNextMessage = rawDecision.action === 'CONTINUE' ? rawDecision.next_message : null;
            decision = validateDecision(JSON.stringify(rawDecision), snapshot);
            if (rawNextMessage !== decision.next_message) {
                store.event(state, 'judge_decision_normalized', {
                    stop_attempt_id: request.stop_attempt_id,
                    snapshot_id: snapshot.snapshot_id,
                    plan_id: decision.route_plan?.plan_id ?? null,
                    selected_route_id: decision.route_plan?.selected_route_id ?? null,
                    raw_next_message: rawNextMessage,
                    canonical_next_message: decision.next_message,
                    reason: 'selected_route_actions_are_authoritative',
                });
            }
            store.snapshot(snapshot, judge.rawOutput, 'valid');
        }
        catch (error) {
            store.snapshot(snapshot, judge.rawOutput, 'invalid');
            if (!signal.aborted && judge.rawOutput && /evidence|worker claims|unknown evidence/i.test(error.message)) {
                decision = continueWith(snapshot, `Gather concise structured tool or file-check evidence for every original acceptance item (${state.task.acceptance.map((item) => item.id).join(', ')}). Check remaining authorized routes and implement unfinished work; a final assistant claim alone cannot establish completion or external waiting. Rejected audit: ${error.message}`, 'Supervisor terminal decision lacked sufficient independent evidence.');
            }
            else
                throw error;
        }
        signal.throwIfAborted();
        store.event(state, 'decision', { role: 'judge', thread_id: state.judge_thread_ids?.at(-1), snapshot_id: snapshot.snapshot_id, stop_attempt_id: request.stop_attempt_id, worker_thread_id: state.main_session_id, decision });
        decision = await completionGate({ state, snapshot, store, rpc: connection.rpc, signal }, decision);
        signal.throwIfAborted();
        return decision;
    }
    finally {
        await connection.rpc.close();
        await pump;
    }
}
/** C owns bounded retry, timeout recovery and deterministic fallback for one Stop. */
export async function runJudgmentPolicy(context) {
    const { state, request, fixture, signal, store, guarded, valid, snapshot, evaluate } = context;
    const limit = maxAttempts(fixture);
    let round = roundState(state, request, limit);
    round = { ...round, max_attempts: limit, status: 'running' };
    state.judgment_round = round;
    store.save(state);
    store.event(state, 'judge_round_started', { stop_attempt_id: request.stop_attempt_id, max_attempts: limit, owner: 'judgment-round' });
    for (let outputFailures = 0; outputFailures < limit; outputFailures++) {
        const attempt = outputFailures + 1;
        const strategy = strategyFor(attempt);
        const entry = { attempt, ...strategy };
        round = { ...round, attempt, attempts: [...round.attempts, entry], status: 'running' };
        state.judgment_round = round;
        store.save(state);
        store.event(state, 'judge_attempt_started', {
            stop_attempt_id: request.stop_attempt_id,
            attempt,
            max_attempts: limit,
            hypothesis_id: strategy.hypothesis_id,
            resource_family: strategy.resource_family,
            diagnostic_class: strategy.diagnostic_class,
            owner: 'judgment-round',
        });
        try {
            const currentSnapshot = snapshot();
            const decision = await evaluate(structuredClone(state), request, fixture, signal, guarded, currentSnapshot);
            if (!valid())
                return null;
            round = { ...round, status: 'succeeded' };
            state.judgment_round = round;
            state.retry = { kind: null, attempt: 0, next_at: null };
            store.save(state);
            store.event(state, 'judge_round_completed', { stop_attempt_id: request.stop_attempt_id, attempt, action: decision.action, owner: 'judgment-round' });
            return { decision, snapshot: currentSnapshot };
        }
        catch (error) {
            if (!valid() || signal.aborted) {
                store.event(state, 'judge_round_cancelled', { stop_attempt_id: request.stop_attempt_id, attempt, reason: signal.aborted ? 'abort_signal' : 'lifecycle_fence', owner: 'judgment-round' });
                return null;
            }
            const classification = classifyRecoveryError(error);
            const failedEntry = { ...entry, failure_kind: classification.kind, failure_signature: recoverySignature(error) };
            round = { ...round, attempts: [...round.attempts.slice(0, -1), failedEntry] };
            state.judgment_round = round;
            state.recovery_failures = redact(recordRecoveryFailure((state.recovery_failures ?? []), error));
            const backoff = nextBackoff(attempt);
            state.retry = { kind: classification.kind, attempt: backoff.attempt, next_at: backoff.next_at };
            store.save(state);
            store.event(state, 'judge_attempt_failed', {
                ...classification,
                ...backoff,
                stop_attempt_id: request.stop_attempt_id,
                attempt,
                max_attempts: limit,
                hypothesis_id: strategy.hypothesis_id,
                resource_family: strategy.resource_family,
                diagnostic_class: strategy.diagnostic_class,
                owner: 'judgment-round',
            });
            store.event(state, 'main_session_retry', { ...classification, ...backoff, stop_attempt_id: request.stop_attempt_id, owner: 'judgment-round', attempt, max_attempts: limit, hypothesis_id: strategy.hypothesis_id, resource_family: strategy.resource_family });
            if (attempt >= limit || !classification.recoverable) {
                const reason = interruptionReason(round, error);
                round = { ...round, status: 'interrupted', interruption_reason: reason };
                state.judgment_round = round;
                state.last_error = reason;
                store.save(state);
                store.event(state, 'judge_round_interrupted', { stop_attempt_id: request.stop_attempt_id, attempt, max_attempts: limit, reason, failures: round.attempts, owner: 'judgment-round' });
                throw new PlannerFallbackUnavailableError(reason);
            }
            const nextStrategy = strategyFor(attempt + 1);
            store.event(state, 'judge_escalation_required', { stop_attempt_id: request.stop_attempt_id, attempt, next_attempt: attempt + 1, previous_hypothesis_id: strategy.hypothesis_id, next_hypothesis_id: nextStrategy.hypothesis_id, previous_resource_family: strategy.resource_family, next_resource_family: nextStrategy.resource_family, reason: 'same-class failure requires a materially different hypothesis or discriminating check', owner: 'judgment-round' });
            const configuredDelay = state.mode === 'simulated' && Array.isArray(fixture?.recovery_delays_ms) ? Number(fixture.recovery_delays_ms[Math.min(outputFailures, fixture.recovery_delays_ms.length - 1)]) : backoff.delay_seconds * 1000;
            await delay(Math.min(Math.max(0, configuredDelay), Math.max(1, Date.parse(request.deadline_at) - Date.now())), undefined, { signal });
        }
    }
    return null;
}
