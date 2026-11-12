import { readdirSync } from 'node:fs';
import { activeRouteCatalog, RouteCatalog } from './route-catalog.js';
import { RouteLedger, canonicalExecutionRoute, routeEvidenceDigest } from './route-ledger.js';
import { routeInventoryDecision } from './planning.js';
import { validateDecision } from './judge.js';
import type { Decision, RouteCorrelation, Snapshot, State } from './types.js';
import type { RouteEvidence } from './route-contract.js';
import { ingestRouteObservations, probeWorkspaceArtifact } from './route-observations.js';
import { ingestHttpRouteProbes } from './http-route-probe.js';
import { redact } from './redact.js';
const scope = (state: State) => ({ task_id: state.task_id, task_version: state.task_version });
function lifecycleFence(state: State): string {
  const native = state as State & { run_generation?: string; input_epoch?: number; contract_sha256?: string };
  return JSON.stringify([state.task_version, native.run_generation ?? null, native.input_epoch ?? null, native.contract_sha256 ?? null]);
}
function observedRetryAt(value: unknown, observedAt: string, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string' && value.length <= 8_000) { try { return observedRetryAt(JSON.parse(value), observedAt, depth + 1); } catch { return null; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const field of ['retry_at', 'retry_after']) if (typeof record[field] === 'string' && Number.isFinite(Date.parse(record[field]))) return new Date(record[field]).toISOString();
  const seconds = record.retry_after_seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) return new Date(Date.parse(observedAt) + seconds * 1000).toISOString();
  for (const entry of Object.values(record).slice(0, 32)) { const retry = observedRetryAt(entry, observedAt, depth + 1); if (retry) return retry; }
  return null;
}

export function routeCorrelation(value?: RouteCorrelation | null): RouteCorrelation {
  return value?.plan_id ? { plan_id: value.plan_id, ...(value.route_id ? { route_id: value.route_id } : {}), ...(value.source_stop_attempt_id ? { source_stop_attempt_id: value.source_stop_attempt_id } : {}) } : {};
}
/** B reads only bounded local regular files. Contents are hashed, never sent to C.
 * Credentials, symlinks, networking and configured provider names prove nothing. */
