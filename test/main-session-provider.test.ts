import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PROVIDER_CAPABILITIES,
  DesktopMainSessionProvider,
  ProviderIdentityError,
  ProviderSemanticsCore,
  SimulatedMainSessionProvider,
  createCapabilityReceipt,
  createProviderEvent,
  createProviderState,
  validateCapabilityReceipt,
  validateProviderEvent,
  validateProviderState,
  type DesktopRpcTransport,
  type ProviderIdentity,
} from '../src/main-session-provider.js';

const identity: ProviderIdentity = {
  target_thread_id: 'thread-A',
  target_session_id: 'session-A',
  workspace: process.cwd(),
  host_instance_id: 'desktop-1',
  host_fingerprint: 'desktop-fingerprint-1',
  task_version: 3,
  run_generation: 'generation-1',
  contract_sha256: 'contract-1',
  input_epoch: 4,
};

function availableReceipt(target: ProviderIdentity) {
  return createCapabilityReceipt({
    provider_kind: 'simulated',
    evidence_level: 'simulated',
    available: true,
    attached: true,
    same_thread_verified: true,
    capabilities: ALL_PROVIDER_CAPABILITIES,
    target_thread_id: target.target_thread_id,
    target_session_id: target.target_session_id,
    main_session_id: target.main_session_id ?? target.target_thread_id,
    workspace: target.workspace,
    host_instance_id: target.host_instance_id,
    host_fingerprint: target.host_fingerprint,
    task_version: target.task_version,
    run_generation: target.run_generation,
    input_epoch: target.input_epoch ?? null,
    contract_sha256: target.contract_sha256 ?? null,
    protocol_version: 'semantics-test/1',
    provider_version: 'semantics-test',
    endpoint_fingerprint: 'semantics-endpoint',
  });
}

test('provider semantics core applies one identity and input fence to every fact', () => {
  const core = new ProviderSemanticsCore({ identity, provider_kind: 'simulated', evidence_level: 'simulated' });
  core.acceptReceipt(availableReceipt(identity));
  assert.equal(core.receipt.input_epoch, 4);
  assert.equal(core.fence(identity).input_epoch, 4);
  assert.throws(() => core.assertTarget({ ...identity, input_epoch: 3 }), ProviderIdentityError);
  assert.throws(() => core.requireAvailable({ ...identity, run_generation: 'stale-generation' }), ProviderIdentityError);
  assert.equal(core.classifyWriter({ status: 'active-writer', owner_session_id: 'session-A', turn_id: 'turn-1' }).status, 'active-writer');
});

test('provider semantics core reconciles history in stable order and confirms only same-thread activity', () => {
  const core = new ProviderSemanticsCore({ identity, provider_kind: 'simulated', evidence_level: 'simulated' });
  core.acceptReceipt(availableReceipt(identity));
  core.seedDelivery({ delivery_id: 'delivery-1', message: 'continue', status: 'unknown', target_turn_id: null, client_message_id: 'client-1' });
  const history = { thread_id: identity.target_thread_id, session_id: identity.target_session_id, turns: [{ turn_id: 'turn-1', status: 'in-progress' as const, items: [{ type: 'user_message' as const, delivery_id: 'delivery-1', client_message_id: 'client-1' }] }], has_more: false, cursor: null, readable: true, limitation_reason: null, observed_at: new Date().toISOString() };
  const matched = core.reconcileHistory(identity, { delivery_id: 'delivery-1', client_message_id: 'client-1', history });
  assert.equal(matched.outcome, 'sent');
  assert.equal(matched.matched_by, 'delivery_id');
  const foreign = core.recordActivity({ target_thread_id: 'thread-foreign', target_session_id: identity.target_session_id, delivery_id: 'delivery-1' });
  assert.equal(foreign, null);
  const activity = core.recordActivity({ target_thread_id: identity.target_thread_id, target_session_id: identity.target_session_id, turn_id: 'turn-1', delivery_id: 'delivery-1', details: { source: 'same-thread' } });
  assert.equal(activity?.delivery_id, 'delivery-1');
  const confirmed = core.reconcileHistory(identity, { delivery_id: 'delivery-1', client_message_id: 'client-1', history });
  assert.equal(confirmed.outcome, 'confirmed');
  assert.equal(confirmed.matched_by, 'activity');
  core.seedDelivery({ delivery_id: 'delivery-unknown', message: 'again', status: 'unknown', target_turn_id: null, client_message_id: 'client-unknown' });
  const unknown = core.reconcileHistory(identity, { delivery_id: 'delivery-unknown', history: { ...history, turns: [], limitation_reason: null } });
  assert.equal(unknown.outcome, 'unknown');
});

