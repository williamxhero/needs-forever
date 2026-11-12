import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function stringValue(value) {
    return typeof value === 'string' && value.length ? value : null;
}
function eventTime(event) {
    return stringValue(event.at) ?? new Date(0).toISOString();
}
function eventRole(event) {
    const role = stringValue(event.role);
    if (role === 'worker' || role === 'judge' || role === 'supervisor')
        return role === 'judge' ? 'supervisor' : role;
    const type = stringValue(event.type) ?? '';
    if (type === 'main_tool_result')
        return 'worker';
    if (type.startsWith('worker_') || type === 'send_prepared' || type === 'send_attempted' || type === 'send_confirmed')
        return 'worker';
    if (type.startsWith('judge_') || type === 'decision' || type.startsWith('verification_') || type.startsWith('recovery_') || type.startsWith('stale_') || type.startsWith('external_'))
        return 'supervisor';
    return 'system';
}
function decision(event) {
    return asRecord(event.decision);
}
function eventResult(event) {
    const type = stringValue(event.type) ?? '';
    const rawDecision = decision(event);
    const action = stringValue(rawDecision?.action);
    if (action)
        return action;
    const status = stringValue(event.status);
    if (type.startsWith('worker_') && status)
        return status;
    if (type === 'verification_result') {
        const passed = event.passed;
        if (typeof passed === 'boolean')
            return passed ? 'PASS' : 'FAIL';
    }
    if (type === 'send_confirmed')
        return 'CONFIRMED';
    if (type === 'external_wait_required')
        return 'WAIT_EXTERNAL';
    if (type === 'paused')
        return 'PAUSED';
    return null;
}
function eventSummary(event) {
    const type = stringValue(event.type) ?? 'unknown';
    const rawDecision = decision(event);
    const action = stringValue(rawDecision?.action);
    const reason = stringValue(rawDecision?.reason);
    const error = stringValue(event.error) ?? stringValue(event.message);
    const status = stringValue(event.status);
    switch (type) {
        case 'main_tool_result': return 'A 工具结果（不是 Stop 信号）';
        case 'main_session_stop_observed': return 'B 收到真实 Stop，触发 C';
        case 'stop_hook_direction_returned': return 'C 判断已返回 A';
        case 'main_session_continuation_confirmed': return 'A 已确认续接';
        case 'main_session_recovery_prompt_scheduled': return 'NF 已安排恢复 prompt';
        case 'main_session_recovery_prompt_attempted': return 'NF 开始推动 A 继续';
        case 'main_session_recovery_prompt_sent': return 'NF 已向 A 发送恢复 prompt';
        case 'main_session_recovery_prompt_acknowledged': return 'A thread 已接收 NF 恢复 prompt';
        case 'main_session_worker_prompt_observed': return 'A thread 已收到监督恢复 prompt';
        case 'main_session_recovery_prompt_deferred': return 'A 已有进行中的回合，NF 暂缓发送';
        case 'recovery_active_writer_window_extended': return '确认 A 仍在执行，NF 延长恢复等待窗口';
        case 'recovery_active_writer_window_capped': return 'A 的 active writer 等待已达到恢复上限';
        case 'main_session_recovery_prompt_failed': return error ? `NF 推动 A 失败：${error}` : 'NF 推动 A 失败';
        case 'worker_created': return 'worker 已创建';
        case 'worker_resumed': return 'worker 已恢复';
        case 'worker_started': return 'worker 开始工作';
        case 'worker_completed': return `worker 回合结束${status ? `，状态为 ${status}` : ''}`;
        case 'worker_interrupted': return 'worker 回合被中断';
        case 'worker_failed': return 'worker 回合失败';
        case 'worker_output': return 'worker 输出了一条结果';
        case 'decision': return `${action ? `判断为 ${action}` : 'supervisor 完成判断'}${reason ? `：${reason}` : ''}`;
        case 'send_prepared': return '已准备发送下一步指令';
        case 'send_attempted': return '已发送下一步指令，等待确认';
        case 'send_confirmed': return '下一轮已确认开始';
        case 'verification_result': return '独立验收已返回结果';
        case 'verification_started':
        case 'fixture_verification_started': return '开始独立验收';
        case 'verification_failed': return '独立验收失败';
        case 'external_wait_required': return '进入外部等待';
        case 'recovery_required': return error ? `需要恢复：${error}` : '需要恢复';
        case 'recovery_retry_scheduled': return error ? `已安排恢复重试：${error}` : '已安排恢复重试';
        case 'connection_reconnected': return '已重新连接 app-server';
        case 'connection_verified': return '已确认 app-server 连接';
        case 'stale_judge_result_ignored': return '迟到的判断结果已忽略';
        case 'stale_verification_result_ignored': return '迟到的验收结果已忽略';
        case 'paused': return '任务已暂停';
        case 'owned_calls_cancelled': return '已取消监督器持有的调用';
        case 'server_request': return `收到请求${stringValue(event.method) ? `：${event.method}` : ''}`;
        case 'server_request_answered': return `已处理请求${stringValue(event.method) ? `：${event.method}` : ''}`;
        default: return type.replaceAll('_', ' ');
    }
}
function humanEvent(event) {
    const type = stringValue(event.type) ?? 'unknown';
    return {
        at: eventTime(event),
        role: eventRole(event),
        eventType: type,
        summary: eventSummary(event),
        result: eventResult(event),
        details: event,
    };
}
function technicalEvent(event) {
    const base = humanEvent(event);
    return {
        ...base,
        threadId: stringValue(event.thread_id) ?? stringValue(event.worker_thread_id),
        turnId: stringValue(event.turn_id) ?? stringValue(event.worker_turn_id),
        deliveryId: stringValue(event.delivery_id),
        snapshotId: stringValue(event.snapshot_id),
    };
}
function safeEvents(path) {
    if (!existsSync(path))
        return [];
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
    const events = [];
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            const event = asRecord(parsed);
            if (event)
                events.push(event);
        }
        catch {
            // An append may be observed between writes. Ignore only the incomplete line.
        }
    }
    return events.sort((left, right) => eventTime(left).localeCompare(eventTime(right)));
}
function displayMetadata(directory) {
    const path = resolve(directory, 'display.json');
    if (!existsSync(path))
        return {};
    try {
        return asRecord(JSON.parse(readFileSync(path, 'utf8'))) ?? {};
    }
    catch {
        return {};
    }
}
function displayTitle(directory, fallback) {
    return stringValue(displayMetadata(directory).title) ?? fallback;
}
const sessionAlphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const sessionIdPattern = /^[0-9A-Z]{4}$/;
function seedSessionId(seed, offset = 0) {
    const digest = createHash('sha256').update(`${seed}:${offset}`).digest();
    let value = digest.readUInt32BE(0);
    let result = String(digest[4] % 10) + sessionAlphabet[10 + (digest[5] % 26)];
    for (let index = 0; index < 2; index++) {
        result = sessionAlphabet[value % sessionAlphabet.length] + result;
        value = Math.floor(value / sessionAlphabet.length);
    }
    return result.split('').reverse().join('');
}
class SessionIdAllocator {
    assigned = new Map();
    reusable = [];
    assign(taskId, status, seed, persisted) {
        const known = this.assigned.get(taskId);
        if (known) {
            if (known.status !== 'DONE' && status === 'DONE' && !this.reusable.includes(known.id))
                this.reusable.push(known.id);
            if (known.status === 'DONE' && status !== 'DONE') {
                const index = this.reusable.indexOf(known.id);
                if (index >= 0)
                    this.reusable.splice(index, 1);
            }
            known.status = status;
            return known.id;
        }
        const activeIds = new Set([...this.assigned.values()].filter((entry) => entry.status !== 'DONE').map((entry) => entry.id));
        let id = persisted && sessionIdPattern.test(persisted) ? persisted : '';
        if (!id || activeIds.has(id)) {
            while (this.reusable.length) {
                const reusable = this.reusable.shift();
                if (!activeIds.has(reusable)) {
                    id = reusable;
                    break;
                }
            }
        }
        if (!id || activeIds.has(id)) {
            for (let offset = 0;; offset++) {
                const candidate = seedSessionId(seed, offset);
                if (!activeIds.has(candidate) && ![...this.assigned.values()].some((entry) => entry.status !== 'DONE' && entry.id === candidate)) {
                    id = candidate;
                    break;
                }
            }
        }
        this.assigned.set(taskId, { id, status });
        if (status === 'DONE')
            this.reusable.push(id);
        return id;
    }
}
function optionalString(state, ...names) {
    for (const name of names) {
        const value = state[name];
        if (typeof value === 'string' && value.length)
            return value;
    }
    return null;
}
function recoveryView(state) {
    const value = state;
    const persisted = asRecord(value.recovery);
    const retry = state.retry ?? { kind: null, attempt: 0, next_at: null };
    const condition = state.recovery_condition;
    const explicitBoundary = optionalString(value, 'cancellation_boundary', 'cancellationBoundary')
        ?? (persisted ? optionalString(persisted, 'cancellation_boundary', 'cancellationBoundary') : null);
    const cancellationBoundary = state.status === 'INTERRUPTED' ? 'interrupted' : explicitBoundary === 'delete' || explicitBoundary === 'deleted'
        ? 'delete'
        : explicitBoundary === 'done' || state.status === 'DONE'
            ? 'done'
            : state.pause_reason === 'user_limit'
                ? 'user_limit'
                : state.pause_reason === 'user'
                    ? 'user_pause'
                    : 'none';
    const persistedSource = persisted ? optionalString(persisted, 'source', 'mode') : null;
    const source = cancellationBoundary === 'interrupted' ? 'interrupted' : cancellationBoundary === 'done' ? 'done'
        : cancellationBoundary === 'delete' ? 'delete'
            : cancellationBoundary === 'user_pause' ? 'user_pause'
                : cancellationBoundary === 'user_limit' ? 'user_limit'
                    : persistedSource === 'automatic' || persistedSource === 'user_pause' || persistedSource === 'user_limit' || persistedSource === 'delete' || persistedSource === 'done' ? persistedSource
                        : state.phase === 'RECOVERING' || (retry.attempt ?? 0) > 0 || condition || optionalString(value, 'recovery_reason', 'recoveryReason', 'recovery_kind', 'recoveryKind') ? 'automatic' : 'none';
    const reason = optionalString(value, 'recovery_reason', 'recoveryReason') ?? (persisted ? optionalString(persisted, 'reason', 'message') : null) ?? condition?.message ?? state.last_error ?? null;
    const kind = optionalString(value, 'recovery_kind', 'recoveryKind') ?? (persisted ? optionalString(persisted, 'kind') : null) ?? condition?.kind ?? retry.kind ?? null;
    const attemptValue = value.recovery_attempt ?? value.recoveryAttempt ?? persisted?.attempt ?? retry.attempt;
    const attempt = typeof attemptValue === 'number' && Number.isFinite(attemptValue) && attemptValue >= 0 ? attemptValue : 0;
    const nextRetryAt = optionalString(value, 'next_retry_at', 'nextRetryAt') ?? (persisted ? optionalString(persisted, 'next_retry_at', 'nextRetryAt') : null) ?? retry.next_at ?? null;
    const nativeReceiptValue = value.native_receipt ?? persisted?.native_receipt ?? persisted?.nativeReceipt;
    const nativeReceiptState = typeof nativeReceiptValue === 'string' ? { status: nativeReceiptValue } : nativeReceiptValue;
    const bindingStatus = value.binding?.status;
    const nativeReceipt = state.status === 'INTERRUPTED' ? 'not_required' : nativeReceiptState?.status === 'received' || nativeReceiptState?.status === 'bound' || bindingStatus === 'BOUND'
        ? 'received'
        : nativeReceiptState?.status === 'waiting' || nativeReceiptState?.status === 'pending' || bindingStatus === 'PENDING_NATIVE_HOOK' || /native[_ -]?(hook|receipt)/i.test(kind ?? '')
            ? 'waiting'
            : 'not_required';
    return { phase: state.phase, source, reason, kind, attempt, nextRetryAt, nativeReceipt, cancellationBoundary };
}
function stateView(state, title, sessionId) {
    const recovery = recoveryView(state);
    return {
        title,
        sessionId,
        taskId: state.task_id,
        status: state.status,
        phase: state.phase,
        mode: state.mode,
        goal: state.task.goal,
        workspace: state.task.workspace,
        acceptance: state.task.acceptance,
        workerThreadId: state.worker_thread_id,
        workerTurnCount: state.worker_turn_count,
        updatedAt: state.updated_at,
        lastDecision: state.last_decision,
        retry: state.retry,
        lastError: state.last_error ?? null,
        pauseReason: state.pause_reason ?? null,
        recoveryCondition: state.recovery_condition ?? null,
        recoveryPlan: state.recovery_plan ?? null,
        recovery,
        recoveryPhase: recovery.phase,
        recoverySource: recovery.source,
        recoveryReason: recovery.reason,
        recoveryAttempt: recovery.attempt,
        nextRetryAt: recovery.nextRetryAt,
        nativeReceipt: recovery.nativeReceipt,
        cancellationBoundary: recovery.cancellationBoundary,
    };
}
function resultForRound(round) {
    const candidates = round.technicalEvents.filter((event) => {
        return event.eventType === 'decision' || event.eventType === 'verification_result' || event.eventType === 'send_confirmed' || event.eventType === 'external_wait_required' || event.eventType === 'recovery_required' || event.eventType === 'paused';
    });
    const result = candidates.at(-1) ?? round.technicalEvents.at(-1) ?? null;
    if (!result || result.eventType !== 'decision')
        return result;
    const rawDecision = asRecord(result.details.decision);
    const action = stringValue(rawDecision?.action);
    const summary = action === 'DONE' ? '任务完成判断' : action === 'WAIT_EXTERNAL' ? '任务进入外部等待' : action === 'CONTINUE' ? '任务继续推进' : 'supervisor 已返回判断';
    return { ...result, summary };
}
function routeAuditForRound(round) {
    const event = round.supervisor.findLast((item) => item.eventType === 'decision');
    const value = asRecord(event?.details.decision);
    if (value?.action !== 'CONTINUE')
        return null;
    const plan = asRecord(value.route_plan);
    const strings = (input) => Array.isArray(input) ? input.filter((item) => typeof item === 'string') : [];
    if (!plan) {
        return {
            kind: 'legacy', planId: `legacy:${round.id}`, selectedRouteId: 'legacy-next-message',
            diagnosis: { class: 'legacy', statement: stringValue(value.reason) ?? '旧版未记录结构化诊断', evidenceIds: strings(value.evidence_ids) },
            selectionReason: '旧版仅记录单条续接指令，执行状态未验证。', singleRouteReason: '旧版历史未记录候选集。',
            candidates: [{
                    routeId: 'legacy-next-message', title: '旧版虚拟单路线', resource: '旧版续接指令', hypothesis: '旧版未记录', status: 'unknown',
                    evidenceIds: strings(value.evidence_ids), actions: [stringValue(value.next_message) ?? '旧版未记录续接指令'],
                    expectedEvidence: [], expectedSignal: '旧版未记录', risk: '旧版未记录',
                    fallback: { routeId: null, when: '旧版未记录' }, discriminatingCheck: null,
                }],
            successCondition: '旧版未记录', stopCondition: '旧版未记录',
        };
    }
    const diagnosis = asRecord(value.diagnosis);
    const candidates = [];
    for (const input of Array.isArray(plan.candidates) ? plan.candidates : []) {
        const candidate = asRecord(input);
        if (!candidate)
            continue;
        const resource = asRecord(candidate.resource);
        const fallback = asRecord(candidate.fallback);
        const check = asRecord(candidate.discriminating_check);
        const status = stringValue(candidate.status);
        candidates.push({
            routeId: stringValue(candidate.route_id) ?? 'unknown',
            title: stringValue(candidate.operation) ?? '未记录路线标题',
            resource: [stringValue(resource?.kind), stringValue(resource?.id)].filter(Boolean).join(': '),
            hypothesis: stringValue(candidate.hypothesis) ?? '',
            status: status === 'observed' || status === 'candidate' || status === 'blocked' || status === 'exhausted' || status === 'forbidden' ? status : 'unknown',
            evidenceIds: strings(candidate.evidence_ids),
            actions: strings(candidate.actions),
            expectedEvidence: strings(candidate.expected_evidence),
            expectedSignal: stringValue(candidate.expected_signal) ?? '',
            risk: stringValue(candidate.risk) ?? '',
            fallback: { routeId: stringValue(fallback?.route_id), when: stringValue(fallback?.when) ?? '' },
            discriminatingCheck: stringValue(check?.description),
        });
    }
    return {
        kind: 'c2', planId: stringValue(plan.plan_id) ?? 'unrecorded', selectedRouteId: stringValue(plan.selected_route_id) ?? 'unknown',
        diagnosis: { class: stringValue(diagnosis?.class) ?? 'unknown', statement: stringValue(diagnosis?.statement) ?? '未记录结构化诊断', evidenceIds: strings(diagnosis?.evidence_ids) },
        selectionReason: stringValue(plan.selection_reason) ?? '', singleRouteReason: stringValue(plan.single_route_reason), candidates,
        successCondition: stringValue(plan.success_condition) ?? '', stopCondition: stringValue(plan.stop_condition) ?? '',
    };
}
function makeRounds(events) {
    const stopAttemptsByTurn = new Map();
    const stopsByDelivery = new Map();
    const turnsByDelivery = new Map();
    const nativeStops = new Set(events.filter(raw => raw.type === 'main_session_stop_observed').map(raw => stringValue(raw.stop_attempt_id)));
    for (const raw of events) {
        const delivery = stringValue(raw.delivery_id);
        const stop = stringValue(raw.stop_attempt_id) ?? stringValue(raw.source_stop_attempt_id);
        if (delivery && ['send_prepared', 'stop_hook_direction_returned'].includes(String(raw.type))) {
            if (stop && nativeStops.has(stop))
                stopsByDelivery.set(delivery, stop);
            else if (typeof raw.source_turn_id === 'string')
                turnsByDelivery.set(delivery, raw.source_turn_id);
        }
    }
    for (const raw of events) {
        if (stringValue(raw.type) !== 'main_session_stop_observed')
            continue;
        const turnId = stringValue(raw.turn_id);
        const stopAttemptId = stringValue(raw.stop_attempt_id);
        if (!turnId || !stopAttemptId)
            continue;
        const attempts = stopAttemptsByTurn.get(turnId) ?? [];
        attempts.push({ at: eventTime(raw), stopAttemptId });
        stopAttemptsByTurn.set(turnId, attempts);
    }
    for (const attempts of stopAttemptsByTurn.values())
        attempts.sort((left, right) => left.at.localeCompare(right.at));
    const rounds = new Map();
    for (const raw of events) {
        const sourceStop = stringValue(raw.source_stop_attempt_id);
        const explicitStopAttempt = stringValue(raw.stop_attempt_id) ?? (sourceStop && nativeStops.has(sourceStop) && raw.type !== 'main_tool_result' ? sourceStop : null) ?? stopsByDelivery.get(String(raw.delivery_id)) ?? null;
        const turnId = stringValue(raw.turn_id) ?? stringValue(raw.worker_turn_id) ?? stringValue(raw.source_turn_id);
        const mappedAttempts = turnId ? stopAttemptsByTurn.get(turnId) ?? [] : [];
        const type = stringValue(raw.type) ?? '';
        const previousAttempt = [...mappedAttempts].reverse().find((attempt) => attempt.at <= eventTime(raw))?.stopAttemptId ?? null;
        const nextAttempt = mappedAttempts.find((attempt) => attempt.at >= eventTime(raw))?.stopAttemptId ?? null;
        const mappedStopAttempt = ['main_session_continuation_confirmed', 'send_confirmed'].includes(type) ? previousAttempt : nextAttempt;
        const id = explicitStopAttempt ? `stop:${explicitStopAttempt}` : turnsByDelivery.get(String(raw.delivery_id)) ?? (mappedStopAttempt ? `stop:${mappedStopAttempt}` : turnId ?? 'run');
        let round = rounds.get(id);
        if (!round) {
            const at = eventTime(raw);
            round = { id, startedAt: at, endedAt: at, worker: null, stop: null, supervisor: [], continuation: [], result: null, routeAudit: null, technicalEvents: [] };
            rounds.set(id, round);
        }
        round.startedAt = round.startedAt < eventTime(raw) ? round.startedAt : eventTime(raw);
        round.endedAt = round.endedAt > eventTime(raw) ? round.endedAt : eventTime(raw);
        const human = technicalEvent(raw);
        round.technicalEvents.push(human);
        if (human.eventType === 'main_session_stop_observed') {
            round.stop ??= human;
        }
        else if (human.eventType === 'stop_hook_direction_returned' || human.eventType === 'main_session_continuation_confirmed' || human.eventType === 'main_session_terminal' || human.eventType.startsWith('main_session_recovery_prompt_') || human.eventType === 'main_session_worker_prompt_observed') {
            round.continuation.push(human);
        }
        else if (human.role === 'worker') {
            round.worker ??= human;
        }
        else if (human.role === 'supervisor') {
            round.supervisor.push(human);
        }
    }
    return [...rounds.values()].map((round) => ({ ...round, result: resultForRound(round), routeAudit: routeAuditForRound(round) }));
}
function isCompleteSupervisionRound(round) {
    // NFG is an audit view of completed A→B→C supervision cycles. A round
    // without a real supervisor event is still worker/controller activity and
    // must not be rendered as if C had been called.
    return round.supervisor.length > 0 && round.technicalEvents.some((event) => event.role === 'worker' || event.role === 'system');
}
function isCompleteLiveSupervisionRound(round) {
    return round.stop !== null && isCompleteSupervisionRound(round);
}
function snapshotIds(directory) {
    const path = resolve(directory, 'snapshots');
    if (!existsSync(path) || !statSync(path).isDirectory())
        return [];
    return readdirSync(path).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
}
function taskDirectory(root, taskId) {
    if (!/^[\w.-]+$/.test(taskId) || taskId === '.' || taskId === '..')
        throw new Error('Invalid task id.');
    const directory = resolve(root, taskId);
    const suffix = relative(root, directory);
    if (!suffix || suffix.startsWith('..') || suffix.includes('\\') || suffix.includes('/'))
        throw new Error('Invalid task path.');
    return directory;
}
export class TaskCatalog {
    root;
    roots;
    sessionIds = new SessionIdAllocator();
    constructor(options) {
        this.roots = [...new Set([options.workspace, ...(options.workspaces ?? [])].map((workspace) => resolve(workspace, '.codex-supervisor')))];
        this.root = this.roots[0];
    }
    list() {
        const entries = [];
        for (const root of this.roots) {
            if (!existsSync(root) || !statSync(root).isDirectory())
                continue;
            for (const entry of readdirSync(root, { withFileTypes: true })) {
                // Windows explicit task views may be exposed through a junction. Keep
                // discovery read-only while allowing the linked state directory to be
                // rendered alongside ordinary .codex-supervisor task directories.
                if (!entry.isDirectory() && !entry.isSymbolicLink())
                    continue;
                try {
                    const record = this.readFromRoot(root, entry.name);
                    const result = record.state.lastDecision?.action ?? record.state.status;
                    entries.push({ title: record.title, sessionId: record.sessionId, taskId: record.taskId, status: record.state.status, phase: record.state.phase, updatedAt: record.updatedAt, lastResult: result });
                }
                catch {
                    // A task is only discoverable once its atomically written state is readable.
                }
            }
        }
        return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    locate(taskId) {
        for (const root of this.roots) {
            const directory = taskDirectory(root, taskId);
            if (existsSync(resolve(directory, 'state.json')))
                return { root, directory, workspace: resolve(root, '..') };
        }
        throw new Error('Task not found.');
    }
    read(taskId) {
        const located = this.locate(taskId);
        return this.readFromRoot(located.root, taskId);
    }
    readFromRoot(root, taskId) {
        const directory = taskDirectory(root, taskId);
        const statePath = resolve(directory, 'state.json');
        if (!existsSync(statePath))
            throw new Error('Task not found.');
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        if (!state.task || state.task_id !== taskId)
            throw new Error('Task state identity mismatch.');
        const title = displayTitle(directory, taskId);
        const metadata = displayMetadata(directory);
        const persistedSessionId = stringValue(metadata.session_id);
        const sessionSeed = stringValue(state.main_session_id) ?? state.worker_thread_id ?? stringValue(state.run_generation) ?? taskId;
        const sessionId = this.sessionIds.assign(`${root}:${taskId}`, state.status, sessionSeed, persistedSessionId ?? undefined);
        const events = safeEvents(resolve(directory, 'events.jsonl'));
        const summaryPath = resolve(directory, 'summary.md');
        const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
        const rounds = makeRounds(events).filter(state.mode === 'live' ? isCompleteLiveSupervisionRound : isCompleteSupervisionRound);
        return { title, sessionId, taskId, state: stateView(state, title, sessionId), summary, rounds, eventCount: events.length, snapshotIds: snapshotIds(directory), updatedAt: state.updated_at };
    }
}
function json(response, status, value) {
    const body = JSON.stringify(value);
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(body);
}
function body(request) {
    return new Promise((resolveBody, reject) => {
        let value = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { value += chunk; if (value.length > 64 * 1024)
            reject(new Error('Request body too large.')); });
        request.on('end', () => resolveBody(value));
        request.on('error', reject);
    });
}
function controlScriptPath() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/control.mjs');
}
function runControl(command, statePath, workspace, taskId, daemon) {
    if (daemon) {
        return fetch(`${daemon.url}/api/tasks/${encodeURIComponent(taskId)}/control`, { method: 'POST', headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: command }) })
            .then(async (response) => ({ code: response.ok ? 0 : response.status, stdout: await response.text(), stderr: response.ok ? '' : response.statusText }))
            .catch((error) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
    }
    return new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, [controlScriptPath(), command, '--state', statePath], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    });
}
function archiveDeletedTaskAudit(root, directory, taskId, statePath) {
    const auditDirectory = resolve(root, 'system-audit');
    mkdirSync(auditDirectory, { recursive: true });
    const eventsPath = resolve(directory, 'events.jsonl');
    const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '';
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    const audit = { event_id: randomUUID(), at: new Date().toISOString(), type: 'task_deleted', task_id: taskId, task_version: state?.task_version ?? null, status: state?.status ?? null, event_count: events.split('\n').filter(Boolean).length, preserved_events: events ? events.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [] };
    appendFileSync(resolve(auditDirectory, 'events.jsonl'), `${JSON.stringify(audit)}\n`, 'utf8');
}
function html(response) {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(WEB_HTML);
}
export async function startWebServer(options) {
    const workspaces = [...new Set([options.workspace, ...(options.workspaces ?? [])].map((workspace) => resolve(workspace)))];
    for (const workspace of workspaces)
        if (!existsSync(workspace) || !statSync(workspace).isDirectory())
            throw new Error('workspace must name an existing directory.');
    const workspace = workspaces[0];
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 8787;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('port must be an integer between 0 and 65535.');
    const catalog = new TaskCatalog({ workspace, workspaces });
    const server = createServer(async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
            response.setHeader('allow', 'GET, HEAD, POST');
            return json(response, 405, { error: 'method not allowed' });
        }
        let pathname;
        try {
            pathname = new URL(request.url ?? '/', `http://${host}`).pathname;
        }
        catch {
            return json(response, 400, { error: 'invalid url' });
        }
        if (pathname === '/healthz')
            return json(response, 200, { ok: true });
        if (pathname === '/api/tasks')
            return json(response, 200, { tasks: catalog.list() });
        if (pathname.startsWith('/api/tasks/')) {
            let taskId;
            try {
                taskId = decodeURIComponent(pathname.slice('/api/tasks/'.length));
            }
            catch {
                return json(response, 400, { error: 'invalid task id' });
            }
            if (request.method === 'POST' && taskId.endsWith('/control')) {
                taskId = taskId.slice(0, -'/control'.length);
                let action;
                try {
                    action = JSON.parse(await body(request));
                }
                catch {
                    return json(response, 400, { error: 'invalid json body' });
                }
                const operation = asRecord(action)?.action;
                if (operation !== 'pause' && operation !== 'resume' && operation !== 'delete')
                    return json(response, 400, { error: 'action must be pause, resume or delete' });
                try {
                    const located = catalog.locate(taskId);
                    const directory = located.directory;
                    const statePath = resolve(directory, 'state.json');
                    if (!existsSync(statePath))
                        return json(response, 404, { error: 'Task not found.' });
                    if (operation === 'delete') {
                        const paused = await runControl('pause', statePath, located.workspace, taskId, options.daemonApi && options.daemonToken ? { url: options.daemonApi, token: options.daemonToken } : undefined).catch(() => null);
                        if (paused && paused.code !== 0) {
                            let persistedStatus = null;
                            try {
                                persistedStatus = JSON.parse(readFileSync(statePath, 'utf8')).status;
                            }
                            catch { /* deletion below reports the real filesystem outcome */ }
                            if (persistedStatus !== 'PAUSED' && persistedStatus !== 'INTERRUPTED' && !/already paused|PAUSED/i.test(paused.stderr + paused.stdout))
                                return json(response, 409, { error: paused.stderr || paused.stdout || 'Unable to pause task before delete.' });
                        }
                        archiveDeletedTaskAudit(located.root, directory, taskId, statePath);
                        rmSync(directory, { recursive: true, force: true });
                        return json(response, 200, { deleted: true, taskId });
                    }
                    const result = await runControl(operation, statePath, located.workspace, taskId, options.daemonApi && options.daemonToken ? { url: options.daemonApi, token: options.daemonToken } : undefined);
                    if (result.code !== 0)
                        return json(response, 409, { error: result.stderr.trim() || result.stdout.trim() || `Unable to ${operation} task.` });
                    return json(response, 200, { action: operation, taskId, output: result.stdout });
                }
                catch (error) {
                    return json(response, 500, { error: error instanceof Error ? error.message : 'control operation failed' });
                }
            }
            if (request.method !== 'GET' && request.method !== 'HEAD')
                return json(response, 405, { error: 'method not allowed' });
            try {
                return json(response, 200, catalog.read(taskId));
            }
            catch (error) {
                return json(response, 404, { error: error instanceof Error ? error.message : 'task not found' });
            }
        }
        if (pathname === '/' || pathname.startsWith('/tasks/'))
            return html(response);
        return json(response, 404, { error: 'not found' });
    });
    await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(port, host, resolvePromise); });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Web server did not expose a TCP address.');
    const url = `http://${host}:${address.port}/`;
    return { server, url, close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())) };
}
const WEB_HTML = String.raw `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Needs Forever GUI</title>
<style>
:root{
  color-scheme:dark;
  --bg:#101416;--sidebar:#141a1d;--panel:#191f23;--surface:#20282d;--hover:#263138;
  --ink:#e7eeed;--muted:#afbfbe;--quiet:#8c9e9e;--line:#303c41;
  --accent:#79dcc5;--accent-soft:#203a35;--accent-line:#3c685e;
  --green:#93d8ab;--green-soft:#21392b;--green-line:#3c6249;
  --amber:#e9bd7b;--amber-soft:#382e20;
  --purple:#bdb0e9;--purple-soft:#302b40;
  --danger:#efa2ac;--danger-soft:#3c262d;--danger-line:#70434e;
  --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
}


*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px}
.app{height:100vh;min-height:0;display:grid;grid-template-columns:238px minmax(0,1fr)}
aside{padding:24px 14px;border-right:1px solid var(--line);background:var(--sidebar)}
.brand{display:flex;align-items:baseline;gap:9px;padding:0 10px 24px;white-space:nowrap;font-size:17px;font-weight:700;letter-spacing:-.03em}
.brand-forever{color:var(--accent)}
.brand-gui{color:var(--accent);font:italic 700 12px/1 var(--mono);letter-spacing:.1em}
.side-label{padding:0 10px 8px;color:var(--quiet);font-size:10px;letter-spacing:.12em;text-transform:uppercase}
.tasks{display:grid;gap:4px}
.task{min-width:0;width:100%;padding:10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted);text-align:left;cursor:pointer}
.refresh-icon{flex:0 0 22px;width:22px;height:22px;padding:0;border:1px solid var(--line);border-radius:7px;background:var(--panel);font:700 18px/1 ui-sans-serif;cursor:pointer}
.refresh-icon.on{color:var(--green);border-color:var(--green-line);background:var(--green-soft)}
.refresh-icon.off{color:var(--danger);border-color:var(--danger-line);background:var(--danger-soft)}
.task:hover{background:var(--hover)}
.task.selected{border-color:var(--accent-line);background:var(--accent-soft);color:var(--ink)}
.task-name{display:block;font-weight:650;line-height:1.35}
.task-session-id{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:18px;margin-right:6px;padding:0 4px;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--quiet);font:700 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.06em;vertical-align:middle;cursor:pointer;appearance:none}
.task-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:5px;color:var(--quiet);font-size:11px}
.task.selected .task-meta{color:var(--accent)}
.task-actions{display:flex;align-items:center;gap:8px;margin:0 0 12px;padding:8px 0;border-bottom:1px solid var(--line)}
.action-icon{width:32px;height:28px;padding:0;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--muted);font:700 14px/1 ui-sans-serif;cursor:pointer}
.action-icon.session-copy{width:auto;min-width:84px;padding:0 10px;font:700 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.04em}
.action-icon:hover{background:var(--accent-soft);color:var(--accent)}
.action-icon.danger{color:var(--danger)}
.action-icon.danger:hover{background:var(--danger-soft)}
.action-icon.on{color:var(--green);border-color:var(--green-line);background:var(--green-soft)}
.empty-side{padding:10px;color:var(--quiet);font-size:12px}
main{height:100%;min-width:0;min-height:0;overflow:hidden;padding:28px 34px 0}
.content{display:flex;flex-direction:column;width:min(1180px,100%);height:100%;min-height:0;margin:0 auto}
.project{margin:1px 0 20px;color:var(--muted);font-size:12px;font-weight:650;letter-spacing:.08em}
.top{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;margin-bottom:24px}
.title{min-width:0}
.title-row{display:block}
.title h1{display:inline;margin:0;font-size:30px;letter-spacing:-.045em}
.goal{max-width:680px;margin:8px 0 0;color:var(--muted);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{text-align:right;color:var(--muted);font-size:12px;line-height:1.55;max-width:52%}
.status-time{font-weight:650}
.status-reason{margin-top:4px;max-width:520px;color:var(--muted);line-height:1.45;overflow-wrap:anywhere}
.status{display:inline-flex;align-items:center;gap:6px;margin-bottom:6px;font-weight:700}
.status::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent)}
.status.done{color:var(--green)}
.status.done::before{background:var(--green)}
.status.wait{color:var(--purple)}
.status.wait::before{background:var(--purple)}
.status.paused{color:var(--muted)}
.status.paused::before{background:var(--quiet)}
.status.recover{color:var(--amber)}
.status.recover::before{background:var(--amber)}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:12px;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.filters{display:flex;gap:5px;flex-wrap:wrap}
.filter,.refresh{border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--muted);padding:6px 10px;font-size:12px;cursor:pointer}
.filter.active{border-color:var(--accent-line);background:var(--accent-soft);color:var(--accent);font-weight:650}
.refresh.on{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.timeline{display:grid;flex:1;min-height:0;gap:10px;overflow:auto;padding:0 2px 52px}
.round{border:1px solid var(--line);border-radius:11px;background:var(--panel);overflow:hidden}
.round-head{display:flex;align-items:baseline;gap:10px;flex-wrap:nowrap;padding:13px 16px;border-bottom:1px solid var(--line)}
.round-toggle{display:flex;align-items:center;gap:10px;min-width:0;border:0;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer}
.chevron{color:var(--quiet);font-size:15px}
.round-title{flex:0 0 auto;white-space:nowrap;font-weight:700}
.round-time{flex:0 0 auto;color:var(--quiet);font:12px/1.4 var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.round-body{display:block;padding:15px 16px}
.flow-line{margin:0 0 9px;color:var(--ink);line-height:1.45}
.flow-line strong{font-weight:700}
.step-time{margin-right:8px;color:var(--quiet);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}
.decision-block,.prompt-block{margin:0 0 14px;padding:10px 30px 10px 12px;overflow:hidden;border-radius:7px;background:var(--surface);color:var(--muted);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.collapsible{position:relative;width:100%;border:0;text-align:left;min-height:calc(1.5em + 20px);max-height:calc(1.5em + 20px);cursor:pointer}
.collapsible.expanded{max-height:none;overflow:auto}
.collapsible-content{white-space:pre-wrap}
.collapsible:not(.expanded) .collapsible-content{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.collapse-marker{position:absolute;top:8px;right:10px;color:var(--quiet);font:700 14px/1 ui-sans-serif}
.collapsible.expanded .collapse-marker{transform:rotate(180deg)}
.prompt-block{margin-bottom:0}
.column{min-width:0;padding:15px 16px}
.column+.column{border-left:1px solid var(--line)}
.column-label{margin-bottom:8px;color:var(--quiet);font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
.event-type{display:inline-block;margin-right:6px;color:var(--accent);font:650 11px ui-monospace,SFMono-Regular,Consolas,monospace}
.event-summary{color:var(--ink);line-height:1.45}
.event-result{margin-top:7px;color:var(--muted);font-size:12px}
.result-continue{color:var(--accent)}
.result-done{color:var(--green)}
.result-wait{color:var(--purple)}
.result-error{color:var(--amber)}
.message{margin-top:8px;padding:8px 10px;border-radius:7px;background:var(--surface);color:var(--muted);font-size:12px;line-height:1.45}
.round-details{display:none;padding:0 16px 16px;border-top:1px solid var(--line);background:var(--sidebar)}
.round.open .round-details{display:block}
.detail-event{padding:10px 0;border-bottom:1px solid var(--line)}
.detail-event:last-child{border-bottom:0}
.detail-row{display:flex;align-items:baseline;gap:9px}
.detail-role{color:var(--muted);font-size:11px}
.detail-time{margin-left:auto;color:var(--quiet);font:11px ui-monospace,SFMono-Regular,Consolas,monospace}
.detail-json{margin:7px 0 0;padding:9px;overflow:auto;border-radius:7px;background:var(--surface);color:var(--muted);font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}
.drawer{position:fixed;inset:0;display:none;background:rgba(0,0,0,.56)}
.drawer.open{display:block}
.drawer-panel{position:absolute;top:0;right:0;width:min(430px,92vw);height:100%;overflow:auto;padding:22px;background:var(--panel);box-shadow:-8px 0 24px rgba(0,0,0,.32)}
.drawer-close{float:right;border:0;background:transparent;color:var(--muted);font-size:22px;cursor:pointer}
.drawer h2{margin:4px 34px 18px 0;font-size:18px}
.drawer-section{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
.drawer-section h3{margin:0 0 8px;font-size:12px;color:var(--muted)}
.drawer-section p{margin:0;color:var(--ink);line-height:1.5}
.empty{padding:38px 16px;border:1px dashed var(--line);border-radius:11px;background:var(--panel);color:var(--muted);text-align:center}
.error{padding:14px;border-radius:8px;background:var(--amber-soft);color:var(--amber)}
@media(max-width:860px){.app{grid-template-columns:205px minmax(0,1fr)}
main{padding:24px 20px}
.round-body{grid-template-columns:1fr}
.column+.column{border-top:1px solid var(--line);border-left:0}
.meta{font-size:11px}
}
@media(max-width:620px){.app{display:flex;flex-direction:column;height:100vh}
aside{border-right:0;border-bottom:1px solid var(--line);padding:16px 12px}
.brand{padding-bottom:15px}
.tasks{display:flex;overflow:auto}
.task{min-width:165px}
main{height:auto;flex:1 1 auto;padding:20px 14px 0}
.top{display:block}
.meta{max-width:none;margin-top:14px;text-align:left}
.toolbar{align-items:flex-start;flex-direction:column}
}


button{font-family:inherit}

button:focus-visible,.task:focus-visible{outline:2px solid var(--accent);outline-offset:3px}

.task,.action-icon,.filter,.refresh,.refresh-icon,.collapsible{transition:background-color .16s ease,border-color .16s ease,color .16s ease}

.collapsible:hover{background:var(--hover)}

.task-name,.title h1{overflow-wrap:anywhere}

::selection{background:var(--accent);color:var(--bg)}

@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}
}
</style>
</head>
<body>
<div class="app"><aside><div class="brand"><span class="brand-name">Needs <span class="brand-forever">Forever</span></span><span class="brand-gui">GUI</span></div><div class="side-label">任务</div><div id="tasks" class="tasks"><div class="empty-side">正在读取任务…</div></div></aside>
<main><div class="content"><div id="error" class="error" hidden></div><section id="task-header" class="top" hidden><div class="title"><div class="title-row"><h1 id="task-title"></h1></div><p id="task-goal" class="goal"></p></div><div class="meta"><div id="task-status" class="status"></div><div id="task-meta"></div></div></section><div id="task-actions" class="task-actions" hidden></div><section id="timeline" class="timeline"><div class="empty">选择一个任务查看监督记录。</div></section></div></main></div>
<div id="drawer" class="drawer"><aside class="drawer-panel"><button id="drawer-close" class="drawer-close" aria-label="关闭">×</button><h2 id="drawer-title">轮次详情</h2><div id="drawer-content"></div></aside></div>
<script>
const app={taskId:new URL(location.href).pathname.match(/^\/tasks\/([^/]+)/)?.[1]||null,record:null,filter:'all',auto:true,refreshing:false};
const $=s=>document.querySelector(s); const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusLabel={ACTIVE:'正在推进',WAIT_EXTERNAL:'等待外部条件',PAUSED:'已暂停',DONE:'已完成',INTERRUPTED:'已中断'};
function statusClass(s,p){return s==='DONE'?'done':s==='WAIT_EXTERNAL'?'wait':(s==='PAUSED'||s==='INTERRUPTED')?'paused':p==='RECOVERING'?'recover':''}
function statusText(s,p){return s==='ACTIVE'&&p==='RECOVERING'?'恢复中':statusLabel[s]||s}
function shortTime(v){try{return new Date(v).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch{return v}}
function resultClass(v){return v==='DONE'?'result-done':v==='WAIT_EXTERNAL'?'result-wait':v==='CONTINUE'?'result-continue':v==='FAIL'?'result-error':''}
function roleName(v){return v==='supervisor'?'supervisor':v==='worker'?'worker':'系统'}
async function copySessionId(button){const value=button.dataset.sessionId||'';if(!value)return;const copyValue='NF://'+value;try{await navigator.clipboard.writeText(copyValue)}catch{const input=document.createElement('textarea');input.value=copyValue;input.style.position='fixed';input.style.opacity='0';document.body.appendChild(input);input.focus();input.select();document.execCommand('copy');input.remove()}const previous=button.title;button.title='已复制：'+copyValue;button.classList.add('copied');setTimeout(()=>{button.title=previous;button.classList.remove('copied')},3000)}
function wireSessionCopy(){document.querySelectorAll('[data-session-copy]').forEach(button=>{button.onclick=(event)=>{event.preventDefault();event.stopPropagation();void copySessionId(button)}})}function renderTasks(tasks){const root=$('#tasks');if(!tasks.length){root.innerHTML='<div class="empty-side">暂无可发现的任务</div>';return}root.innerHTML=tasks.map(t=>'<div class="task '+(t.taskId===app.taskId?'selected':'')+'" data-task="'+esc(t.taskId)+'"><span class="task-name">'+esc(t.title||t.taskId)+'</span><span class="task-meta"><span>'+esc(statusText(t.status,t.phase))+'</span><span>'+esc(shortTime(t.updatedAt))+'</span></span></div>').join('');root.querySelectorAll('[data-task]').forEach(b=>b.onclick=()=>{app.taskId=b.dataset.task;history.pushState({},'', '/tasks/'+encodeURIComponent(app.taskId));loadRecord()})}
function eventHtml(ev){return '<div><span class="event-type">'+esc(ev.eventType)+'</span><span class="event-summary">'+esc(ev.summary)+'</span></div>'+(ev.result?'<div class="event-result '+resultClass(ev.result)+'">'+esc(ev.result)+'</div>':'')}
function matches(round){if(app.filter==='all')return true;const values=round.technicalEvents; if(app.filter==='worker')return values.some(e=>e.role==='worker');if(app.filter==='supervisor')return values.some(e=>e.role==='supervisor');return values.some(e=>e.result==='FAIL'||e.eventType.startsWith('recovery_')||e.eventType.startsWith('stale_')||e.eventType==='external_wait_required'||e.eventType==='paused')}
function shortDate(v){try{const d=new Date(v);if(Number.isNaN(d.getTime()))return v;return d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')}catch{return v}}
function shortHourMinute(v){try{const d=new Date(v);if(Number.isNaN(d.getTime()))return v;return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}catch{return v}}
function collapsibleHtml(className,text,key){return '<button type="button" class="'+className+' collapsible" data-collapsible data-collapsible-key="'+esc(key)+'" aria-expanded="false"><span class="collapsible-content">'+esc(text)+'</span><span class="collapse-marker" aria-hidden="true">⌄</span></button>'}
const routeStatusLabel={observed:'已观测',candidate:'候选（未验证）',blocked:'受阻',exhausted:'已耗尽',forbidden:'禁止',unknown:'未知（未验证）'};
function routeHtml(r,key){
  const audit=r.routeAudit;if(!audit)return '';
  const selected=audit.candidates.find(c=>c.routeId===audit.selectedRouteId);
  const lines=['路线 '+audit.selectedRouteId+' · '+(selected?.title||'未记录路线标题')+' · '+audit.diagnosis.statement,
    '诊断：'+audit.diagnosis.class+' · '+audit.diagnosis.statement,
    '诊断证据：'+(audit.diagnosis.evidenceIds.join('、')||'未记录独立证据'),
    '选择原因：'+audit.selectionReason];
  if(audit.singleRouteReason)lines.push('单路线原因：'+audit.singleRouteReason);
  for(const candidate of audit.candidates){
    lines.push('',candidate.routeId+(candidate.routeId===audit.selectedRouteId?'（选定）':'')+' · '+(routeStatusLabel[candidate.status]||routeStatusLabel.unknown)+' · '+candidate.title,
      '资源：'+(candidate.resource||'未记录'),'假设：'+candidate.hypothesis,
      '证据：'+(candidate.evidenceIds.join('、')||'未记录独立证据'),
      '动作：'+candidate.actions.join('；'),'预期证据：'+candidate.expectedEvidence.join('；'),
      '预期信号：'+candidate.expectedSignal,'风险：'+candidate.risk,
      'fallback：'+(candidate.fallback.routeId||'重新规划')+' · '+candidate.fallback.when);
    if(candidate.discriminatingCheck)lines.push('区分检查：'+candidate.discriminatingCheck);
  }
  lines.push('','成功条件：'+audit.successCondition,'停止条件：'+audit.stopCondition);
  return collapsibleHtml('decision-block route-block',lines.join('\n'),key+':route:'+audit.planId);
}
function roundHtml(r,index){
  const decisionEvent=r.supervisor.findLast(e=>e.eventType==='decision'||e.eventType==='judge_inventory_fallback');
  const lastJudge=r.supervisor.findLast(e=>e.eventType.startsWith('judge_'));
  const timeouts=r.supervisor.filter(e=>e.eventType==='judge_terminated'&&/timeout|超时/i.test(JSON.stringify(e.details)));
  const decisionValue=decisionEvent?.details.decision;
  const action=decisionValue?.action||(timeouts.length?'超时':'未完成');
  const decisionText=decisionValue?.reason||(timeouts.length?'SUPERVISOR '+timeouts.length+' 次判断超时，未产生有效 decision。':'尚未产生有效 SUPERVISOR 判断。');
  const recoverySent=r.continuation.find(e=>e.eventType==='main_session_recovery_prompt_sent');
  const recoveryAck=r.continuation.find(e=>e.eventType==='main_session_recovery_prompt_acknowledged');
  const observedPrompt=r.continuation.findLast(e=>e.eventType==='main_session_worker_prompt_observed'&&typeof e.details.message==='string'&&e.details.message.length>0);
  const recoveryFailure=r.continuation.findLast(e=>e.eventType==='main_session_recovery_prompt_failed');
  const ordinarySent=r.technicalEvents.findLast(e=>e.eventType==='send_prepared'&&e.deliveryId&&r.technicalEvents.some(s=>s.eventType==='send_confirmed'&&s.deliveryId===e.deliveryId));
  const ordinaryConfirmation=ordinarySent&&r.technicalEvents.find(e=>e.eventType==='send_confirmed'&&e.deliveryId===ordinarySent.deliveryId);
  // A direction returned by the hook is only a proposal.  It does not prove
  // that A received a prompt.  The Worker received row must be backed by an
  // observed prompt, an acknowledged recovery delivery, or a confirmed
  // ordinary delivery with its prepared message.
  const acknowledgedRecovery = recoveryAck && (
    typeof recoveryAck.details.message==='string' && recoveryAck.details.message.length>0
      ? recoveryAck
      : recoverySent && recoveryAck.deliveryId && recoverySent.deliveryId===recoveryAck.deliveryId && typeof recoverySent.details.message==='string' && recoverySent.details.message.length>0
        ? recoverySent
        : null
  );
  const deliveredPrompt = observedPrompt
    ? { event: observedPrompt, message: String(observedPrompt.details.message) }
    : acknowledgedRecovery
      ? { event: recoveryAck, message: typeof acknowledgedRecovery.details.message==='string' ? acknowledgedRecovery.details.message : String(recoverySent.details.message) }
      : ordinaryConfirmation && ordinarySent && typeof ordinarySent.details.message==='string' && ordinarySent.details.message.length>0
        ? { event: ordinaryConfirmation, message: String(ordinarySent.details.message) }
        : null;
  const prompt=deliveredPrompt?.message||'';
  const stopAt=r.stop?.at||r.endedAt;
  const decisionAt=decisionEvent?.at||lastJudge?.at||stopAt;
  const returnedAt=deliveredPrompt?.event.at;
  const stopReason=typeof r.stop?.details.stop_reason==='string'?r.stop.details.stop_reason:'';
  const key=JSON.stringify([app.taskId,r.id]);
  const stepTime=v=>'<span class="step-time">'+esc(shortHourMinute(v))+'</span>';
  const recoveryFailureReason=recoveryFailure&&((typeof recoveryFailure.details.error==='string'&&recoveryFailure.details.error)|| (typeof recoveryFailure.details.message==='string'&&recoveryFailure.details.message)||'');
  const recoveryLine=(recoverySent?'<div class="flow-line">'+stepTime(recoverySent.at)+' <strong>NF 推动 A：</strong> <span class="event-result">已发送恢复 prompt</span></div>':'')+(recoveryFailure?'<div class="flow-line">'+stepTime(recoveryFailure.at)+' <strong>NF 推动 A：</strong> <span class="event-result result-error">发送失败'+(recoveryFailureReason?'：'+esc(recoveryFailureReason):'')+'</span></div>':'');
  const recoveryAckLine=recoveryAck?'<div class="flow-line">'+stepTime(recoveryAck.at)+' <strong>A thread：</strong> <span class="event-result">已接收恢复 prompt</span></div>':'';
  return '<article class="round" data-round="'+esc(r.id)+'"><div class="round-head"><span class="round-title">第 '+(index+1)+' 轮</span><span class="round-time">'+esc(shortDate(stopAt))+'</span></div><div class="round-body"><div class="flow-line">'+stepTime(stopAt)+' <strong>WORKER 发出：</strong> <span class="event-result">Stop</span></div>'+(stopReason?collapsibleHtml('decision-block stop-reason-block',stopReason,key+':stop'):'')+'<div class="flow-line">'+stepTime(decisionAt)+' <strong>SUPERVISOR 判断：</strong> <span class="event-result">'+esc(action)+'</span></div>'+collapsibleHtml('decision-block',decisionText,key+':decision')+routeHtml(r,key)+'<div class="flow-line">'+(returnedAt?stepTime(returnedAt)+' ':'')+'<strong>WORKER 收到：</strong>'+(prompt?'':' <span class="event-result">未交付</span>')+'</div>'+(prompt?collapsibleHtml('prompt-block',prompt,key+':prompt'):'')+recoveryLine+recoveryAckLine+'</div></article>';
}
function setExpanded(node,expanded){node.classList.toggle('expanded',expanded);node.setAttribute('aria-expanded',String(expanded));const marker=node.querySelector('.collapse-marker');if(marker)marker.textContent=expanded?'⌃':'⌄'}
function wireCollapsibles(){document.querySelectorAll('[data-collapsible]').forEach(node=>{node.onclick=()=>setExpanded(node,!node.classList.contains('expanded'))})}
function statusDateTime(v){try{const d=new Date(v);if(Number.isNaN(d.getTime()))return v;return String(d.getFullYear()).slice(-2)+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}catch{return v}}
function expandedKeys(){return new Set([...document.querySelectorAll('[data-collapsible].expanded')].map(node=>node.dataset.collapsibleKey).filter(Boolean))}
function restoreExpanded(keys){document.querySelectorAll('[data-collapsible]').forEach(node=>setExpanded(node,keys.has(node.dataset.collapsibleKey)))}
function actionButtonHtml(action,label,icon,className=''){return '<button type="button" class="action-icon '+className+'" data-action="'+action+'" aria-label="'+label+'" title="'+label+'">'+icon+'</button>'}
function renderActions(r){const root=$('#task-actions');if(!r){root.hidden=true;root.innerHTML='';return}root.hidden=false;const paused=r.state.status==='PAUSED'||r.state.status==='INTERRUPTED';root.innerHTML=actionButtonHtml('copy','复制 session ID：'+r.sessionId,r.sessionId,'session-copy')+actionButtonHtml('refresh','当前自动刷新：'+(app.auto?'开':'关'),app.auto?'↻':'Ⅱ',app.auto?'on':'')+actionButtonHtml(paused?'resume':'pause',paused?'恢复 Needs Forever':'停止 Needs Forever',paused?'▶':'Ⅱ')+actionButtonHtml('delete','删除此监督及其 NFG 记录','×','danger');const copyButton=root.querySelector('[data-action="copy"]');if(copyButton){copyButton.dataset.sessionCopy='';copyButton.dataset.sessionId=r.sessionId}wireActions();wireSessionCopy()}
async function controlTask(action){if(!app.taskId)return;if(action==='delete'&&!window.confirm('删除此监督及其 NFG 记录？系统级日志不会删除。'))return;const response=await fetch('/api/tasks/'+encodeURIComponent(app.taskId)+'/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});const result=await response.json();if(!response.ok)throw new Error(result.error||'控制操作失败');if(action==='delete'){app.record=null;app.taskId=null;history.replaceState({},'', '/');renderRecord();await loadTasks();return}await loadTasks();await loadRecord(false)}
function wireActions(){document.querySelectorAll('[data-action]').forEach(button=>{button.onclick=(event)=>{event.preventDefault();event.stopPropagation();const action=button.dataset.action;if(action==='copy'){const value=app.record?.sessionId||'';button.dataset.sessionId=value;void copySessionId(button);return}if(action==='refresh'){app.auto=!app.auto;renderActions(app.record);return}if(action==='pause'||action==='resume'||action==='delete'){void controlTask(action).catch(error=>{$('#error').textContent=error.message;$('#error').hidden=false})}}})}function recoveryHtml(r){const recovery=r.state.recovery;if(!recovery||recovery.source==='none'||recovery.source==='interrupted')return '';const source={automatic:'自动恢复',user_pause:'人工暂停',user_limit:'达到人工限制',delete:'已删除',done:'已完成'}[recovery.source]||recovery.source;const parts=[source];if(recovery.reason)parts.push(recovery.reason);if(recovery.attempt>0)parts.push('尝试 '+recovery.attempt);if(recovery.nextRetryAt)parts.push('下次重试 '+statusDateTime(recovery.nextRetryAt));if(recovery.nativeReceipt==='waiting')parts.push('等待 native receipt');else if(recovery.nativeReceipt==='received')parts.push('native receipt 已确认');return '<div class="status-reason">'+esc(parts.join(' · '))+'</div>'}function renderRecord(preserve=false){const r=app.record;const expanded=preserve?expandedKeys():new Set();if(!r){$('#task-header').hidden=true;renderActions(null);$('#timeline').innerHTML='<div class="empty">选择一个任务查看监督记录。</div>';return}$('#task-header').hidden=false;$('#task-title').textContent=r.title||r.taskId;$('#task-goal').textContent=r.state.goal;const s=$('#task-status');s.textContent=(statusText(r.state.status,r.state.phase))+' '+statusDateTime(r.updatedAt);s.className='status '+statusClass(r.state.status,r.state.phase);const reason=r.state.lastError||r.state.recoveryCondition?.message||'';$('#task-meta').innerHTML=(reason?'<div class="status-reason">'+esc(reason)+'</div>':'')+recoveryHtml(r);const rounds=r.rounds.filter(matches);$('#timeline').innerHTML=rounds.length?rounds.map((x,i)=>roundHtml(x,i)).join(''):'<div class="empty">暂无完整 A→B→C 监督轮次。</div>';wireCollapsibles();restoreExpanded(expanded);renderActions(r);$('#timeline').querySelectorAll('.round-toggle').forEach(b=>b.onclick=()=>b.closest('.round').classList.toggle('open'));}async function loadTasks(){const response=await fetch('/api/tasks',{cache:'no-store'});if(!response.ok)throw new Error('读取任务列表失败');const data=await response.json();renderTasks(data.tasks||[]);if(!app.taskId&&data.tasks?.[0]){app.taskId=data.tasks[0].taskId;history.replaceState({},'', '/tasks/'+encodeURIComponent(app.taskId))}return data.tasks||[]}
async function loadRecord(preserve=false){if(!app.taskId){renderRecord(preserve);return}const response=await fetch('/api/tasks/'+encodeURIComponent(app.taskId),{cache:'no-store'});if(!response.ok)throw new Error((await response.json()).error||'读取任务失败');const next=await response.json();const changed=JSON.stringify(app.record)!==JSON.stringify(next);app.record=next;if(changed||!preserve)renderRecord(preserve)}
async function load(){try{$('#error').hidden=true;await loadTasks();if(app.taskId)await loadRecord(false)}catch(e){$('#error').textContent=e.message;$('#error').hidden=false}}
async function refresh(){if(app.refreshing)return;app.refreshing=true;try{$('#error').hidden=true;await loadTasks();if(app.taskId)await loadRecord(true)}catch(e){$('#error').textContent=e.message;$('#error').hidden=false}finally{app.refreshing=false}}
$('#drawer-close').onclick=()=>$('#drawer').classList.remove('open');window.onpopstate=()=>{app.taskId=new URL(location.href).pathname.match(/^\/tasks\/([^/]+)/)?.[1]||null;load()};setInterval(()=>{if(app.auto)refresh()},1500);load();
</script>
</body></html>`;