export function discoverLocalRoutes(state: State): void {
  const catalog = new RouteCatalog(scope(state), { data: activeRouteCatalog(state) });
  let files: string[];
  try { files = readdirSync(state.task.workspace).sort().filter((name) => !name.startsWith('.') && !/(?:secret|credential|token|password|auth|cookie|private|\.pem$|\.key$)/i.test(name)).slice(0, 32); }
  catch { state.route_catalog = catalog.toJSON(); return; }
  let observed = 0;
  for (const name of files) {
    if (observed >= 4) break;
    try {
      const evidence = probeWorkspaceArtifact(state, name);
      if (!evidence) continue;
      const refs = [evidence.id];
      catalog.upsert({ inventory_only: true, route_id: `local-artifact:${name}`, resource: { kind: 'artifact', id: name }, operation: 'read-local-artifact', status: 'observed', authorization: { status: 'authorized', evidence_ids: refs }, network: { required: false, available: null, evidence_ids: refs }, authentication: { status: 'not_required', evidence_ids: refs }, rate_limit: { status: 'clear', retry_at: null, evidence_ids: refs }, last_success: { at: evidence.observed_at, evidence_ids: refs }, capabilities: ['Completed bounded local inspection; relevance and completeness remain unverified. This is not evidence of remaining executable task work.'], evidence: [evidence] });
      observed++;
    } catch { /* A racing/missing/locked file is not an observed capability. */ }
  }
  state.route_catalog = catalog.toJSON();
  state.route_ledger = new RouteLedger(scope(state), state.route_ledger ? { data: state.route_ledger } : {}).toJSON();
}
export function prepareRouteExecution(state: State, decision: Decision, snapshot: Snapshot, deliveryId: string, sourceStopId: string, options: { plannerFallback?: boolean } = {}): RouteCorrelation {
  if (snapshot.task_id !== state.task_id || snapshot.task_version !== state.task_version || routeEvidenceDigest(snapshot.task) !== routeEvidenceDigest(redact(state.task))) throw new Error('Route admission rejected stale task scope/version or contract.');
  if (snapshot.c2) snapshot = { ...snapshot, c2: { ...snapshot.c2, catalog: activeRouteCatalog(state) } };
  const plannerFallback = options.plannerFallback === true;
  decision = validateDecision(JSON.stringify(decision), snapshot, { allowPlannerFallback: plannerFallback });
  if (!decision.route_plan) return {};
  const route = decision.route_plan.candidates.find((candidate) => candidate.route_id === decision.route_plan!.selected_route_id)!;
  const canonical = canonicalExecutionRoute(route, state.route_catalog?.entries ?? []);
  const evidence = structuredClone(snapshot.c2?.observations.filter((item) => route.evidence_ids.includes(item.id)) ?? []);
  const ledger = new RouteLedger(scope(state), state.route_ledger ? { data: state.route_ledger } : {});
  const permission = ledger.evaluateAttempt(canonical, { evidence_ids: route.evidence_ids, evidence, ...(route.discriminating_check ? { discriminating_check: route.discriminating_check } : {}) });
  const boundedDiagnostic = route.resource.kind === 'diagnostic' && route.operation === 'inspect-authorized-route-facts';
  if (!permission.allowed && !(plannerFallback && boundedDiagnostic && ['change_hypothesis', 'no_progress_limit', 'retry_condition_required', 'retry_not_ready'].includes(permission.reason))) {
    throw new Error(`C2 repeated route rejected at delivery admission: ${permission.reason}.`);
  }
  const correlation = { plan_id: decision.route_plan.plan_id, route_id: route.route_id, source_stop_attempt_id: sourceStopId };
  state.route_execution = { ...correlation, delivery_id: deliveryId, task_version: state.task_version, lifecycle_fence: lifecycleFence(state), route: structuredClone(canonical), evidence, confirmed: false, ...(plannerFallback ? { planner_fallback: true } : {}), ...(route.discriminating_check ? { discriminating_check: structuredClone(route.discriminating_check) } : {}) };
  return correlation;
}
export function confirmRouteExecution(state: State, deliveryId: string): void {
  if (state.route_execution?.delivery_id === deliveryId && state.route_execution.task_version === state.task_version && state.route_execution.lifecycle_fence === lifecycleFence(state)) state.route_execution.confirmed = true;
}
/** Called once at the next admitted real Stop, never at proposal/send/retry.
 * Native hosts may admit several Stops in the same turn. */