test('provider semantics core emits disconnect and close exactly once while cleaning listeners', async () => {
  const core = new ProviderSemanticsCore({ identity, provider_kind: 'simulated', evidence_level: 'simulated' });
  core.acceptReceipt(availableReceipt(identity));
  const events: string[] = [];
  core.subscribe(event => events.push(event.type));
  core.disconnect('transport closed');
  assert.deepEqual(events, ['disconnected']);
  await core.close();
  assert.deepEqual(events, ['disconnected']);
  const second = new ProviderSemanticsCore({ identity, provider_kind: 'simulated', evidence_level: 'simulated' });
  second.acceptReceipt(availableReceipt(identity));
  const closed: string[] = [];
  second.subscribe(event => closed.push(event.type));
  await second.close();
  await second.close();
  assert.deepEqual(closed, ['closed']);
});

test('simulated provider capability receipt is durable and fail-closed for identity', async () => {
  const provider = new SimulatedMainSessionProvider({ identity });
  const receipt = await provider.probe({ target: identity });
  assert.equal(receipt.available, true);
  assert.equal(receipt.provider_kind, 'simulated');
  assert.equal(receipt.evidence_level, 'simulated');
  assert.equal(receipt.target_thread_id, 'thread-A');
  assert.equal(receipt.target_session_id, 'session-A');
  assert.equal(receipt.workspace, process.cwd());
  assert.equal(receipt.host_fingerprint, 'desktop-fingerprint-1');
  assert.equal(receipt.task_version, 3);
  assert.equal(receipt.run_generation, 'generation-1');
  assert.equal(validateCapabilityReceipt(JSON.parse(JSON.stringify(receipt))).target_thread_id, 'thread-A');

  const unavailable = await provider.probe({ target: { ...identity, host_fingerprint: '' } });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.provider_kind, 'unavailable');
  assert.match(unavailable.limitation_reason ?? '', /identity|fingerprint/i);
  const history = await provider.readHistory({ target: identity });
  assert.equal(history.readable, false);
});

test('simulated provider reads one thread, exposes active writer, and never creates a second worker', async () => {
  const provider = new SimulatedMainSessionProvider({
    identity,
    writer_state: { status: 'in-progress', owner_session_id: 'session-A', turn_id: 'turn-A', reason: null },
  });
  const thread = await provider.readThread({ target: identity });
  assert.equal(thread.thread_id, 'thread-A');
  assert.equal(thread.session_id, 'session-A');
  assert.equal(thread.writer.status, 'in-progress');
  const resumed = await provider.resume({ target: identity });
  assert.equal(resumed.thread_id, 'thread-A');
  assert.equal(resumed.created_worker, false);
  assert.equal(resumed.status, 'active_writer');
});

test('simulated provider reconciles existing and unknown deliveries and confirms A activity', async () => {
  const provider = new SimulatedMainSessionProvider({
    identity,
    deliveries: [{ delivery_id: 'already-there', message: 'continue', status: 'confirmed', target_turn_id: 'turn-2', client_message_id: 'already-there' }],
    send_outcomes: ['unknown'],
  });
  const existing = await provider.reconcileDelivery({ target: identity, delivery_id: 'already-there', message: 'continue' });
  assert.equal(existing.outcome, 'confirmed');
  assert.equal(existing.matched_by, 'delivery_id');

  const unknown = await provider.send({ target: identity, delivery_id: 'delivery-unknown', message: 'continue' });
  assert.equal(unknown.outcome, 'unknown');
  const stillUnknown = await provider.reconcileDelivery({ target: identity, delivery_id: 'delivery-unknown', message: 'continue' });
  assert.equal(stillUnknown.outcome, 'unknown');

  const activities: string[] = [];
  await provider.subscribe({ target: identity }, event => {
    if (event.type === 'activity' && event.delivery_id) activities.push(event.delivery_id);
  });
  provider.confirmActivity('delivery-unknown', 'turn-3');
  const confirmed = await provider.reconcileDelivery({ target: identity, delivery_id: 'delivery-unknown', message: 'continue' });
  assert.equal(confirmed.outcome, 'confirmed');
  assert.deepEqual(activities, ['delivery-unknown']);
});

