import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

/** Provider kinds are deliberately explicit. A provider that cannot prove its
 * transport is represented as `unavailable`; it must never silently degrade to
 * a recent thread, window order, or an independent worker. */
export type ProviderKind = 'shared-server' | 'daemon' | 'native-hook' | 'ui-bridge' | 'simulated' | 'unavailable';
export type ProviderEvidenceLevel = 'live' | 'simulated' | 'unverified' | 'unavailable';
export type ProviderThreadStatus = 'idle' | 'in-progress' | 'unavailable' | 'unknown';
export type ProviderWriterStatus = 'idle' | 'in-progress' | 'active-writer' | 'unavailable' | 'unknown';
export type ProviderDeliveryStatus = 'prepared' | 'sent' | 'confirmed' | 'unknown' | 'already-present' | 'active-writer' | 'unavailable';
export type DeliveryMatch = 'delivery_id' | 'client_message_id' | 'target_turn_id' | 'activity' | 'none';
export type ProviderEventType =
  | 'capability_probe'
  | 'thread_read'
  | 'writer_state'
  | 'resume'
  | 'send_prepared'
  | 'send_sent'
  | 'delivery_reconciled'
  | 'activity'
  | 'disconnected'
  | 'closed';

export interface ProviderCapabilitySet {
  read_thread: boolean;
  read_writer: boolean;
  resume_send: boolean;
  subscribe_events: boolean;
  read_history: boolean;
  reconcile_delivery: boolean;
}

export const ALL_PROVIDER_CAPABILITIES: ProviderCapabilitySet = {
  read_thread: true,
  read_writer: true,
  resume_send: true,
  subscribe_events: true,
  read_history: true,
  reconcile_delivery: true,
};

export interface ProviderIdentity {
  target_thread_id: string;
  target_session_id: string;
  /** Alias retained in persisted receipts for callers that call the original
   * Desktop thread a main session. It is explicit data, never inferred from a
   * recent thread or title. */
  main_session_id?: string;
  workspace: string;
  host_instance_id: string;
  host_fingerprint: string;
  task_version: number;
  run_generation: string;
  contract_sha256?: string | null;
}

export interface ProviderProbeRequest {
  target?: Partial<ProviderIdentity> | null;
}

export interface ProviderRequest {
  target: ProviderIdentity;
}

export interface CapabilityReceipt {
  schema_version: 1;
  provider_kind: ProviderKind;
  evidence_level: ProviderEvidenceLevel;
  available: boolean;
  attached: boolean;
  same_thread_verified: boolean;
  capabilities: ProviderCapabilitySet;
  target_thread_id: string | null;
  target_session_id: string | null;
  main_session_id: string | null;
  workspace: string | null;
  host_instance_id: string | null;
  host_fingerprint: string | null;
  protocol_version: string | null;
  provider_version: string | null;
  endpoint_fingerprint: string | null;
  task_version: number | null;
  run_generation: string | null;
  contract_sha256: string | null;
  limitation_reason: string | null;
  observed_at: string;
}

export interface ProviderWriterState {
  status: ProviderWriterStatus;
  owner_session_id: string | null;
  turn_id: string | null;
  reason: string | null;
  observed_at?: string;
}

export interface ProviderTurnItem {
  type: 'user_message' | 'assistant_message' | 'tool_activity' | 'other';
  client_message_id?: string | null;
  delivery_id?: string | null;
  value?: unknown;
}

export interface ProviderTurn {
  turn_id: string;
  status: 'in-progress' | 'completed' | 'unknown';
  items: ProviderTurnItem[];
  started_at?: string | null;
  completed_at?: string | null;
}

export interface ProviderThreadSnapshot {
  thread_id: string;
  session_id: string;
  workspace: string;
  status: ProviderThreadStatus;
  writer: ProviderWriterState;
  turns: ProviderTurn[];
  latest_activity_at: string | null;
  observed_at: string;
}

export interface ProviderHistoryPage {
  thread_id: string;
  session_id: string;
  turns: ProviderTurn[];
  has_more: boolean;
  cursor: string | null;
  readable: boolean;
  limitation_reason: string | null;
  observed_at: string;
}

export interface ProviderDelivery {
  delivery_id: string;
  message: string;
  status: ProviderDeliveryStatus;
  target_turn_id: string | null;
  client_message_id: string | null;
  observed_at?: string;
}

export interface DeliveryReconciliation {
  delivery_id: string;
  outcome: 'confirmed' | 'sent' | 'unknown' | 'not_found' | 'active_writer' | 'unavailable';
  matched_by: DeliveryMatch;
  target_turn_id: string | null;
  reason: string | null;
  observed_at: string;
}

export interface ProviderResumeResult extends Omit<ProviderThreadSnapshot, 'status'> {
  status: 'attached' | 'active_writer' | 'unavailable';
  created_worker: false;
}

export interface ProviderSendRequest extends ProviderRequest {
  delivery_id: string;
  message: string;
}

export interface ProviderSendResult {
  delivery_id: string;
  outcome: ProviderDeliveryStatus;
  target_thread_id: string;
  target_session_id: string;
  target_turn_id: string | null;
  created_worker: false;
  reason: string | null;
  observed_at: string;
}

export interface ProviderHistoryRequest extends ProviderRequest {
  cursor?: string | null;
}

export interface ProviderReconciliationRequest extends ProviderRequest {
  delivery_id: string;
  message?: string;
  client_message_id?: string | null;
  target_turn_id?: string | null;
}

export interface ProviderActivity {
  event_id: string;
  type: 'activity';
  target_thread_id: string;
  target_session_id: string;
  turn_id: string | null;
  delivery_id: string | null;
  observed_at: string;
  details: Record<string, unknown>;
}

export interface ProviderEvent {
  schema_version: 1;
  event_id: string;
  at: string;
  type: ProviderEventType;
  provider_kind: ProviderKind;
  evidence_level: ProviderEvidenceLevel;
  target_thread_id: string | null;
  target_session_id: string | null;
  workspace: string | null;
  host_fingerprint: string | null;
  task_version: number | null;
  run_generation: string | null;
  delivery_id: string | null;
  turn_id: string | null;
  payload: Record<string, unknown>;
}

export interface MainSessionProviderState {
  schema_version: 1;
  provider_kind: ProviderKind;
  status: 'unavailable' | 'probing' | 'attached' | 'disconnected' | 'closed';
  evidence_level: ProviderEvidenceLevel;
  capabilities: ProviderCapabilitySet;
  target_thread_id: string | null;
  target_session_id: string | null;
  workspace: string | null;
  host_fingerprint: string | null;
  same_thread_verified: boolean;
  writer: ProviderWriterState | null;
  a_activity: ProviderActivity | null;
  last_delivery: DeliveryReconciliation | null;
  continuation_confirmation: ProviderActivity | null;
  limitation_reason: string | null;
  next_action: string | null;
  updated_at: string;
}

export interface ProviderSubscription {
  unsubscribe(): void;
}

export type ProviderEventListener = (event: ProviderEvent) => void;

/**
 * A deliberately small seam around a Desktop shared RPC connection.  The
 * adapter never creates a connection, thread, or worker itself: the caller
 * injects the already-authenticated transport for the original Desktop host.
 * Implementations may be backed by an app-server, daemon, or native bridge.
 */
export interface DesktopRpcTransport {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  subscribe?(listener: (event: unknown) => void): ProviderSubscription | Promise<ProviderSubscription>;
  close?(): Promise<void> | void;
  /** Facts obtained by the transport's own capability/identity handshake. */
  metadata?: DesktopRpcTransportMetadata;
}

