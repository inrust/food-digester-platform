import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConnectionBudget } from './qa09-capacity-budget.mjs';
const budget = {
  ordinarySlots: 70,
  operationalReserve: 8,
  idleOverlapReserve: 10,
  functions: [
    { name: 'other-db-workers', concurrency: 23, poolMax: 2 },
    { name: 'admin-api', concurrency: 8, poolMax: 2 },
  ],
};
test('capacity planning includes operational and rotation idle overlap and rejects naive concurrency increase', () => {
  assert.equal(evaluateConnectionBudget(budget).requiredSlots, 80);
  assert.equal(evaluateConnectionBudget(budget).gate, 'FAIL');
  const candidate = evaluateConnectionBudget({
    ...budget,
    functions: [budget.functions[0], { name: 'admin-api', concurrency: 12, poolMax: 1 }],
  });
  assert.equal(candidate.requiredSlots, 76);
  assert.equal(candidate.gate, 'FAIL');
  const pooled = evaluateConnectionBudget({
    ...budget,
    functions: [
      { name: 'admin-api', concurrency: 12, poolMax: 1 },
      { name: 'device-api', concurrency: 6, poolMax: 2 },
      { name: 'onboard-api', concurrency: 2, poolMax: 2 },
      { name: 'db-workers', concurrency: 15, poolMax: 1 },
    ],
  });
  assert.equal(pooled.requiredSlots, 61);
  assert.equal(pooled.headroom, 9);
  assert.equal(pooled.gate, 'PASS');
  assert.equal(
    evaluateConnectionBudget({
      ...budget,
      functions: [budget.functions[0], { name: 'admin-api', concurrency: 12, poolMax: 2 }],
    }).gate,
    'FAIL',
  );
  for (const patch of [
    { ordinarySlots: NaN },
    { operationalReserve: 0 },
    { idleOverlapReserve: 0 },
    { functions: [budget.functions[0], budget.functions[0]] },
  ])
    assert.throws(() => evaluateConnectionBudget({ ...budget, ...patch }));
});