test('provider event identity and unavailable delivery outcomes remain explicit', async () => {
  const provider = new SimulatedMainSessionProvider({ identity, send_outcomes: ['unavailable'] });
  const events: import('../src/main-session-provider.js').ProviderEvent[] = [];
  await provider.subscribe({ target: identity }, event => events.push(event));
  const result = await provider.send({ target: identity, delivery_id: 'delivery-unavailable', message: 'continue' });
  assert.equal(result.outcome, 'unavailable');
  const reconciliation = await provider.reconcileDelivery({ target: identity, delivery_id: 'delivery-unavailable' });
  assert.equal(reconciliation.outcome, 'unavailable');
  const sent = events.find(event => event.type === 'send_sent');
  assert.equal(sent?.task_version, identity.task_version);
  assert.equal(sent?.run_generation, identity.run_generation);
});

test('provider state and events survive JSON persistence with explicit identity fields', () => {
  const receipt = new SimulatedMainSessionProvider({ identity }).receipt;
  const state = createProviderState(receipt);
  assert.equal(validateProviderState(JSON.parse(JSON.stringify(state))).same_thread_verified, true);
  const event = createProviderEvent({
    type: 'delivery_reconciled',
    provider_kind: 'simulated',
    evidence_level: 'simulated',
    target_thread_id: 'thread-A',
    target_session_id: 'session-A',
    workspace: process.cwd(),
    host_fingerprint: 'desktop-fingerprint-1',
    task_version: 3,
    run_generation: 'generation-1',
    delivery_id: 'delivery-unknown',
    payload: { outcome: 'confirmed', matched_by: 'activity' },
  });
  assert.equal(validateProviderEvent(JSON.parse(JSON.stringify(event))).delivery_id, 'delivery-unknown');
});

test('desktop shared transport probes and preserves the original thread identity on every request', async () => {
  const calls: { method: string; params: any }[] = [];
  const transport: DesktopRpcTransport = {
    metadata: { provider_kind: 'shared-server', evidence_level: 'live', identity, protocol_version: 'codex-cli 0.167.0', provider_version: 'desktop-provider 1.0.0', endpoint_fingerprint: 'endpoint-1' },
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === 'provider/probe') return { available: true, same_thread_verified: true, identity, capabilities: ALL_PROVIDER_CAPABILITIES } as T;
      if (method === 'thread/read') return { identity, thread: { id: identity.target_thread_id, session_id: identity.target_session_id, status: { type: 'idle' }, turns: [] } } as T;
      return { identity, outcome: 'not_found', readable: true, turns: [] } as T;
    },
  };
  const provider = new DesktopMainSessionProvider({ identity, transport });
  const receipt = await provider.probe({ target: identity });
  assert.equal(receipt.available, true);
  assert.equal(receipt.same_thread_verified, true);
  const snapshot = await provider.readThread({ target: identity });
  assert.equal(snapshot.thread_id, identity.target_thread_id);
  assert.equal(snapshot.session_id, identity.target_session_id);
  assert.ok(calls.every(call => call.params.target_thread_id === identity.target_thread_id && call.params.target_session_id === identity.target_session_id && call.params.run_generation === identity.run_generation));
  await assert.rejects(() => provider.readThread({ target: { ...identity, run_generation: 'stale-generation' } }), /identity|generation|thread/i);
});

