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

test('engine CPU diagnosis is explicit and only allowed after pool budget rollout', () => {
  assert.equal(
    qa09RolloutContext({ FDP_QA09_ROLLOUT_PHASE: 'immediate', FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true' })
      .enableQa09EngineCpuDiagnosis,
    true,
  );
  assert.equal(
    qa09RolloutContext({ FDP_QA09_ROLLOUT_PHASE: 'immediate', FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'false' })
      .enableQa09EngineCpuDiagnosis,
    false,
  );
  assert.throws(() => qa09RolloutContext({ FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true' }));
  assert.throws(() => qa09RolloutContext({ FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'yes' }));
});