export interface DesktopRpcTransportMetadata {
  provider_kind?: Exclude<ProviderKind, 'simulated' | 'unavailable'>;
  evidence_level?: Exclude<ProviderEvidenceLevel, 'simulated' | 'unavailable'>;
  protocol_version?: string | null;
  provider_version?: string | null;
  endpoint_fingerprint?: string | null;
  identity?: Partial<ProviderIdentity> | null;
  capabilities?: Partial<ProviderCapabilitySet>;
}

export interface DesktopProviderRpcMethods {
  probe: string;
  read_thread: string;
  read_writer: string;
  resume: string;
  send: string;
  read_history: string;
  reconcile_delivery: string;
}

export const DEFAULT_DESKTOP_PROVIDER_RPC_METHODS: DesktopProviderRpcMethods = {
  probe: 'provider/probe',
  read_thread: 'thread/read',
  read_writer: 'thread/writer',
  resume: 'thread/resume',
  send: 'thread/send',
  read_history: 'thread/history',
  reconcile_delivery: 'thread/reconcile',
};

export interface DesktopMainSessionProviderOptions {
  identity?: Partial<ProviderIdentity> | null;
  transport?: DesktopRpcTransport | null;
  methods?: Partial<DesktopProviderRpcMethods>;
  provider_kind?: Exclude<ProviderKind, 'simulated' | 'unavailable'>;
  provider_version?: string | null;
  protocol_version?: string | null;
  endpoint_fingerprint?: string | null;
}

export interface MainSessionProvider {
  readonly kind: ProviderKind;
  readonly receipt: CapabilityReceipt;
  probe(request?: ProviderProbeRequest): Promise<CapabilityReceipt>;
  readThread(request: ProviderRequest): Promise<ProviderThreadSnapshot>;
  readWriter(request: ProviderRequest): Promise<ProviderWriterState>;
  resume(request: ProviderRequest): Promise<ProviderResumeResult>;
  send(request: ProviderSendRequest): Promise<ProviderSendResult>;
  subscribe(request: ProviderRequest, listener: ProviderEventListener): Promise<ProviderSubscription>;
  readHistory(request: ProviderHistoryRequest): Promise<ProviderHistoryPage>;
  reconcileDelivery(request: ProviderReconciliationRequest): Promise<DeliveryReconciliation>;
  close(): Promise<void>;
}

export class ProviderIdentityError extends Error {
  readonly code = 'provider_identity_unavailable';
  constructor(message: string) { super(message); this.name = 'ProviderIdentityError'; }
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function now(): string { return new Date().toISOString(); }

function completeIdentity(value: Partial<ProviderIdentity> | null | undefined): value is ProviderIdentity {
  return !!value
    && nonEmpty(value.target_thread_id)
    && nonEmpty(value.target_session_id)
    && nonEmpty(value.workspace)
    && isAbsolute(value.workspace)
    && nonEmpty(value.host_instance_id)
    && nonEmpty(value.host_fingerprint)
    && typeof value.task_version === 'number'
    && Number.isInteger(value.task_version)
    && value.task_version > 0
    && nonEmpty(value.run_generation);
}

function identityMatches(expected: ProviderIdentity, actual: ProviderIdentity): boolean {
  return expected.target_thread_id === actual.target_thread_id
    && expected.target_session_id === actual.target_session_id
    && (expected.main_session_id ?? expected.target_thread_id) === (actual.main_session_id ?? actual.target_thread_id)
    && expected.workspace === actual.workspace
    && expected.host_instance_id === actual.host_instance_id
    && expected.host_fingerprint === actual.host_fingerprint
    && expected.task_version === actual.task_version
    && expected.run_generation === actual.run_generation
    && (expected.contract_sha256 ?? null) === (actual.contract_sha256 ?? null);
}

function unavailableReceipt(target: Partial<ProviderIdentity> | null | undefined, reason: string): CapabilityReceipt {
  return {
    schema_version: 1,
    provider_kind: 'unavailable',
    evidence_level: 'unavailable',
    available: false,
    attached: false,
    same_thread_verified: false,
    capabilities: { read_thread: false, read_writer: false, resume_send: false, subscribe_events: false, read_history: false, reconcile_delivery: false },
    target_thread_id: nonEmpty(target?.target_thread_id) ? target!.target_thread_id! : null,
    target_session_id: nonEmpty(target?.target_session_id) ? target!.target_session_id! : null,
    main_session_id: nonEmpty(target?.main_session_id) ? target!.main_session_id! : null,
    workspace: nonEmpty(target?.workspace) ? target!.workspace! : null,
    host_instance_id: nonEmpty(target?.host_instance_id) ? target!.host_instance_id! : null,
    host_fingerprint: nonEmpty(target?.host_fingerprint) ? target!.host_fingerprint! : null,
    protocol_version: null,
    provider_version: null,
    endpoint_fingerprint: null,
    task_version: typeof target?.task_version === 'number' && Number.isInteger(target.task_version) ? target.task_version : null,
    run_generation: nonEmpty(target?.run_generation) ? target!.run_generation! : null,
    contract_sha256: nonEmpty(target?.contract_sha256) ? target!.contract_sha256! : null,
    limitation_reason: reason,
    observed_at: now(),
  };
}

export function createCapabilityReceipt(input: Partial<CapabilityReceipt> & Pick<CapabilityReceipt, 'provider_kind' | 'evidence_level'>): CapabilityReceipt {
  const capabilities = { ...{ read_thread: false, read_writer: false, resume_send: false, subscribe_events: false, read_history: false, reconcile_delivery: false }, ...input.capabilities };
  return {
    schema_version: 1,
    provider_kind: input.provider_kind,
    evidence_level: input.evidence_level,
    available: input.available ?? false,
    attached: input.attached ?? false,
    same_thread_verified: input.same_thread_verified ?? false,
    capabilities,
    target_thread_id: input.target_thread_id ?? null,
    target_session_id: input.target_session_id ?? null,
    main_session_id: input.main_session_id ?? input.target_thread_id ?? null,
    workspace: input.workspace ?? null,
    host_instance_id: input.host_instance_id ?? null,
    host_fingerprint: input.host_fingerprint ?? null,
    protocol_version: input.protocol_version ?? null,
    provider_version: input.provider_version ?? null,
    endpoint_fingerprint: input.endpoint_fingerprint ?? null,
    task_version: input.task_version ?? null,
    run_generation: input.run_generation ?? null,
    contract_sha256: input.contract_sha256 ?? null,
    limitation_reason: input.limitation_reason ?? null,
    observed_at: input.observed_at ?? now(),
  };
}

export function validateCapabilityReceipt(value: unknown): CapabilityReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Capability receipt must be an object.');
  const receipt = value as Partial<CapabilityReceipt>;
  if (receipt.schema_version !== 1) throw new Error('Unsupported capability receipt schema.');
  if (!['shared-server', 'daemon', 'native-hook', 'ui-bridge', 'simulated', 'unavailable'].includes(String(receipt.provider_kind))) throw new Error('Invalid capability receipt provider kind.');
  if (!['live', 'simulated', 'unverified', 'unavailable'].includes(String(receipt.evidence_level))) throw new Error('Invalid capability receipt evidence level.');
  if (typeof receipt.available !== 'boolean' || typeof receipt.attached !== 'boolean' || typeof receipt.same_thread_verified !== 'boolean') throw new Error('Capability receipt availability fields are invalid.');
  if (!receipt.capabilities || typeof receipt.capabilities !== 'object' || Array.isArray(receipt.capabilities)) throw new Error('Capability receipt capabilities are required.');
  for (const key of Object.keys(ALL_PROVIDER_CAPABILITIES) as (keyof ProviderCapabilitySet)[]) if (typeof receipt.capabilities[key] !== 'boolean') throw new Error(`Capability receipt capability ${key} is invalid.`);
  for (const key of ['target_thread_id', 'target_session_id', 'main_session_id', 'workspace', 'host_instance_id', 'host_fingerprint', 'protocol_version', 'provider_version', 'endpoint_fingerprint', 'run_generation', 'contract_sha256', 'limitation_reason'] as const) if (receipt[key] !== null && receipt[key] !== undefined && typeof receipt[key] !== 'string') throw new Error(`Capability receipt ${key} must be a string or null.`);
  if (receipt.task_version !== null && receipt.task_version !== undefined && (typeof receipt.task_version !== 'number' || !Number.isInteger(receipt.task_version) || receipt.task_version <= 0)) throw new Error('Capability receipt task_version is invalid.');
  if (!nonEmpty(receipt.observed_at) || !Number.isFinite(Date.parse(receipt.observed_at))) throw new Error('Capability receipt observed_at must be an ISO timestamp.');
  return clone(receipt as CapabilityReceipt);
}