test('desktop provider maps active writer, fences unknown delivery, and never sends a duplicate', async () => {
  let sendCalls = 0;
  const transport: DesktopRpcTransport = {
    metadata: { provider_kind: 'daemon', evidence_level: 'live', identity, protocol_version: 'codex-cli 0.167.0', provider_version: 'desktop-provider 1.0.0', endpoint_fingerprint: 'endpoint-2' },
    async request<T>(method: string, _params: unknown): Promise<T> {
      if (method === 'provider/probe') return { available: true, same_thread_verified: true, identity, capabilities: ALL_PROVIDER_CAPABILITIES } as T;
      if (method === 'thread/resume') throw new Error('active writer is in progress');
      if (method === 'thread/writer') return { identity, status: 'active-writer', owner_session_id: identity.target_session_id, turn_id: 'turn-A' } as T;
      if (method === 'thread/send') { sendCalls += 1; return { identity, outcome: 'unknown' } as T; }
      if (method === 'thread/reconcile') return { identity, outcome: sendCalls === 0 ? 'not_found' : 'unknown', matched_by: 'none', reason: 'history is inconclusive' } as T;
      return { identity, thread: { id: identity.target_thread_id, session_id: identity.target_session_id, status: 'inProgress', turns: [] } } as T;
    },
  };
  const provider = new DesktopMainSessionProvider({ identity, transport });
  await provider.probe({ target: identity });
  const resumed = await provider.resume({ target: identity });
  assert.equal(resumed.status, 'active_writer');
  const first = await provider.send({ target: identity, delivery_id: 'delivery-1', message: 'continue' });
  const second = await provider.send({ target: identity, delivery_id: 'delivery-1', message: 'continue' });
  assert.equal(first.outcome, 'unknown');
  assert.equal(second.outcome, 'already-present');
  assert.equal(sendCalls, 1);
  const reconciliation = await provider.reconcileDelivery({ target: identity, delivery_id: 'delivery-1', message: 'continue' });
  assert.equal(reconciliation.outcome, 'unknown');
});

test('desktop and simulated adapters share same-thread activity confirmation semantics', async () => {
  let desktopActivity: ((event: unknown) => void) | undefined;
  const transport: DesktopRpcTransport = {
    metadata: { provider_kind: 'daemon', evidence_level: 'live', identity, protocol_version: 'codex-cli 0.167.0', provider_version: 'desktop-provider 1.0.0', endpoint_fingerprint: 'endpoint-shared-semantics' },
    async request<T>(method: string, _params: unknown): Promise<T> {
      if (method === 'provider/probe') return { available: true, same_thread_verified: true, identity, capabilities: ALL_PROVIDER_CAPABILITIES } as T;
      if (method === 'thread/reconcile') return { identity, outcome: 'not_found', matched_by: 'none', turns: [], readable: true } as T;
      if (method === 'thread/send') return { identity, outcome: 'sent', target_turn_id: 'turn-activity' } as T;
      return { identity, thread: { id: identity.target_thread_id, session_id: identity.target_session_id, status: 'idle', turns: [] } } as T;
    },
    subscribe(listener) {
      desktopActivity = listener;
      return { unsubscribe() { desktopActivity = undefined; } };
    },
  };

  const simulated = new SimulatedMainSessionProvider({ identity, send_outcomes: ['sent'] });
  const desktop = new DesktopMainSessionProvider({ identity, transport });
  await simulated.probe({ target: identity });
  await desktop.probe({ target: identity });

  await simulated.send({ target: identity, delivery_id: 'delivery-activity', message: 'continue' });
  await desktop.send({ target: identity, delivery_id: 'delivery-activity', message: 'continue' });
  await desktop.subscribe({ target: identity }, () => {});
  simulated.confirmActivity('delivery-activity', 'turn-activity');
  desktopActivity?.({ identity, type: 'activity', delivery_id: 'delivery-activity', turn_id: 'turn-activity', payload: { confirmed: true } });

  const simulatedResult = await simulated.reconcileDelivery({ target: identity, delivery_id: 'delivery-activity', message: 'continue' });
  const desktopResult = await desktop.reconcileDelivery({ target: identity, delivery_id: 'delivery-activity', message: 'continue' });
  assert.deepEqual(
    { outcome: simulatedResult.outcome, matched_by: simulatedResult.matched_by, target_turn_id: simulatedResult.target_turn_id },
    { outcome: 'confirmed', matched_by: 'activity', target_turn_id: 'turn-activity' },
  );
  assert.deepEqual(
    { outcome: desktopResult.outcome, matched_by: desktopResult.matched_by, target_turn_id: desktopResult.target_turn_id },
    { outcome: 'confirmed', matched_by: 'activity', target_turn_id: 'turn-activity' },
  );
});
