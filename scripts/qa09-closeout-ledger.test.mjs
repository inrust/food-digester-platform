import test from 'node:test';
import assert from 'node:assert/strict';
import { persistenceLedger, mapSemanticElements, assertContainment } from './qa09-closeout-ledger.mjs';
test('role, specialized validation, cleanup and content binding are required for persistence', () => {
  const pairs = Array.from({ length: 112 }, (_, i) => ({ operationId: 'op' + i, role: 'PlatformOperator' }));
  const good = {
    operationId: 'op0',
    role: 'PlatformOperator',
    sourceCompatible: true,
    cleanupVerified: true,
    proofKind: 'ATOMIC_AUDIT_SNAPSHOT',
    receiptSha256: 'a'.repeat(64),
    specializedValidation: 'PASS',
  };
  assert.equal(persistenceLedger(pairs, [good])[0].status, 'PASS_SCOPED_PERSISTENCE');
  for (const delta of [
    { role: 'PlatformSuperAdmin' },
    { proofKind: 'HTTP_ONLY' },
    { sourceCompatible: false },
    { cleanupVerified: false },
    { receiptSha256: null },
    { specializedValidation: 'FAIL' },
  ])
    assert.equal(persistenceLedger(pairs, [{ ...good, ...delta }])[0].status, 'NOT_PROVEN');
  assert.throws(() => persistenceLedger(pairs.slice(1), [good]), /EXACT_112/);
});
test('A2 and unavailable inputs cannot be promoted by generic persistence proofs', () => {
  const pairs = Array.from({ length: 112 }, (_, i) => ({
    operationId: i === 0 ? 'updateSetting' : i === 1 ? 'createDeviceCommand' : 'op' + i,
    role: 'PlatformSuperAdmin',
  }));
  const proofs = pairs.slice(0, 2).map((p) => ({
    ...p,
    sourceCompatible: true,
    cleanupVerified: true,
    proofKind: 'ATOMIC_AUDIT_SNAPSHOT',
    receiptSha256: 'a'.repeat(64),
    specializedValidation: 'PASS',
  }));
  assert.equal(persistenceLedger(pairs, proofs)[0].status, 'UNAVAILABLE_INPUT_NOT_ACCEPTED');
  assert.equal(persistenceLedger(pairs, proofs)[1].status, 'DEFERRED_A2_NOT_ACCEPTED');
});
test('semantic inventory never transfers changed contracts or unavailable notifications', () => {
  const elements = Array.from({ length: 117 }, (_, i) => ({
    id: 'id' + i,
    group: i === 0 ? 'contract-new.submit' : i === 1 ? 'settings.platform' : 'device-view.scope',
    result: 'PASS',
  }));
  const rows = mapSemanticElements(elements, [], { 'contract-new.submit': true, 'device-view.scope': true }, false);
  assert.equal(rows[0].status, 'NOT_PROVEN');
  assert.equal(rows[1].status, 'UNAVAILABLE_NOTIFICATION_INPUT_NOT_ACCEPTED');
  assert.equal(rows[2].status, 'PASS_REUSED_ORIGINAL_BROWSER_SCOPE');
});
test('current containment does not resolve historical execution uncertainty', () => {
  const x = {
    gate: 'PASS_CONTAINMENT_ONLY_UNKNOWN_EXECUTION_PRESERVED',
    originalStartGate: 'UNKNOWN',
    restartAllowed: false,
    executionSuccessClaimed: false,
    businessUser: 'ABSENT',
    cognitoIdentity: 'ABSENT',
    reads: [
      { type: 'customer', absent: true },
      { type: 'customer', absent: true },
    ],
  };
  assert.equal(assertContainment(x).originalStartGate, 'UNKNOWN');
  for (const delta of [
    { originalStartGate: 'PASS' },
    { restartAllowed: true },
    { businessUser: 'ACTIVE' },
    { cognitoIdentity: 'PRESENT' },
    { executionSuccessClaimed: true },
  ])
    assert.throws(() => assertContainment({ ...x, ...delta }));
});
