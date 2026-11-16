import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
export function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
export function stringValue(value) {
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
    if (type.startsWith('judge_') || type.startsWith('supervision_') || type.startsWith('provider_') || type === 'decision' || type.startsWith('verification_') || type.startsWith('recovery_') || type.startsWith('stale_') || type.startsWith('external_'))
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
    if (type === 'judge_round_interrupted' || type === 'recovery_interrupted')
        return 'INTERRUPTED';
    if (type === 'supervision_round_cancelled')
        return 'CANCELLED';
    if (type === 'supervision_round_confirmation_recorded')
        return 'CONFIRMED';
    return null;
}
function eventSummary(event) {
    const type = stringValue(event.type) ?? 'unknown';
    const rawDecision = decision(event);
    const action = stringValue(rawDecision?.action);
    const reason = stringValue(rawDecision?.reason);
    const error = stringValue(event.error) ?? stringValue(event.message);
    const eventReason = stringValue(event.reason) ?? error;
    const status = stringValue(event.status);
    switch (type) {
        case 'main_tool_result': return 'A 工具结果（不是 Stop 信号）';
        case 'main_session_stop_observed': return 'B 收到真实 Stop，触发 C';
        case 'stop_hook_direction_returned': return 'C 判断已返回 A';
        case 'main_session_continuation_confirmed': return 'A 已确认续接';
        case 'main_session_recovery_prompt_scheduled': return 'NF 已安排恢复 prompt';
        case 'main_session_recovery_prompt_attempted': return 'NF 开始推动 A 继续';
        case 'main_session_recovery_prompt_blocked': return 'NF 未启动第二个 Desktop app-server，等待原始 A 的 native 回执';
        case 'main_session_recovery_prompt_sent': return 'NF 已向 A 发送恢复 prompt';
        case 'main_session_recovery_prompt_acknowledged': return 'A thread 已接收 NF 恢复 prompt';
        case 'main_session_worker_prompt_observed': return 'A thread 已收到监督恢复 prompt';
        case 'main_session_recovery_waiting_native': return '等待原始 A 的受信任 native 回执';
        case 'main_session_recovery_prompt_deferred': return event.diagnosis === 'recovery_desktop_provider_unavailable'
            ? 'NF 不重复启动第二个 Desktop app-server，等待原始 A 的 native 回执'
            : 'A 已有进行中的回合，NF 暂缓发送';
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
        case 'judge_round_interrupted': return `C 判断明确中断${eventReason ? `：${eventReason}` : ''}`;
        case 'supervision_round_started': return 'B 已接纳一个 native Stop 监督轮次';
        case 'supervision_round_admitted': return 'B 已完成单次 admission';
        case 'supervision_round_delivery_recorded': return 'B 已记录单次 native 交付';
        case 'supervision_round_confirmation_recorded': return 'A 活动已确认';
        case 'supervision_round_cancelled': return `当前监督轮次已失效${eventReason ? `：${eventReason}` : ''}`;
        case 'provider_capability_probe': return event.available === true ? 'Desktop provider 已确认同线程能力' : 'Desktop provider 不可用，保持恢复等待';
        case 'provider_delivery_reconciled': return `Desktop delivery 已核对：${String(event.outcome ?? 'unknown')}`;
        case 'provider_delivery_sent': return `Desktop provider 已尝试同线程发送：${String(event.outcome ?? 'unknown')}`;
        case 'provider_recovery_active_writer': return '原始 A 有 active writer，provider 等待且不竞争写入';
        case 'provider_recovery_history_unreadable': return '原始 thread 历史不可读，provider 保持恢复等待';
        case 'provider_recovery_waiting': return 'delivery 尚未获得 A 活动确认，provider 保持恢复等待';
        case 'provider_recovery_unavailable': return 'Desktop provider 身份或 transport 不可用';
        case 'provider_recovery_attached': return 'Desktop provider 已附着原始 thread';
        case 'recovery_interrupted': return `自动恢复明确中断${eventReason ? `：${eventReason}` : ''}`;
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
export function safeEvents(path) {
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
export function displayMetadata(directory) {
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
export function displayTitle(directory, fallback) {
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
export class SessionIdAllocator {
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
export function stateView(state, title, sessionId) {
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
        supervisionRound: state.supervision_round ?? null,
        provider: state.provider ?? null,
    };
}
function resultForRound(round) {
    const candidates = round.technicalEvents.filter((event) => {
        return event.eventType === 'decision' || event.eventType === 'verification_result' || event.eventType === 'send_confirmed' || event.eventType === 'external_wait_required' || event.eventType === 'recovery_required' || event.eventType === 'paused' || event.eventType === 'judge_round_interrupted' || event.eventType === 'recovery_interrupted';
    });
    const result = candidates.at(-1) ?? round.technicalEvents.at(-1) ?? null;
    if (!result || result.eventType !== 'decision')
        return result;
    const rawDecision = asRecord(result.details.decision);
    const action = stringValue(rawDecision?.action);
    const summary = action === 'DONE' ? '任务完成判断' : action === 'WAIT_EXTERNAL' ? '任务进入外部等待' : action === 'CONTINUE' ? '任务继续推进' : 'supervisor 已返回判断';
    return { ...result, summary };
}
export function routeAuditForRound(round) {
    const event = round.supervisor.findLast((item) => item.eventType === 'decision' || item.eventType === 'judge_inventory_fallback');
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
export function makeRounds(events) {
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
export function isCompleteSupervisionRound(round) {
    // NFG is an audit view of completed A→B→C supervision cycles. A round
    // without a real supervisor event is still worker/controller activity and
    // must not be rendered as if C had been called.
    return round.supervisor.length > 0 && round.technicalEvents.some((event) => event.role === 'worker' || event.role === 'system');
}
export function isCompleteLiveSupervisionRound(round) {
    return round.stop !== null && isCompleteSupervisionRound(round);
}
export function snapshotIds(directory) {
    const path = resolve(directory, 'snapshots');
    if (!existsSync(path) || !statSync(path).isDirectory())
        return [];
    return readdirSync(path).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
}
export function taskDirectory(root, taskId) {
    if (!/^[\w.-]+$/.test(taskId) || taskId === '.' || taskId === '..')
        throw new Error('Invalid task id.');
    const directory = resolve(root, taskId);
    const suffix = relative(root, directory);
    if (!suffix || suffix.startsWith('..') || suffix.includes('\\') || suffix.includes('/'))
        throw new Error('Invalid task path.');
    return directory;
}
