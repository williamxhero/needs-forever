import type { RouteCatalogData, RouteDiscriminatingCheck, RouteEvidence, RouteIdentity, RouteLedgerData, RouteStatus } from './route-contract.js';

export type C2Mode = 'enforce' | 'shadow' | 'legacy';
export interface Diagnosis {
  class: 'provider_limit' | 'authentication' | 'implementation' | 'evidence_gap' | 'external_dependency' | 'unknown';
  statement: string;
  evidence_ids: string[];
}
export interface RouteCandidate extends RouteIdentity {
  status: RouteStatus;
  evidence_ids: string[];
  actions: string[];
  expected_signal: string;
  risk: string;
  fallback: { route_id: string | null; when: string };
  discriminating_check: RouteDiscriminatingCheck | null;
}
export interface RoutePlan {
  plan_id: string;
  candidates: RouteCandidate[];
  selected_route_id: string;
  selection_reason: string;
  single_route_reason: string | null;
  success_condition: string;
  stop_condition: string;
}
export interface C2Context {
  mode: C2Mode;
  context_complete: boolean;
  catalog: RouteCatalogData;
  ledger: RouteLedgerData;
  observations: RouteEvidence[];
  current_plan: RoutePlan | null;
  instruction: string;
  http_probe?: { argv_prefix: string[]; instruction: string };
}
