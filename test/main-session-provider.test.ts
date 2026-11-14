import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PROVIDER_CAPABILITIES,
  DesktopMainSessionProvider,
  SimulatedMainSessionProvider,
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
};

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
    metadata: { provider_kind: 'shared-server', evidence_level: 'live', identity, protocol_version: 'codex-cli 0.167.0', endpoint_fingerprint: 'endpoint-1' },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'provider/probe') return { available: true, same_thread_verified: true, identity, capabilities: ALL_PROVIDER_CAPABILITIES };
      if (method === 'thread/read') return { identity, thread: { id: identity.target_thread_id, session_id: identity.target_session_id, status: { type: 'idle' }, turns: [] } };
      return { identity, outcome: 'not_found', readable: true, turns: [] };
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
    metadata: { provider_kind: 'daemon', evidence_level: 'live', identity },
    async request(method) {
      if (method === 'provider/probe') return { available: true, same_thread_verified: true, identity, capabilities: ALL_PROVIDER_CAPABILITIES };
      if (method === 'thread/resume') throw new Error('active writer is in progress');
      if (method === 'thread/writer') return { identity, status: 'active-writer', owner_session_id: identity.target_session_id, turn_id: 'turn-A' };
      if (method === 'thread/send') { sendCalls += 1; return { identity, outcome: 'unknown' }; }
      if (method === 'thread/reconcile') return { identity, outcome: 'unknown', matched_by: 'none', reason: 'history is inconclusive' };
      return { identity, thread: { id: identity.target_thread_id, session_id: identity.target_session_id, status: 'inProgress', turns: [] } };
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