export function createProviderEvent(input: Omit<ProviderEvent, 'schema_version' | 'event_id' | 'at' | 'delivery_id' | 'turn_id'> & Partial<Pick<ProviderEvent, 'event_id' | 'at' | 'delivery_id' | 'turn_id'>>): ProviderEvent {
  return { schema_version: 1, event_id: input.event_id ?? randomUUID(), at: input.at ?? now(), delivery_id: input.delivery_id ?? null, turn_id: input.turn_id ?? null, ...input };
}

export function validateProviderEvent(value: unknown): ProviderEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider event must be an object.');
  const event = value as Partial<ProviderEvent>;
  if (event.schema_version !== 1 || !nonEmpty(event.event_id) || !nonEmpty(event.at) || !Number.isFinite(Date.parse(event.at))) throw new Error('Provider event identity or timestamp is invalid.');
  if (!['capability_probe', 'thread_read', 'writer_state', 'resume', 'send_prepared', 'send_sent', 'delivery_reconciled', 'activity', 'disconnected', 'closed'].includes(String(event.type))) throw new Error('Unsupported provider event type.');
  if (!['shared-server', 'daemon', 'native-hook', 'ui-bridge', 'simulated', 'unavailable'].includes(String(event.provider_kind))) throw new Error('Invalid provider event kind.');
  if (!['live', 'simulated', 'unverified', 'unavailable'].includes(String(event.evidence_level))) throw new Error('Invalid provider event evidence level.');
  for (const key of ['target_thread_id', 'target_session_id', 'workspace', 'host_fingerprint', 'run_generation', 'delivery_id', 'turn_id'] as const) if (event[key] !== null && event[key] !== undefined && typeof event[key] !== 'string') throw new Error(`Provider event ${key} must be a string or null.`);
  if (event.task_version !== null && event.task_version !== undefined && (typeof event.task_version !== 'number' || !Number.isInteger(event.task_version) || event.task_version <= 0)) throw new Error('Provider event task_version is invalid.');
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new Error('Provider event payload is required.');
  return clone(event as ProviderEvent);
}

export function createProviderState(receipt: CapabilityReceipt): MainSessionProviderState {
  const validated = validateCapabilityReceipt(receipt);
  return {
    schema_version: 1,
    provider_kind: validated.provider_kind,
    status: validated.available && validated.attached ? 'attached' : 'unavailable',
    evidence_level: validated.evidence_level,
    capabilities: clone(validated.capabilities),
    target_thread_id: validated.target_thread_id,
    target_session_id: validated.target_session_id,
    workspace: validated.workspace,
    host_fingerprint: validated.host_fingerprint,
    same_thread_verified: validated.same_thread_verified,
    writer: null,
    a_activity: null,
    last_delivery: null,
    continuation_confirmation: null,
    limitation_reason: validated.limitation_reason,
    next_action: validated.available ? null : 'Wait for a trusted provider receipt or native lifecycle receipt.',
    updated_at: validated.observed_at,
  };
}

export function validateProviderState(value: unknown): MainSessionProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider state must be an object.');
  const state = value as Partial<MainSessionProviderState>;
  if (state.schema_version !== 1 || !['shared-server', 'daemon', 'native-hook', 'ui-bridge', 'simulated', 'unavailable'].includes(String(state.provider_kind))) throw new Error('Provider state identity is invalid.');
  if (!['unavailable', 'probing', 'attached', 'disconnected', 'closed'].includes(String(state.status))) throw new Error('Provider state status is invalid.');
  if (!['live', 'simulated', 'unverified', 'unavailable'].includes(String(state.evidence_level))) throw new Error('Provider state evidence level is invalid.');
  if (!state.capabilities || typeof state.capabilities !== 'object' || Array.isArray(state.capabilities)) throw new Error('Provider state capabilities are required.');
  for (const key of Object.keys(ALL_PROVIDER_CAPABILITIES) as (keyof ProviderCapabilitySet)[]) if (typeof state.capabilities[key] !== 'boolean') throw new Error(`Provider state capability ${key} is invalid.`);
  for (const key of ['target_thread_id', 'target_session_id', 'workspace', 'host_fingerprint', 'limitation_reason', 'next_action'] as const) if (state[key] !== null && state[key] !== undefined && typeof state[key] !== 'string') throw new Error(`Provider state ${key} must be a string or null.`);
  if (typeof state.same_thread_verified !== 'boolean' || !nonEmpty(state.updated_at) || !Number.isFinite(Date.parse(state.updated_at))) throw new Error('Provider state verification or timestamp is invalid.');
  return clone(state as MainSessionProviderState);
}

function providerEventFrom(receipt: CapabilityReceipt, type: ProviderEventType, payload: Record<string, unknown>, deliveryId: string | null = null, turnId: string | null = null): ProviderEvent {
  return createProviderEvent({ type, provider_kind: receipt.provider_kind, evidence_level: receipt.evidence_level, target_thread_id: receipt.target_thread_id, target_session_id: receipt.target_session_id, workspace: receipt.workspace, host_fingerprint: receipt.host_fingerprint, task_version: receipt.task_version, run_generation: receipt.run_generation, delivery_id: deliveryId, turn_id: turnId, payload });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function statusOf(value: unknown): ProviderThreadStatus {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text === 'inprogress' || text === 'in-progress' || text === 'active' || text === 'running') return 'in-progress';
  if (text === 'idle' || text === 'notloaded' || text === 'not-loaded' || text === 'completed') return 'idle';
  if (text === 'unavailable' || text === 'closed') return 'unavailable';
  return 'unknown';
}

function writerOf(value: unknown): ProviderWriterState {
  const raw = asObject(value) ?? {};
  const status = typeof raw.status === 'string' ? raw.status : typeof raw.type === 'string' ? raw.type : '';
  const normalized = statusOf(status);
  const writerStatus: ProviderWriterStatus = normalized === 'in-progress' ? 'in-progress' : status.toLowerCase().includes('writer') ? 'active-writer' : normalized === 'idle' ? 'idle' : normalized === 'unavailable' ? 'unavailable' : 'unknown';
  return { status: writerStatus, owner_session_id: typeof raw.owner_session_id === 'string' ? raw.owner_session_id : typeof raw.ownerSessionId === 'string' ? raw.ownerSessionId : null, turn_id: typeof raw.turn_id === 'string' ? raw.turn_id : typeof raw.turnId === 'string' ? raw.turnId : null, reason: typeof raw.reason === 'string' ? raw.reason : null, observed_at: now() };
}

