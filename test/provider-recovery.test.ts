import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverMainSessionWithProvider, invalidateProviderRecovery } from '../src/provider-recovery.js';
import { SimulatedMainSessionProvider, type MainSessionProvider, type ProviderIdentity } from '../src/main-session-provider.js';
import type { MainSessionState } from '../src/main-session.js';

const identity: ProviderIdentity = {
  target_thread_id: 'thread-A', target_session_id: 'session-A', main_session_id: 'thread-A', workspace: process.cwd(), host_instance_id: 'desktop-1', host_fingerprint: 'fingerprint-1', task_version: 3, run_generation: 'generation-1', contract_sha256: 'contract-1',
};

function state(pending = true): MainSessionState {
  return {
    schema_version: 1, task_id: 'provider-recovery', task_version: 3, task: { schema_version: 1, task_id: 'provider-recovery', workspace: process.cwd(), goal: 'goal', acceptance: [], authorization: 'local', limits: { max_worker_turns: null, max_minutes: null } },
    workspace: process.cwd(), control_mode: 'main-session', main_session_id: identity.target_session_id, run_generation: identity.run_generation, contract_sha256: identity.contract_sha256!, binding: { status: 'BOUND', tool_use_id: null, bound_at: new Date().toISOString(), challenge: 'challenge', task_path: 'task.json' }, host: { desktop_version: '1', cli_version: '1', hook_effective: true, source: 'native-desktop', reason: '' }, status: 'ACTIVE', phase: 'RECOVERING', worker_thread_id: identity.target_thread_id, active_worker_turn_id: null, reviewing_turn_id: null, handled_turn_ids: [], pending_action: pending ? { delivery_id: 'delivery-1', source_turn_id: 'turn-0', task_version: 3, message: 'continue', stage: 'sent', target_turn_id: null } : null, retry: { kind: null, attempt: 0, next_at: null }, last_decision: null, worker_turn_count: 1, elapsed_active_seconds: 0, updated_at: new Date().toISOString(), codex_version: null, mode: 'simulated', input_epoch: 1, continuation_confirmed: false,
  } as MainSessionState;
}

test('provider recovery stays honest when the provider is unavailable', async () => {
  const saved = state();
  const provider = new SimulatedMainSessionProvider({ identity: null });
  const result = await recoverMainSessionWithProvider(saved, provider, { identity });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(saved.status, 'WAIT_EXTERNAL');
  assert.equal(saved.phase, 'RECOVERING');
  assert.equal(saved.continuation_confirmed, false);
  assert.equal(saved.provider?.same_thread_verified, false);
  assert.equal(saved.recovery_condition?.kind, 'recovery_desktop_provider_unavailable');
});

test('provider recovery sends an absent delivery once and waits for A activity', async () => {
  const saved = state();
  const provider = new SimulatedMainSessionProvider({ identity, send_outcomes: ['sent'] });
  const result = await recoverMainSessionWithProvider(saved, provider, { identity });
  assert.equal(result.outcome, 'waiting');
  assert.equal(result.delivery?.outcome, 'sent');
  assert.equal(saved.continuation_confirmed, false);
  assert.equal(saved.status, 'WAIT_EXTERNAL');
  assert.equal(saved.recovery_condition?.kind, 'recovery_delivery_unknown');
});

test('late provider results are fenced after the generation or input epoch changes', async () => {
  const saved = state();
  let current = saved;
  const provider = new SimulatedMainSessionProvider({ identity, send_outcomes: ['sent'] });
  const result = await recoverMainSessionWithProvider(saved, provider, { identity, currentState: () => current });
  assert.notEqual(result.outcome, 'stale');
  invalidateProviderRecovery(saved, 'new user input');
  current = { ...saved, run_generation: 'new-generation', input_epoch: 2 } as MainSessionState;
  assert.equal(saved.continuation_confirmed, false);
  assert.equal(saved.provider?.status, 'disconnected');
});

test('pause and done invalidation prevent a provider result from restoring WORKER', () => {
  const saved = state(false);
  invalidateProviderRecovery(saved, 'user paused', 'pause');
  assert.equal(saved.status, 'PAUSED');
  assert.equal(saved.phase, 'IDLE');
  invalidateProviderRecovery(saved, 'task completed', 'done');
  assert.equal(saved.status, 'DONE');
  assert.equal(saved.continuation_confirmed, false);
});

test('provider recovery requires same-thread activity before setting continuation confirmation', async () => {
  const saved = state();
  const provider = new SimulatedMainSessionProvider({ identity, deliveries: [{ delivery_id: 'delivery-1', message: 'continue', status: 'confirmed', target_turn_id: 'turn-2', client_message_id: 'delivery-1' }] });
  const result = await recoverMainSessionWithProvider(saved, provider, { identity });
  assert.equal(result.outcome, 'waiting');
  assert.equal(saved.continuation_confirmed, false);
  assert.equal(saved.phase, 'RECOVERING');
});
