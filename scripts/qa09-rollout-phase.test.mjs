import test from 'node:test';
import assert from 'node:assert/strict';
import { qa09RolloutContext } from './esgiot-cdk.mjs';
test('QA09 rollout separates logging, budget and event publication and rejects silent phase mistakes', () => {
  assert.deepEqual(qa09RolloutContext({}), {
    enableRequestObservability: false,
    enableQa09Capacity: false,
    enableImmediateCommandPublish: false,
  });
  assert.deepEqual(qa09RolloutContext({ FDP_QA09_ROLLOUT_PHASE: 'observability' }), {
    enableRequestObservability: true,
    enableQa09Capacity: false,
    enableImmediateCommandPublish: false,
  });
  assert.deepEqual(qa09RolloutContext({ FDP_QA09_ROLLOUT_PHASE: 'capacity' }), {
    enableRequestObservability: true,
    enableQa09Capacity: true,
    enableImmediateCommandPublish: false,
  });
  assert.deepEqual(qa09RolloutContext({ FDP_QA09_ROLLOUT_PHASE: 'immediate' }), {
    enableRequestObservability: true,
    enableQa09Capacity: true,
    enableImmediateCommandPublish: true,
  });
  assert.throws(() => qa09RolloutContext({ FDP_QA09_ROLLOUT_PHASE: 'immedate' }), /INVALID_QA09_ROLLOUT_PHASE/);
});