function turnOf(value: unknown): ProviderTurn {
  const raw = asObject(value) ?? {};
  const items = Array.isArray(raw.items) ? raw.items.map((item) => {
    const entry = asObject(item) ?? {};
    const type = typeof entry.type === 'string' && ['user_message', 'assistant_message', 'tool_activity', 'other'].includes(entry.type) ? entry.type as ProviderTurnItem['type'] : 'other';
    return { type, client_message_id: typeof entry.client_message_id === 'string' ? entry.client_message_id : typeof entry.clientMessageId === 'string' ? entry.clientMessageId : null, delivery_id: typeof entry.delivery_id === 'string' ? entry.delivery_id : typeof entry.deliveryId === 'string' ? entry.deliveryId : null, value: entry.value };
  }) : [];
  const turnId = typeof raw.turn_id === 'string' ? raw.turn_id : typeof raw.id === 'string' ? raw.id : '';
  if (!turnId) throw new ProviderIdentityError('Desktop provider returned a turn without an identity.');
  const status = typeof raw.status === 'string' && raw.status.toLowerCase().includes('progress') ? 'in-progress' : raw.status === 'completed' || raw.status === 'complete' ? 'completed' : 'unknown';
  return { turn_id: turnId, status, items, started_at: typeof raw.started_at === 'string' ? raw.started_at : null, completed_at: typeof raw.completed_at === 'string' ? raw.completed_at : null };
}

function identityFrom(value: unknown): Partial<ProviderIdentity> | null {
  const raw = asObject(value);
  if (!raw) return null;
  const nested = asObject(raw.identity) ?? raw;
  const result: Partial<ProviderIdentity> = {};
  const thread = typeof nested.target_thread_id === 'string' ? nested.target_thread_id : typeof nested.thread_id === 'string' ? nested.thread_id : typeof nested.threadId === 'string' ? nested.threadId : null;
  const session = typeof nested.target_session_id === 'string' ? nested.target_session_id : typeof nested.session_id === 'string' ? nested.session_id : typeof nested.sessionId === 'string' ? nested.sessionId : null;
  const workspace = typeof nested.workspace === 'string' ? nested.workspace : typeof nested.cwd === 'string' ? nested.cwd : null;
  if (thread) result.target_thread_id = thread;
  if (session) result.target_session_id = session;
  if (typeof nested.main_session_id === 'string') result.main_session_id = nested.main_session_id;
  if (workspace) result.workspace = workspace;
  if (typeof nested.host_instance_id === 'string') result.host_instance_id = nested.host_instance_id;
  if (typeof nested.host_fingerprint === 'string') result.host_fingerprint = nested.host_fingerprint;
  if (typeof nested.task_version === 'number') result.task_version = nested.task_version;
  if (typeof nested.run_generation === 'string') result.run_generation = nested.run_generation;
  if (typeof nested.contract_sha256 === 'string') result.contract_sha256 = nested.contract_sha256;
  return result;
}

function fenceFor(identity: ProviderIdentity): Record<string, unknown> {
  return { target_thread_id: identity.target_thread_id, main_session_id: identity.main_session_id ?? identity.target_thread_id, target_session_id: identity.target_session_id, workspace: identity.workspace, host_instance_id: identity.host_instance_id, host_fingerprint: identity.host_fingerprint, task_version: identity.task_version, run_generation: identity.run_generation, contract_sha256: identity.contract_sha256 ?? null };
}

function activeWriterError(error: unknown): boolean {
  return /active writer|writer.*active|in.?progress|already.*writing|已有.*写入|进行中/i.test(error instanceof Error ? error.message : String(error));
}

/** Adapter for an already-owned Desktop/shared app-server connection. It never
 * starts a process or creates a thread; all identity and generation fields are
 * sent on every operation and mismatches fail closed. */
export class DesktopMainSessionProvider implements MainSessionProvider {
  readonly kind: ProviderKind;
  private readonly identity: ProviderIdentity | null;
  private readonly transport: DesktopRpcTransport | null;
  private readonly methods: DesktopProviderRpcMethods;
  private readonly listeners = new Set<ProviderEventListener>();
  private readonly deliveries = new Map<string, ProviderDelivery>();
  private _receipt: CapabilityReceipt;
  private closed = false;

  constructor(options: DesktopMainSessionProviderOptions = {}) {
    this.transport = options.transport ?? null;
    this.identity = completeIdentity(options.identity) ? { ...options.identity, main_session_id: options.identity.main_session_id ?? options.identity.target_thread_id } as ProviderIdentity : null;
    this.methods = { ...DEFAULT_DESKTOP_PROVIDER_RPC_METHODS, ...options.methods };
    this.kind = options.provider_kind ?? this.transport?.metadata?.provider_kind ?? (this.transport ? 'shared-server' : 'unavailable');
    const meta = this.transport?.metadata ?? {};
    this._receipt = this.identity && this.transport ? createCapabilityReceipt({ provider_kind: this.kind, evidence_level: options.transport?.metadata?.evidence_level ?? 'live', available: false, attached: false, same_thread_verified: false, capabilities: { ...ALL_PROVIDER_CAPABILITIES, ...(meta.capabilities ?? {}) }, target_thread_id: this.identity.target_thread_id, target_session_id: this.identity.target_session_id, main_session_id: this.identity.main_session_id ?? this.identity.target_thread_id, workspace: this.identity.workspace, host_instance_id: this.identity.host_instance_id, host_fingerprint: this.identity.host_fingerprint, task_version: this.identity.task_version, run_generation: this.identity.run_generation, contract_sha256: this.identity.contract_sha256 ?? null, protocol_version: options.protocol_version ?? meta.protocol_version ?? null, provider_version: options.provider_version ?? meta.provider_version ?? null, endpoint_fingerprint: options.endpoint_fingerprint ?? meta.endpoint_fingerprint ?? null }) : unavailableReceipt(options.identity, 'Desktop shared transport or trusted original-thread identity is unavailable.');
  }

