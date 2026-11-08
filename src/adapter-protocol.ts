import { randomUUID } from 'node:crypto';

export type AdapterProvider = 'codex' | 'claude' | 'hermes' | (string & {});
export type AdapterEventType = 'register' | 'rebind' | 'session_start' | 'user_prompt' | 'pre_tool' | 'post_tool' | 'stop' | 'interrupt' | 'delivery_ack';

export interface AdapterEnvelope {
  schema_version: 1;
  provider: AdapterProvider;
  host_instance_id: string;
  session_id: string;
  task_id: string;
  workspace: string;
  event_type: AdapterEventType;
  occurrence_id: string;
  issued_at: string;
  turn_id: string | null;
  bundle_sha256: string | null;
  payload: Record<string, unknown>;
}

export function adapterEnvelope(input: Omit<AdapterEnvelope, 'schema_version' | 'occurrence_id' | 'issued_at'> & Partial<Pick<AdapterEnvelope, 'occurrence_id' | 'issued_at'>>): AdapterEnvelope {
  return {
    schema_version: 1,
    occurrence_id: input.occurrence_id ?? randomUUID(),
    issued_at: input.issued_at ?? new Date().toISOString(),
    ...input,
  };
}

export function validateAdapterEnvelope(value: unknown): AdapterEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Adapter event must be an object.');
  const event = value as Record<string, unknown>;
  const required = ['provider', 'host_instance_id', 'session_id', 'task_id', 'workspace', 'event_type', 'occurrence_id', 'issued_at'];
  for (const key of required) if (typeof event[key] !== 'string' || !(event[key] as string).trim()) throw new Error(`Adapter event ${key} is required.`);
  if (event.schema_version !== 1) throw new Error('Unsupported adapter event schema.');
  const eventTypes: AdapterEventType[] = ['register', 'rebind', 'session_start', 'user_prompt', 'pre_tool', 'post_tool', 'stop', 'interrupt', 'delivery_ack'];
  if (!eventTypes.includes(event.event_type as AdapterEventType)) throw new Error('Unsupported adapter event type.');
  if (event.turn_id !== null && event.turn_id !== undefined && typeof event.turn_id !== 'string') throw new Error('Adapter event turn_id must be a string or null.');
  if (event.bundle_sha256 !== null && event.bundle_sha256 !== undefined && typeof event.bundle_sha256 !== 'string') throw new Error('Adapter event bundle_sha256 must be a string or null.');
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new Error('Adapter event payload must be an object.');
  if (!Number.isFinite(Date.parse(event.issued_at as string))) throw new Error('Adapter event issued_at must be an ISO timestamp.');
  return {
    schema_version: 1,
    provider: event.provider as AdapterProvider,
    host_instance_id: event.host_instance_id as string,
    session_id: event.session_id as string,
    task_id: event.task_id as string,
    workspace: event.workspace as string,
    event_type: event.event_type as AdapterEventType,
    occurrence_id: event.occurrence_id as string,
    issued_at: event.issued_at as string,
    turn_id: (event.turn_id as string | null | undefined) ?? null,
    bundle_sha256: (event.bundle_sha256 as string | null | undefined) ?? null,
    payload: event.payload as Record<string, unknown>,
  };
}
