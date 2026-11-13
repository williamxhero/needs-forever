import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeInventoryDecision, validateDecision } from '../src/index.js';
import type { Snapshot, Task } from '../src/types.js';

const task: Task = {
  schema_version: 1,
  task_id: 'ticket-79',
  workspace: process.cwd(),
  goal: 'Deliver a validated route action.',
  acceptance: [{ id: 'A1', text: 'The route action is delivered once.' }],
  authorization: 'Workspace only.',
  limits: { max_worker_turns: null, max_minutes: null },
};

function snapshot(): Snapshot {
  return {
    snapshot_id: 'snapshot-79',
    task_id: task.task_id,
    task_version: 1,
    worker_thread_id: 'worker-79',
    worker_turn_id: 'stop-79',
    task: structuredClone(task),
    evidence: [],
    evidence_complete: true,
    omissions: [],
  };
}

test('C2 admission derives the delivered prompt from selected route actions and records normalization at the native judgment seam', () => {
  const input = snapshot();
  const decision = routeInventoryDecision(input);
  const selected = decision.route_plan!.candidates.find((route) => route.route_id === decision.route_plan!.selected_route_id)!;
  decision.next_message = `Please carry out this same authorized inspection: ${selected.actions[0]}`;
  const validated = validateDecision(JSON.stringify(decision), input);
  assert.equal(validated.next_message, selected.actions.join('\n'));
});

test('C2 admission still rejects an ungrounded provider claim hidden in raw wording', () => {
  const input = snapshot();
  const decision = routeInventoryDecision(input);
  decision.next_message = 'The provider is available; retry it now.';
  assert.throws(() => validateDecision(JSON.stringify(decision), input), /derived from selected route actions/);
});