  get receipt(): CapabilityReceipt { return clone(this._receipt); }
  private ensureOpen(): void { if (this.closed) throw new Error('Provider is closed.'); }
  private target(request: ProviderRequest | ProviderProbeRequest): ProviderIdentity {
    if (!completeIdentity(request.target) || !this.identity || !identityMatches(this.identity, { ...request.target, main_session_id: request.target.main_session_id ?? request.target.target_thread_id } as ProviderIdentity)) throw new ProviderIdentityError('Desktop provider target identity is unavailable or does not match the registered original thread, session, workspace, host or generation.');
    return this.identity;
  }
  private event(type: ProviderEventType, payload: Record<string, unknown>, deliveryId: string | null = null, turnId: string | null = null): void {
    const event = providerEventFrom(this._receipt, type, payload, deliveryId, turnId);
    for (const listener of [...this.listeners]) { try { listener(clone(event)); } catch { /* observers cannot break provider state */ } }
  }
  private async call<T>(method: string, identity: ProviderIdentity, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.transport) throw new ProviderIdentityError('Desktop shared transport is unavailable.');
    return this.transport.request<T>(method, { ...fenceFor(identity), ...params });
  }
  private verifyReturnedIdentity(value: unknown, identity: ProviderIdentity): void {
    const observed = identityFrom(value);
    if (observed && !identityMatches(identity, { ...identity, ...observed, target_thread_id: observed.target_thread_id ?? identity.target_thread_id, target_session_id: observed.target_session_id ?? identity.target_session_id, workspace: observed.workspace ?? identity.workspace, host_instance_id: observed.host_instance_id ?? identity.host_instance_id, host_fingerprint: observed.host_fingerprint ?? identity.host_fingerprint, task_version: observed.task_version ?? identity.task_version, run_generation: observed.run_generation ?? identity.run_generation } as ProviderIdentity)) throw new ProviderIdentityError('Desktop provider returned a different thread, session, workspace, host or generation.');
  }

  async probe(request: ProviderProbeRequest = {}): Promise<CapabilityReceipt> {
    this.ensureOpen();
    if (!this.transport || !completeIdentity(request.target) || !this.identity) { this._receipt = unavailableReceipt(request.target, 'Desktop shared transport or trusted original-thread identity is unavailable.'); return this.receipt; }
    const identity = this.target(request);
    try {
      const response = await this.call<any>(this.methods.probe, identity, { identity: fenceFor(identity) });
      this.verifyReturnedIdentity(response, identity);
      const raw = asObject(response) ?? {};
      const caps = asObject(raw.capabilities) ?? this.transport.metadata?.capabilities ?? ALL_PROVIDER_CAPABILITIES;
      const observedIdentity = { ...(identityFrom(this.transport.metadata) ?? {}), ...(identityFrom(response) ?? {}) };
      const requiredIdentityFields = ['target_thread_id', 'target_session_id', 'workspace', 'host_instance_id', 'host_fingerprint', 'task_version', 'run_generation'] as const;
      const identityVerified = requiredIdentityFields.every((key) => observedIdentity[key] !== undefined)
        && identityMatches(identity, { ...identity, ...observedIdentity } as ProviderIdentity);
      const protocolVersion = typeof raw.protocol_version === 'string' ? raw.protocol_version : this.transport.metadata?.protocol_version ?? null;
      const providerVersion = typeof raw.provider_version === 'string' ? raw.provider_version : this.transport.metadata?.provider_version ?? null;
      const endpointFingerprint = typeof raw.endpoint_fingerprint === 'string' ? raw.endpoint_fingerprint : this.transport.metadata?.endpoint_fingerprint ?? null;
      const metadataComplete = nonEmpty(protocolVersion) && nonEmpty(providerVersion) && nonEmpty(endpointFingerprint);
      if (!identityVerified) throw new ProviderIdentityError('Desktop transport did not return verifiable original-thread identity.');
      const available = raw.available !== false && raw.same_thread_verified !== false && identityVerified && metadataComplete;
      const limitation = available ? null : String(raw.limitation_reason ?? (metadataComplete ? 'Desktop provider did not verify same-thread identity.' : 'Desktop provider handshake did not prove protocol, provider and endpoint identity.'));
      this._receipt = createCapabilityReceipt({ ...this._receipt, provider_kind: this.kind, evidence_level: this.transport.metadata?.evidence_level ?? 'live', available, attached: available, same_thread_verified: available, capabilities: { ...ALL_PROVIDER_CAPABILITIES, ...caps } as ProviderCapabilitySet, protocol_version: protocolVersion, provider_version: providerVersion, endpoint_fingerprint: endpointFingerprint, limitation_reason: limitation });
      this.event('capability_probe', { available: this._receipt.available, same_thread_verified: this._receipt.same_thread_verified });
    } catch (error) {
      this._receipt = unavailableReceipt(identity, error instanceof Error ? error.message : 'Desktop provider capability probe failed.');
      this.event('capability_probe', { available: false, limitation_reason: this._receipt.limitation_reason });
    }
    return this.receipt;
  }

  private available(identity: ProviderIdentity): void { if (!this._receipt.available || !this._receipt.same_thread_verified) throw new ProviderIdentityError(this._receipt.limitation_reason ?? 'Desktop provider is unavailable or same-thread identity is unverified.'); }
  private snapshot(value: unknown, identity: ProviderIdentity): ProviderThreadSnapshot {
    this.verifyReturnedIdentity(value, identity); const raw = asObject(value) ?? {}; const thread = asObject(raw.thread) ?? raw; const threadId = typeof thread.thread_id === 'string' ? thread.thread_id : typeof thread.id === 'string' ? thread.id : identity.target_thread_id; const sessionId = typeof thread.session_id === 'string' ? thread.session_id : identity.target_session_id; if (threadId !== identity.target_thread_id || sessionId !== identity.target_session_id) throw new ProviderIdentityError('Desktop provider returned a different thread or session.'); const turns = Array.isArray(thread.turns) ? thread.turns.map(turnOf) : []; const writer = writerOf(thread.writer ?? raw.writer ?? thread.status); const threadStatus = asObject(thread.status)?.type ?? thread.status; return { thread_id: threadId, session_id: sessionId, workspace: typeof thread.workspace === 'string' ? thread.workspace : identity.workspace, status: statusOf(threadStatus), writer, turns, latest_activity_at: typeof thread.latest_activity_at === 'string' ? thread.latest_activity_at : turns.at(-1)?.completed_at ?? turns.at(-1)?.started_at ?? null, observed_at: now() };
  }

  async readThread(request: ProviderRequest): Promise<ProviderThreadSnapshot> {
    this.ensureOpen(); const identity = this.target(request); this.available(identity);
    const result = this.snapshot(await this.call(this.methods.read_thread, identity, { threadId: identity.target_thread_id, includeTurns: true }), identity);
    this.event('thread_read', { status: result.status, writer: result.writer.status, turn_count: result.turns.length }); return result;
  }

  async readWriter(request: ProviderRequest): Promise<ProviderWriterState> {
    this.ensureOpen(); const identity = this.target(request); this.available(identity);
    try {
      const result = writerOf(await this.call(this.methods.read_writer, identity, { threadId: identity.target_thread_id }));
      this.event('writer_state', { status: result.status, reason: result.reason }, null, result.turn_id); return result;
    } catch {
      const snapshot = await this.readThread(request); this.event('writer_state', { status: snapshot.writer.status, reason: snapshot.writer.reason }, null, snapshot.writer.turn_id); return snapshot.writer;
    }
  }

  async resume(request: ProviderRequest): Promise<ProviderResumeResult> {
    this.ensureOpen(); const identity = this.target(request); this.available(identity);
    try {
      const result = this.snapshot(await this.call(this.methods.resume, identity, { threadId: identity.target_thread_id }), identity);
      const status = result.writer.status === 'in-progress' || result.writer.status === 'active-writer' ? 'active_writer' : 'attached';
      this.event('resume', { status, created_worker: false }, null, result.writer.turn_id); return { ...result, status, created_worker: false };
    } catch (error) {
      if (activeWriterError(error)) {
        const writer = await this.readWriter(request).catch(() => ({ status: 'active-writer', owner_session_id: identity.target_session_id, turn_id: null, reason: String(error), observed_at: now() } as ProviderWriterState));
        const snapshot: ProviderThreadSnapshot = { thread_id: identity.target_thread_id, session_id: identity.target_session_id, workspace: identity.workspace, status: 'in-progress', writer: { ...writer, status: 'active-writer' }, turns: [], latest_activity_at: null, observed_at: now() };
        this.event('resume', { status: 'active_writer', created_worker: false }, null, snapshot.writer.turn_id); return { ...snapshot, status: 'active_writer', created_worker: false };
      }
      throw error;
    }
  }

  async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    this.ensureOpen(); const identity = this.target(request); this.available(identity);
    const existing = this.deliveries.get(request.delivery_id);
    if (existing) return { delivery_id: request.delivery_id, outcome: existing.status === 'confirmed' ? 'confirmed' : 'already-present', target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: existing.target_turn_id, created_worker: false, reason: 'Delivery is already recorded; provider will not send a duplicate.', observed_at: now() };
    const remote = await this.reconcileDelivery({ target: identity, delivery_id: request.delivery_id, message: request.message, client_message_id: request.delivery_id, target_turn_id: null });
    if (remote.outcome !== 'not_found') {
      const mapped = remote.outcome === 'confirmed' ? 'confirmed' : remote.outcome === 'active_writer' ? 'active-writer' : remote.outcome === 'unavailable' ? 'unavailable' : remote.outcome === 'sent' ? 'already-present' : 'unknown';
      this.deliveries.set(request.delivery_id, { delivery_id: request.delivery_id, message: request.message, status: mapped, target_turn_id: remote.target_turn_id, client_message_id: request.delivery_id, observed_at: now() });
      return { delivery_id: request.delivery_id, outcome: mapped, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: remote.target_turn_id, created_worker: false, reason: remote.reason ?? 'Remote history did not prove that this delivery is absent; send is fenced.', observed_at: now() };
    }
    this.deliveries.set(request.delivery_id, { delivery_id: request.delivery_id, message: request.message, status: 'prepared', target_turn_id: null, client_message_id: request.delivery_id, observed_at: now() });
    this.event('send_prepared', { message_length: request.message.length }, request.delivery_id);
    try {
      const raw = asObject(await this.call(this.methods.send, identity, { threadId: identity.target_thread_id, delivery_id: request.delivery_id, client_message_id: request.delivery_id, message: request.message })) ?? {};
      this.verifyReturnedIdentity(raw, identity);
      const outcome = ['sent', 'confirmed', 'already-present', 'unknown', 'active-writer', 'unavailable'].includes(String(raw.outcome)) ? String(raw.outcome) as ProviderDeliveryStatus : 'unknown';
      const turnId = typeof raw.target_turn_id === 'string' ? raw.target_turn_id : typeof raw.turn_id === 'string' ? raw.turn_id : null;
      this.deliveries.set(request.delivery_id, { delivery_id: request.delivery_id, message: request.message, status: outcome, target_turn_id: turnId, client_message_id: request.delivery_id, observed_at: now() });
      this.event('send_sent', { outcome }, request.delivery_id, turnId);
      return { delivery_id: request.delivery_id, outcome, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: turnId, created_worker: false, reason: typeof raw.reason === 'string' ? raw.reason : outcome === 'unknown' ? 'Send outcome is unknown; reconcile original-thread history before retrying.' : null, observed_at: now() };
    } catch (error) {
      if (error instanceof ProviderIdentityError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const outcome: ProviderDeliveryStatus = activeWriterError(error) ? 'active-writer' : 'unknown';
      this.deliveries.set(request.delivery_id, { delivery_id: request.delivery_id, message: request.message, status: outcome, target_turn_id: null, client_message_id: request.delivery_id, observed_at: now() });
      this.event('send_sent', { outcome, reason }, request.delivery_id);
      return { delivery_id: request.delivery_id, outcome, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: null, created_worker: false, reason, observed_at: now() };
    }
  }

  async subscribe(request: ProviderRequest, listener: ProviderEventListener): Promise<ProviderSubscription> {
    this.ensureOpen(); const identity = this.target(request); this.available(identity); this.listeners.add(listener);
    const upstream = this.transport?.subscribe ? await this.transport.subscribe((raw) => {
      const observed = identityFrom(raw); if (observed && !identityMatches(identity, { ...identity, ...observed, target_thread_id: observed.target_thread_id ?? identity.target_thread_id, target_session_id: observed.target_session_id ?? identity.target_session_id, workspace: observed.workspace ?? identity.workspace, host_instance_id: observed.host_instance_id ?? identity.host_instance_id, host_fingerprint: observed.host_fingerprint ?? identity.host_fingerprint, task_version: observed.task_version ?? identity.task_version, run_generation: observed.run_generation ?? identity.run_generation } as ProviderIdentity)) return;
      const event = asObject(raw); if (event && typeof event.type === 'string') listener(createProviderEvent({ type: event.type as ProviderEventType, provider_kind: this._receipt.provider_kind, evidence_level: this._receipt.evidence_level, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, workspace: identity.workspace, host_fingerprint: identity.host_fingerprint, task_version: identity.task_version, run_generation: identity.run_generation, delivery_id: typeof event.delivery_id === 'string' ? event.delivery_id : null, turn_id: typeof event.turn_id === 'string' ? event.turn_id : null, payload: event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {} }));
    }) : null;
    return { unsubscribe: () => { this.listeners.delete(listener); upstream?.unsubscribe(); } };
  }

  async readHistory(request: ProviderHistoryRequest): Promise<ProviderHistoryPage> {
    this.ensureOpen(); const identity = this.target(request); this.available(identity);
    try {
      const raw = asObject(await this.call(this.methods.read_history, identity, { threadId: identity.target_thread_id, cursor: request.cursor ?? null })) ?? {};
      this.verifyReturnedIdentity(raw, identity); const turns = Array.isArray(raw.turns) ? raw.turns.map(turnOf) : []; return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns, has_more: raw.has_more === true, cursor: typeof raw.cursor === 'string' ? raw.cursor : null, readable: raw.readable !== false, limitation_reason: typeof raw.limitation_reason === 'string' ? raw.limitation_reason : null, observed_at: now() };
    } catch (error) {
      if (error instanceof ProviderIdentityError) throw error;
      return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns: [], has_more: false, cursor: null, readable: false, limitation_reason: error instanceof Error ? error.message : String(error), observed_at: now() };
    }
  }

  async reconcileDelivery(request: ProviderReconciliationRequest): Promise<DeliveryReconciliation> {
    this.ensureOpen(); const identity = this.target(request); this.available(identity); const at = now(); const local = this.deliveries.get(request.delivery_id);
    if (local?.status === 'confirmed') return { delivery_id: request.delivery_id, outcome: 'confirmed', matched_by: 'delivery_id', target_turn_id: local.target_turn_id, reason: null, observed_at: at };
    if (local?.status === 'unknown') {
      // Unknown is a hard no-resend fence. Reconciliation may still ask the host.
    }
    try {
      const raw = asObject(await this.call(this.methods.reconcile_delivery, identity, { threadId: identity.target_thread_id, delivery_id: request.delivery_id, client_message_id: request.client_message_id ?? request.delivery_id, target_turn_id: request.target_turn_id ?? null, message: request.message ?? null })) ?? {};
      this.verifyReturnedIdentity(raw, identity); const outcome = ['confirmed', 'sent', 'unknown', 'not_found', 'active_writer', 'unavailable'].includes(String(raw.outcome)) ? String(raw.outcome) as DeliveryReconciliation['outcome'] : 'unknown'; const matched = ['delivery_id', 'client_message_id', 'target_turn_id', 'activity', 'none'].includes(String(raw.matched_by)) ? String(raw.matched_by) as DeliveryMatch : 'none'; const targetTurn = typeof raw.target_turn_id === 'string' ? raw.target_turn_id : null; if (local) this.deliveries.set(request.delivery_id, { ...local, status: outcome === 'confirmed' ? 'confirmed' : outcome === 'sent' ? 'sent' : outcome === 'active_writer' ? 'active-writer' : outcome === 'unavailable' ? 'unavailable' : outcome === 'unknown' ? 'unknown' : local.status, target_turn_id: targetTurn, observed_at: at }); const result = { delivery_id: request.delivery_id, outcome, matched_by: matched, target_turn_id: targetTurn, reason: typeof raw.reason === 'string' ? raw.reason : null, observed_at: at }; this.event('delivery_reconciled', { outcome, matched_by: matched, reason: result.reason }, request.delivery_id, targetTurn); return result;
    } catch (error) {
      if (error instanceof ProviderIdentityError) throw error;
      const result = { delivery_id: request.delivery_id, outcome: 'unknown' as const, matched_by: 'none' as const, target_turn_id: null, reason: error instanceof Error ? error.message : String(error), observed_at: at };
      this.event('delivery_reconciled', { outcome: result.outcome, reason: result.reason }, request.delivery_id);
      return result;
    }
  }

  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.listeners.clear(); this._receipt = { ...this._receipt, attached: false }; this.event('closed', {}); await this.transport?.close?.(); }
}

