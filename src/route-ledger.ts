import { createHash, randomUUID } from 'node:crypto';
import type { RouteAttempt, RouteAttemptContext, RouteAttemptInput, RouteAttemptPermission, RouteIdentity, RouteLedgerData, RouteLedgerOptions, RouteScope } from './route-contract.js';
import { clone, RouteStorage, strings, timestamp, validateEnvelope, validateEvidence } from './route-storage.js';
import { record, text } from './types.js';

function validateIdentity(value: unknown): asserts value is RouteIdentity {
  const route = record(value), resource = record(route.resource);
  text(route.route_id, 'route_id'); text(resource.id, 'resource.id');
  if (!['provider', 'artifact', 'api', 'command', 'diagnostic'].includes(String(resource.kind))) throw new Error('Invalid route resource kind.');
  text(route.operation, 'operation'); text(route.hypothesis_id, 'hypothesis_id'); text(route.hypothesis, 'hypothesis');
  if (!strings(route.expected_evidence, 'expected_evidence').length) throw new Error('A route requires expected evidence.');
}
function normalize(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function routeEvidenceDigest(value: unknown): string {
  function canonical(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    throw new Error('Substantive route evidence must be a JSON value.');
  }
  return hash(canonical(value));
}
function familyIdentity(route: RouteIdentity): unknown[] {
  return [route.resource.kind, route.resource.kind === 'artifact' ? route.resource.id.trim() : normalize(route.resource.id), normalize(route.operation)];
}
export function routeFamilyFingerprint(route: RouteIdentity): string { validateIdentity(route); return hash(familyIdentity(route)); }
export function fingerprintRoute(route: RouteIdentity): string {
  validateIdentity(route);
  return hash([...familyIdentity(route), normalize(route.hypothesis_id), [...new Set(route.expected_evidence.map(normalize))].sort()]);
}
function validateInput(input: RouteAttemptInput): void {
  validateIdentity(input.route); strings(input.evidence_ids, 'evidence_ids');
  const ids = new Set<string>();
  for (const evidence of input.evidence ?? []) {
    validateEvidence(evidence);
    if (!input.evidence_ids.includes(evidence.id) || ids.has(evidence.id)) throw new Error('Observation must have a unique referenced evidence ID.');
    ids.add(evidence.id);
  }
  if (!['success', 'transient_failure', 'failure', 'blocked', 'exhausted', 'diagnostic'].includes(input.outcome)) throw new Error('Invalid route outcome.');
  if (['transient_failure', 'failure', 'blocked'].includes(input.outcome)) text(input.failure_class, 'failure_class');
  if (input.retry_condition) {
    const retry = input.retry_condition;
    if (!['not_before', 'condition_changed'].includes(retry.kind)) throw new Error('Invalid route retry condition.');
    text(retry.description, 'retry_condition.description');
    if (!strings(retry.evidence_ids, 'retry_condition.evidence_ids').length || retry.evidence_ids.some((id) => !input.evidence_ids.includes(id))) throw new Error('Retry condition requires referenced attempt evidence.');
    if (retry.kind === 'not_before') timestamp(retry.not_before, 'retry_condition.not_before');
  }
  if (input.discriminating_check) {
    text(input.discriminating_check.description, 'discriminating_check.description');
    if (!strings(input.discriminating_check.evidence_ids, 'discriminating_check.evidence_ids').length || input.discriminating_check.evidence_ids.some((id) => !input.evidence_ids.includes(id))) throw new Error('Discriminating check requires referenced attempt evidence.');
  }
}
function permission(attempts: RouteAttempt[], route: RouteIdentity, context: RouteAttemptContext, now: number): RouteAttemptPermission {
  const fingerprint = fingerprintRoute(route), family = routeFamilyFingerprint(route);
  const previous = attempts.filter((attempt) => attempt.family_fingerprint === family);
  const result = (allowed: boolean, reason: RouteAttemptPermission['reason']): RouteAttemptPermission => ({ allowed, reason, fingerprint, family_fingerprint: family, attempt_count: previous.length, next_attempt: previous.length + 1 });
  const last = previous.at(-1);
  const known = new Set(previous.flatMap((attempt) => attempt.evidence.map((evidence) => evidence.content_sha256)));
  const evidence_ids = context.evidence_ids ?? [];
  strings(evidence_ids, 'context.evidence_ids');
  const fresh = new Set<string>();
  for (const evidence of context.evidence ?? []) {
    validateEvidence(evidence);
    if (!evidence_ids.includes(evidence.id)) throw new Error('Context observation must reference a current evidence ID.');
    if (!known.has(evidence.content_sha256)) fresh.add(evidence.id);
  }
  let check = false;
  if (context.discriminating_check) {
    text(context.discriminating_check.description, 'discriminating_check.description');
    const refs = strings(context.discriminating_check.evidence_ids, 'discriminating_check.evidence_ids');
    if (!refs.length || refs.some((id) => !evidence_ids.includes(id))) throw new Error('Discriminating check requires current evidence references.');
    check = refs.some((id) => fresh.has(id));
  }
  if (!last) return result(true, 'first_attempt');
  if (last.outcome === 'exhausted') return result(false, 'route_exhausted');
  if (last.outcome === 'success') return result(true, 'previous_success');
  const failures = previous.slice(previous.findLastIndex((attempt) => attempt.outcome === 'success') + 1).filter((attempt) => ['failure', 'transient_failure', 'blocked'].includes(attempt.outcome));
  if (failures.length >= 2 && last.new_evidence_ids.length === 0 && fresh.size === 0) return result(false, 'no_progress_limit');
  if (check) return result(true, 'discriminating_check');
  if (normalize(route.hypothesis_id) !== normalize(last.route.hypothesis_id)) return result(true, 'new_hypothesis');
  const priorFailure = failures.at(-2);
  if (priorFailure && priorFailure.failure_class === last.failure_class) return result(false, 'change_hypothesis');
  if (last.outcome !== 'transient_failure') return result(false, 'change_hypothesis');
  const retry = last.retry_condition;
  if (!retry || retry.evidence_ids.some((id) => !last.evidence.some((evidence) => evidence.id === id))) return result(false, 'retry_condition_required');
  if (retry.kind === 'not_before') return Date.parse(retry.not_before) <= now ? result(true, 'retry_condition_met') : result(false, 'retry_not_ready');
  return retry.evidence_ids.some((id) => fresh.has(id)) ? result(true, 'retry_condition_met') : result(false, 'retry_not_ready');
}
function validateData(value: unknown): void {
  validateEnvelope(value);
  const data = record(value);
  if (!Array.isArray(data.attempts)) throw new Error('Invalid Route Ledger attempts.');
  const ids = new Set<string>();
  for (const value of data.attempts) {
    const attempt = record(value);
    validateInput(attempt as unknown as RouteAttemptInput);
    const id = text(attempt.attempt_id, 'attempt_id');
    if (ids.has(id)) throw new Error('Duplicate route attempt ID.');
    ids.add(id); timestamp(attempt.at, 'attempt.at');
    const route = attempt.route as RouteIdentity;
    if (attempt.fingerprint !== fingerprintRoute(route) || attempt.family_fingerprint !== routeFamilyFingerprint(route)) throw new Error('Invalid persisted route fingerprint.');
    strings(attempt.new_evidence_ids, 'new_evidence_ids');
    if (!Number.isInteger(attempt.attempt_number) || Number(attempt.attempt_number) < 1 || !Number.isInteger(attempt.family_attempt_number) || Number(attempt.family_attempt_number) < 1 || !Number.isInteger(attempt.task_version) || Number(attempt.task_version) < 1) throw new Error('Invalid route attempt counters.');
    const next = record(attempt.next_attempt);
    if (typeof next.allowed !== 'boolean') throw new Error('Invalid next attempt permission.');
  }
}

export class RouteLedger {
  private readonly storage: RouteStorage<RouteLedgerData>;
  private readonly now: () => number;
  constructor(private readonly scope: RouteScope, options: RouteLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.storage = new RouteStorage(scope, options, { schema_version: 1, scope, revision: 0, attempts: [] }, validateData);
  }
  list(): RouteAttempt[] { return this.storage.read().attempts; }
  toJSON(): RouteLedgerData { return this.storage.read(); }
  evaluateAttempt(route: RouteIdentity, context: RouteAttemptContext = {}): RouteAttemptPermission { return permission(this.list(), route, context, this.now()); }
  recordAttempt(input: RouteAttemptInput): RouteAttempt {
    validateInput(input);
    return this.storage.update((data) => {
      const context: RouteAttemptContext = { evidence_ids: input.evidence_ids, evidence: input.evidence ?? [], ...(input.discriminating_check ? { discriminating_check: input.discriminating_check } : {}) };
      const allowed = permission(data.attempts, input.route, context, this.now());
      if (!allowed.allowed) throw new Error(`Route attempt rejected: ${allowed.reason}.`);
      const fingerprint = fingerprintRoute(input.route), family = routeFamilyFingerprint(input.route);
      const previous = data.attempts.filter((attempt) => attempt.family_fingerprint === family);
      const known = new Set(previous.flatMap((attempt) => attempt.evidence.map((evidence) => evidence.content_sha256)));
      const attempt: RouteAttempt = {
        attempt_id: randomUUID(), task_version: this.scope.task_version, at: new Date(this.now()).toISOString(), route: clone(input.route),
        fingerprint, family_fingerprint: family,
        attempt_number: data.attempts.filter((attempt) => attempt.fingerprint === fingerprint).length + 1,
        family_attempt_number: previous.length + 1,
        evidence_ids: [...new Set(input.evidence_ids)], evidence: clone(input.evidence ?? []),
        new_evidence_ids: previous.length ? (input.evidence ?? []).filter((evidence) => !known.has(evidence.content_sha256)).map((evidence) => evidence.id) : [...new Set(input.evidence_ids)],
        outcome: input.outcome, failure_class: input.failure_class ?? null, retry_condition: input.retry_condition ?? null, discriminating_check: input.discriminating_check ?? null,
        next_attempt: permission([], input.route, {}, this.now()),
      };
      data.attempts.push(attempt);
      attempt.next_attempt = permission(data.attempts, input.route, {}, this.now());
      return attempt;
    });
  }
}