export function captureRouteOutcome(state: State, snapshot: Snapshot, stopId: string, native = false): Record<string, unknown> | null {
  ingestRouteObservations(state, snapshot);
  ingestHttpRouteProbes(state, snapshot);
  const execution = state.route_execution;
  if (!execution || execution.lifecycle_fence !== lifecycleFence(state) || execution.task_version !== state.task_version || execution.completed_stop_attempt_id || (!native && !execution.confirmed) || stopId === execution.source_stop_attempt_id) return null;
  const observations = snapshot.c2?.observations ?? [];
  const evidence = [...execution.evidence, ...observations].filter((item, index, all) => all.findIndex((other) => other.id === item.id && other.content_sha256 === item.content_sha256) === index);
  // Reused snapshot labels (E1) must not hide distinct source observations.
  const unique = evidence.map((item) => ({ ...item, id: `${item.id}:${item.content_sha256.slice(0, 16)}` }));
  const failed = snapshot.evidence.some((entry) => observations.some((item) => item.id === entry.id) && /"(?:exitCode|exit_code)":-?[1-9]|"(?:status|isError)":(?:"failed"|true)/.test(JSON.stringify(entry.value)));
  const progress = observations.some((item) => !execution.evidence.some((prior) => prior.content_sha256 === item.content_sha256));
  const reset = failed ? snapshot.evidence.map((entry) => { const proof = observations.find((item) => item.id === entry.id); return proof ? { at: observedRetryAt(entry.value, proof.observed_at), proof } : null; }).find((item) => item?.at) : null;
  const outcome = reset ? 'transient_failure' : !progress || failed ? 'failure' : 'diagnostic';
  const ledger = new RouteLedger(scope(state), state.route_ledger ? { data: state.route_ledger } : {});
  const check = execution.discriminating_check;
  // A plan may cite raw proof whose independent digest was omitted by the
  // context budget. Keep the proposal for audit, but never persist an empty
  // or partially evidenced check as a factual attempt condition.
  const checkEvidence = execution.evidence.filter(item => check?.evidence_ids.includes(item.id));
  const discriminating = check && check.evidence_ids.length > 0 && check.evidence_ids.every(id => checkEvidence.some(item => item.id === id))
    ? { description: check.description, evidence_ids: checkEvidence.map(item => `${item.id}:${item.content_sha256.slice(0, 16)}`) } : null;
  const retry = reset?.at ? { kind: 'not_before' as const, not_before: reset.at, description: 'A current independent tool result supplied a structured retry reset time.', evidence_ids: unique.filter((item) => item.content_sha256 === reset.proof.content_sha256).map((item) => item.id) } : null;
  // This Stop proves that the previously admitted route actually ran.  Do
  // not apply the *planning* permission a second time here: no_progress_limit
  // and change_hypothesis must fence future sends, while the observed attempt
  // itself must always be recorded for audit and for the next C context.
  const attempt = ledger.recordObservedAttempt({ route: execution.route, outcome, evidence_ids: unique.map((item) => item.id), evidence: unique, ...(discriminating ? { discriminating_check: discriminating } : {}), ...(retry ? { retry_condition: retry } : {}), ...(['failure', 'transient_failure'].includes(outcome) ? { failure_class: failed ? 'observed_execution_failure' : 'no_independent_progress' } : {}) });
  state.route_ledger = ledger.toJSON();
  execution.completed_stop_attempt_id = stopId;
  return { ...routeCorrelation(execution), delivery_id: execution.delivery_id, stop_attempt_id: stopId, attempt_id: attempt.attempt_id, outcome: attempt.outcome, new_evidence: attempt.new_evidence_ids, evidence_ids: attempt.evidence_ids };
}
export class PlannerFallbackUnavailableError extends Error {}
export function plannerFailureFallback(snapshot: Snapshot, reason: string, state?: State, options: { allowRecoveryOverride?: boolean } = {}): Decision {
  try {
    const candidate = routeInventoryDecision(snapshot, reason);
    const selected = candidate.route_plan!.candidates[0]!;
    if (selected.evidence_ids.length) selected.discriminating_check = { description: 'Use the complete current independent results to distinguish changed route facts before another inventory attempt.', evidence_ids: [...selected.evidence_ids] };
    const decision = validateDecision(JSON.stringify(candidate), snapshot, { allowPlannerFallback: options.allowRecoveryOverride === true });
    // A budget-trimmed ledger is context for C, never permission to dispatch.
    // Validate the fallback against full current state without persisting a
    // proposal, counting an attempt or creating a real delivery.
    if (state) prepareRouteExecution(structuredClone(state), decision, snapshot, 'fallback-admission-check', 'fallback-admission-check', { plannerFallback: options.allowRecoveryOverride === true });
    return decision;
  } catch (error) {
    if (!state) throw error;
    throw new PlannerFallbackUnavailableError(`C 连续三次未产生可交付判断，备用诊断也未获准：${String(redact((error as Error).message))} 未向 WORKER 发送新指令。`);
  }
}