export interface SimulatedProviderScenario {
  identity?: Partial<ProviderIdentity> | null;
  provider_kind?: ProviderKind;
  protocol_version?: string | null;
  provider_version?: string | null;
  endpoint_fingerprint?: string | null;
  writer_state?: ProviderWriterState;
  thread_status?: ProviderThreadStatus;
  turns?: ProviderTurn[];
  deliveries?: ProviderDelivery[];
  send_outcomes?: ('sent' | 'unknown' | 'active-writer' | 'unavailable')[];
  history_readable?: boolean;
}

export class SimulatedMainSessionProvider implements MainSessionProvider {
  readonly kind: ProviderKind = 'simulated';
  private readonly identity: ProviderIdentity | null;
  private readonly scenario: SimulatedProviderScenario;
  private writer: ProviderWriterState;
  private threadStatus: ProviderThreadStatus;
  private turns: ProviderTurn[];
  private readonly deliveries = new Map<string, ProviderDelivery>();
  private readonly listeners = new Set<ProviderEventListener>();
  private sendOutcomes: ('sent' | 'unknown' | 'active-writer' | 'unavailable')[];
  private closed = false;
  private _receipt: CapabilityReceipt;

  constructor(scenario: SimulatedProviderScenario = {}) {
    this.scenario = scenario;
    this.identity = completeIdentity(scenario.identity) ? { ...scenario.identity, main_session_id: scenario.identity.main_session_id ?? scenario.identity.target_thread_id } as ProviderIdentity : null;
    this.writer = clone(scenario.writer_state ?? { status: 'idle', owner_session_id: null, turn_id: null, reason: null, observed_at: now() });
    this.threadStatus = scenario.thread_status ?? (this.writer.status === 'in-progress' || this.writer.status === 'active-writer' ? 'in-progress' : 'idle');
    this.turns = clone(scenario.turns ?? []);
    for (const delivery of scenario.deliveries ?? []) this.deliveries.set(delivery.delivery_id, clone(delivery));
    this.sendOutcomes = [...(scenario.send_outcomes ?? [])];
    this._receipt = this.identity
      ? createCapabilityReceipt({ provider_kind: 'simulated', evidence_level: 'simulated', available: true, attached: true, same_thread_verified: true, capabilities: ALL_PROVIDER_CAPABILITIES, target_thread_id: this.identity.target_thread_id, target_session_id: this.identity.target_session_id, main_session_id: this.identity.main_session_id ?? this.identity.target_thread_id, workspace: this.identity.workspace, host_instance_id: this.identity.host_instance_id, host_fingerprint: this.identity.host_fingerprint, task_version: this.identity.task_version, run_generation: this.identity.run_generation, contract_sha256: this.identity.contract_sha256 ?? null, protocol_version: scenario.protocol_version ?? 'simulated-provider/1', provider_version: scenario.provider_version ?? 'simulated', endpoint_fingerprint: scenario.endpoint_fingerprint ?? 'simulated-endpoint' })
      : unavailableReceipt(scenario.identity, 'Trusted provider identity is unavailable; target thread/session and host fingerprint are required.');
  }

