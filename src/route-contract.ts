/** C2 facts are supplied by NF/B observations, never inferred from route names. */
export type RouteStatus = 'observed' | 'candidate' | 'blocked' | 'exhausted' | 'forbidden' | 'unknown';
export interface RouteScope { task_id: string; task_version: number }
export interface RouteResource { kind: 'provider' | 'artifact' | 'api' | 'command' | 'diagnostic'; id: string }
export interface RouteEvidence {
  id: string;
  source: 'probe' | 'verification' | 'artifact' | 'event';
  reference: string;
  observed_at: string;
  task_version: number;
  /** Hash the substantive observation, excluding event UUIDs/timestamps. */
  content_sha256: string;
}
export interface RouteCatalogEntry {
  /** B completed a generic local inspection; no relevance to unmet acceptance is asserted. */
  inventory_only?: true;
  route_id: string;
  resource: RouteResource;
  operation: string;
  status: RouteStatus;
  authorization: { status: 'authorized' | 'forbidden' | 'unknown'; evidence_ids: string[] };
  network: { required: boolean | null; available: boolean | null; evidence_ids: string[] };
  authentication: { status: 'present' | 'missing' | 'not_required' | 'unknown'; evidence_ids: string[] };
  rate_limit: { status: 'clear' | 'limited' | 'unknown'; retry_at: string | null; evidence_ids: string[] };
  last_success: { at: string; evidence_ids: string[] } | null;
  capabilities: string[];
  evidence: RouteEvidence[];
}
export interface RouteCatalogData {
  schema_version: 1;
  scope: RouteScope;
  revision: number;
  entries: RouteCatalogEntry[];
}
export interface RoutePersistenceOptions<T> { path?: string; data?: T }

export interface RouteIdentity {
  route_id: string;
  resource: RouteResource;
  operation: string;
  /** Stable hypothesis key. Editing its explanatory prose does not create a route. */
  hypothesis_id: string;
  hypothesis: string;
  expected_evidence: string[];
}
export type RouteOutcome = 'success' | 'transient_failure' | 'failure' | 'blocked' | 'exhausted' | 'diagnostic';
export type RouteRetryCondition =
  | { kind: 'not_before'; not_before: string; description: string; evidence_ids: string[] }
  | { kind: 'condition_changed'; description: string; evidence_ids: string[] };
export interface RouteDiscriminatingCheck { description: string; evidence_ids: string[] }
export interface RouteAttemptContext { evidence_ids?: string[]; evidence?: RouteEvidence[]; discriminating_check?: RouteDiscriminatingCheck }
export interface RouteAttemptPermission {
  allowed: boolean;
  reason: 'first_attempt' | 'previous_success' | 'new_evidence' | 'retry_condition_met' | 'new_hypothesis' | 'discriminating_check' | 'retry_condition_required' | 'retry_not_ready' | 'change_hypothesis' | 'route_exhausted' | 'no_progress_limit';
  fingerprint: string;
  family_fingerprint: string;
  attempt_count: number;
  next_attempt: number;
}
export interface RouteAttemptInput {
  route: RouteIdentity;
  outcome: RouteOutcome;
  evidence_ids: string[];
  evidence?: RouteEvidence[];
  failure_class?: string;
  retry_condition?: RouteRetryCondition;
  discriminating_check?: RouteDiscriminatingCheck;
}
export interface RouteAttempt {
  attempt_id: string;
  task_version: number;
  at: string;
  route: RouteIdentity;
  fingerprint: string;
  family_fingerprint: string;
  attempt_number: number;
  family_attempt_number: number;
  evidence_ids: string[];
  evidence: RouteEvidence[];
  new_evidence_ids: string[];
  outcome: RouteOutcome;
  failure_class: string | null;
  retry_condition: RouteRetryCondition | null;
  discriminating_check: RouteDiscriminatingCheck | null;
  next_attempt: RouteAttemptPermission;
}
export interface RouteLedgerData {
  schema_version: 1;
  scope: RouteScope;
  revision: number;
  attempts: RouteAttempt[];
}
export interface RouteLedgerOptions extends RoutePersistenceOptions<RouteLedgerData> { now?: () => number }
