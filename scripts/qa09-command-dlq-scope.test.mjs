import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedCommandLedger, classifyDlqBody } from './qa09-command-dlq-scope.mjs';
test('DLQ scope requires closed ledger, 20 exact IDs and fresh empty database proof', () => {
  const prefix = 'qa09-1111111111111111';
  const ids = Array.from({ length: 20 }, (_, i) => `${prefix.toUpperCase()}-CMD-${i}`);
  const business = {
    prefix,
    cleanup: [{ scope: 'business-fixtures', result: 'PASS' }],
    result: { commands: ids.map((commandId) => ({ commandId })) },
  };
  const devices = {
    prefix,
    gate: 'PASS',
    finishedAt: 'now',
    cleanup: [{ type: 'database-fixtures', count: 10, result: 'PASS' }],
  };
  const proof = {
    scope: 'EXACT_RETIRED_COMMAND_POINTER_READ_ONLY',
    writes: 0,
    commandIds: ids,
    remaining: [],
    outboxRemaining: [],
  };
  const ledger = closedCommandLedger(business, devices, proof);
  assert.equal(
    classifyDlqBody(JSON.stringify({ commandId: ids[0] }), ledger).disposition,
    'DELETE_EXACT_RETIRED_OWN_POINTER',
  );
  for (const body of [
    '{}',
    'invalid',
    JSON.stringify({ commandId: ids[0], extra: true }),
    JSON.stringify({ commandId: 'QA09-OTHER' }),
  ])
    assert.equal(classifyDlqBody(body, ledger).disposition, 'PRESERVE_UNKNOWN');
  assert.throws(() => closedCommandLedger(business, devices, { ...proof, remaining: [{ id: ids[0] }] }));
  assert.throws(() => closedCommandLedger(business, { ...devices, gate: 'FAIL' }, proof));
});
