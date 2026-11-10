const string = { type: 'string' };
const strings = { type: 'array', items: string };
const nullable = (value: JsonValue) => ({ anyOf: [{ type: 'null' }, value] });
const object = (properties: Record<string, JsonValue>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const diagnosisSchema = nullable(object({ class: { type: 'string', enum: ['provider_limit', 'authentication', 'implementation', 'evidence_gap', 'external_dependency', 'unknown'] }, statement: string, evidence_ids: strings }));
export const routePlanSchema = nullable(object({
  plan_id: string,
  candidates: { type: 'array', items: object({
    route_id: string, resource: object({ kind: { type: 'string', enum: ['provider', 'artifact', 'api', 'command', 'diagnostic'] }, id: string }), operation: string, hypothesis_id: string, hypothesis: string, expected_evidence: strings,
    status: { type: 'string', enum: ['observed', 'candidate', 'blocked', 'exhausted', 'forbidden', 'unknown'] }, evidence_ids: strings, actions: strings, expected_signal: string, risk: string,
    fallback: object({ route_id: nullable(string), when: string }), discriminating_check: nullable(object({ description: string, evidence_ids: strings })),
  }) },
  selected_route_id: string, selection_reason: string, single_route_reason: nullable(string), success_condition: string, stop_condition: string,
}));
import type { JsonValue } from './protocol/generated/serde_json/JsonValue.js';