  get receipt(): CapabilityReceipt { return clone(this._receipt); }

  private ensureOpen(): void { if (this.closed) throw new Error('Provider is closed.'); }
  private target(request: ProviderRequest | ProviderProbeRequest): ProviderIdentity {
    const candidate = request.target;
    if (!completeIdentity(candidate)) throw new ProviderIdentityError('Trusted provider identity is unavailable; target thread/session, absolute workspace, host fingerprint, task version and run generation are required.');
    const identity = { ...candidate, main_session_id: candidate.main_session_id ?? candidate.target_thread_id } as ProviderIdentity;
    if (!this.identity || !identityMatches(this.identity, identity)) throw new ProviderIdentityError('Provider target identity does not match the registered original thread, workspace, host or generation.');
    return identity;
  }
  private event(type: ProviderEventType, payload: Record<string, unknown>, deliveryId: string | null = null, turnId: string | null = null): ProviderEvent {
    const event = providerEventFrom(this._receipt, type, payload, deliveryId, turnId);
    for (const listener of [...this.listeners]) { try { listener(clone(event)); } catch { /* observers cannot break provider state */ } }
    return event;
  }
  private snapshot(identity: ProviderIdentity): ProviderThreadSnapshot {
    return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, workspace: identity.workspace, status: this.threadStatus, writer: clone(this.writer), turns: clone(this.turns), latest_activity_at: this.turns.at(-1)?.completed_at ?? this.turns.at(-1)?.started_at ?? null, observed_at: now() };
  }

  async probe(request: ProviderProbeRequest = {}): Promise<CapabilityReceipt> {
    this.ensureOpen();
    if (!completeIdentity(request.target) || !this.identity) {
      this._receipt = unavailableReceipt(request.target, 'Trusted provider identity is unavailable; target thread/session, absolute workspace, host fingerprint, task version and run generation are required.');
    } else if (!identityMatches(this.identity, { ...request.target, main_session_id: request.target.main_session_id ?? request.target.target_thread_id } as ProviderIdentity)) {
      this._receipt = unavailableReceipt(request.target, 'Provider target identity does not match the registered original thread, workspace, host or generation.');
    } else {
      this._receipt = createCapabilityReceipt({ ...this._receipt, provider_kind: 'simulated', evidence_level: 'simulated', available: true, attached: true, same_thread_verified: true, limitation_reason: null });
    }
    this.event('capability_probe', { available: this._receipt.available, limitation_reason: this._receipt.limitation_reason });
    return this.receipt;
  }

  async readThread(request: ProviderRequest): Promise<ProviderThreadSnapshot> {
    this.ensureOpen(); const identity = this.target(request);
    if (!this._receipt.available) throw new ProviderIdentityError(this._receipt.limitation_reason ?? 'Provider unavailable.');
    const result = this.snapshot(identity); this.event('thread_read', { status: result.status, turn_count: result.turns.length }); return result;
  }

  async readWriter(request: ProviderRequest): Promise<ProviderWriterState> {
    this.ensureOpen(); this.target(request); if (!this._receipt.available) throw new ProviderIdentityError(this._receipt.limitation_reason ?? 'Provider unavailable.');
    const result = { ...clone(this.writer), observed_at: now() }; this.writer = result; this.event('writer_state', { status: result.status }, null, result.turn_id); return clone(result);
  }

  async resume(request: ProviderRequest): Promise<ProviderResumeResult> {
    const thread = await this.readThread(request);
    const status = this.writer.status === 'in-progress' || this.writer.status === 'active-writer' ? 'active_writer' : 'attached';
    this.event('resume', { status, created_worker: false });
    return { ...thread, status, created_worker: false };
  }

  async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
    this.ensureOpen(); const identity = this.target(request);
    if (!this._receipt.available) return { delivery_id: request.delivery_id, outcome: 'unavailable', target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: null, created_worker: false, reason: this._receipt.limitation_reason ?? 'Provider unavailable.', observed_at: now() };
    this.event('send_prepared', { message_length: request.message.length }, request.delivery_id);
    const existing = this.deliveries.get(request.delivery_id);
    if (existing) return { delivery_id: request.delivery_id, outcome: 'already-present', target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: existing.target_turn_id, created_worker: false, reason: 'Delivery already exists in the original thread history.', observed_at: now() };
    if (this.writer.status === 'in-progress' || this.writer.status === 'active-writer') {
      this.event('writer_state', { status: this.writer.status, reason: 'active writer; send deferred' }, request.delivery_id, this.writer.turn_id);
      return { delivery_id: request.delivery_id, outcome: 'active-writer', target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: null, created_worker: false, reason: 'The original A currently owns an active writer.', observed_at: now() };
    }
    const outcome = this.sendOutcomes.shift() ?? 'sent';
    const turnId = outcome === 'sent' ? `turn-${this.turns.length + 1}` : null;
    const delivery: ProviderDelivery = { delivery_id: request.delivery_id, message: request.message, status: outcome, target_turn_id: turnId, client_message_id: request.delivery_id, observed_at: now() };
    this.deliveries.set(request.delivery_id, delivery);
    if (turnId) this.turns.push({ turn_id: turnId, status: 'in-progress', started_at: now(), completed_at: null, items: [{ type: 'user_message', client_message_id: request.delivery_id, delivery_id: request.delivery_id, value: request.message }] });
    this.event('send_sent', { outcome }, request.delivery_id, turnId);
    return { delivery_id: request.delivery_id, outcome, target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, target_turn_id: turnId, created_worker: false, reason: outcome === 'unknown' ? 'The send outcome is unknown; reconcile against the original thread history before retrying.' : null, observed_at: now() };
  }

  async subscribe(request: ProviderRequest, listener: ProviderEventListener): Promise<ProviderSubscription> {
    this.ensureOpen(); this.target(request); if (!this._receipt.available) throw new ProviderIdentityError(this._receipt.limitation_reason ?? 'Provider unavailable.');
    this.listeners.add(listener);
    return { unsubscribe: () => { this.listeners.delete(listener); } };
  }

  async readHistory(request: ProviderHistoryRequest): Promise<ProviderHistoryPage> {
    this.ensureOpen(); const identity = this.target(request);
    if (!this._receipt.available) return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns: [], has_more: false, cursor: null, readable: false, limitation_reason: this._receipt.limitation_reason ?? 'Provider unavailable.', observed_at: now() };
    if (this.scenario.history_readable === false) return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns: [], has_more: false, cursor: null, readable: false, limitation_reason: 'Original thread history is unreadable.', observed_at: now() };
    return { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns: clone(this.turns), has_more: false, cursor: null, readable: true, limitation_reason: null, observed_at: now() };
  }

  async reconcileDelivery(request: ProviderReconciliationRequest): Promise<DeliveryReconciliation> {
    this.ensureOpen(); this.target(request);
    const at = now(); const delivery = this.deliveries.get(request.delivery_id);
    let result: DeliveryReconciliation;
    if (!this._receipt.available) result = { delivery_id: request.delivery_id, outcome: 'unavailable', matched_by: 'none', target_turn_id: null, reason: this._receipt.limitation_reason ?? 'Provider unavailable.', observed_at: at };
    else if (delivery?.status === 'confirmed') result = { delivery_id: request.delivery_id, outcome: 'confirmed', matched_by: 'delivery_id', target_turn_id: delivery.target_turn_id, reason: null, observed_at: at };
    else if (delivery?.status === 'sent' || delivery?.status === 'already-present') result = { delivery_id: request.delivery_id, outcome: 'sent', matched_by: 'delivery_id', target_turn_id: delivery.target_turn_id, reason: 'A matching user message exists, but A activity is not confirmed.', observed_at: at };
    else if (delivery?.status === 'active-writer') result = { delivery_id: request.delivery_id, outcome: 'active_writer', matched_by: 'none', target_turn_id: delivery.target_turn_id, reason: 'The original A owns an active writer.', observed_at: at };
    else if (delivery?.status === 'unavailable') result = { delivery_id: request.delivery_id, outcome: 'unavailable', matched_by: 'none', target_turn_id: delivery.target_turn_id, reason: 'The provider could not confirm delivery.', observed_at: at };
    else if (delivery?.status === 'unknown') result = { delivery_id: request.delivery_id, outcome: 'unknown', matched_by: 'none', target_turn_id: null, reason: 'No matching history or A activity confirmation exists yet.', observed_at: at };
    else {
      const match = this.turns.find(turn => turn.items.some(item => item.client_message_id === (request.client_message_id ?? request.delivery_id) || item.delivery_id === request.delivery_id || (request.target_turn_id !== null && request.target_turn_id !== undefined && turn.turn_id === request.target_turn_id)));
      result = match ? { delivery_id: request.delivery_id, outcome: 'sent', matched_by: match.turn_id === request.target_turn_id ? 'target_turn_id' : 'client_message_id', target_turn_id: match.turn_id, reason: 'A matching message exists in the original thread history.', observed_at: at } : { delivery_id: request.delivery_id, outcome: 'not_found', matched_by: 'none', target_turn_id: null, reason: 'No matching delivery, client message or target turn exists in the original thread history.', observed_at: at };
    }
    this.event('delivery_reconciled', { outcome: result.outcome, matched_by: result.matched_by, reason: result.reason }, request.delivery_id, result.target_turn_id);
    return result;
  }

  /** Simulated host control used by tests to represent native A activity. */
  confirmActivity(deliveryId: string, turnId?: string): ProviderActivity {
    const delivery = this.deliveries.get(deliveryId);
    const targetTurn = turnId ?? delivery?.target_turn_id ?? `turn-${this.turns.length + 1}`;
    if (delivery) { delivery.status = 'confirmed'; delivery.target_turn_id = targetTurn; delivery.observed_at = now(); }
    else this.deliveries.set(deliveryId, { delivery_id: deliveryId, message: '', status: 'confirmed', target_turn_id: targetTurn, client_message_id: deliveryId, observed_at: now() });
    const turn = this.turns.find(value => value.turn_id === targetTurn);
    if (turn) { turn.status = 'completed'; turn.completed_at = now(); }
    else this.turns.push({ turn_id: targetTurn, status: 'completed', started_at: now(), completed_at: now(), items: [{ type: 'user_message', client_message_id: deliveryId, delivery_id: deliveryId }] });
    this.threadStatus = 'idle'; this.writer = { status: 'idle', owner_session_id: null, turn_id: null, reason: null, observed_at: now() };
    const activity: ProviderActivity = { event_id: randomUUID(), type: 'activity', target_thread_id: this._receipt.target_thread_id!, target_session_id: this._receipt.target_session_id!, turn_id: targetTurn, delivery_id: deliveryId, observed_at: now(), details: { confirmed: true } };
    this.event('activity', activity.details, deliveryId, targetTurn);
    return activity;
  }

  setWriterState(writer: ProviderWriterState): void { this.writer = clone({ ...writer, observed_at: now() }); this.threadStatus = writer.status === 'in-progress' || writer.status === 'active-writer' ? 'in-progress' : 'idle'; this.event('writer_state', { status: writer.status, reason: writer.reason }, null, writer.turn_id); }

  async close(): Promise<void> { if (this.closed) return; this.event('closed', {}); this.closed = true; this.listeners.clear(); }
}

export function createSimulatedMainSessionProvider(scenario: SimulatedProviderScenario = {}): SimulatedMainSessionProvider { return new SimulatedMainSessionProvider(scenario); }
export const createSimulatedProvider = createSimulatedMainSessionProvider;
