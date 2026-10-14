import test from 'node:test';
import assert from 'node:assert/strict';
import { bindSuccessfulAudit } from './qa09-persistence-audit.mjs';
const candidate = {
  operationId: 'updateSite',
  role: 'PlatformOperator',
  requestId: 'own-request',
  sourceCommit: 'a'.repeat(40),
};
const detail = {
  requestId: 'own-request',
  actorRole: 'PlatformOperator',
  result: 'SUCCESS',
  auditId: 'own-audit',
  objectId: 'own-site',
  objectType: 'site',
  action: 'site.update',
  afterValue: { version: 2, name: 'owned' },
};
test('atomic snapshot binds the actual mutation request and executing role', () => {
  assert.equal(bindSuccessfulAudit(candidate, detail).gate, 'PASS_ATOMIC_MUTATION_AUDIT_SNAPSHOT_ONLY');
  for (const changed of [
    { requestId: 'other' },
    { actorRole: 'PlatformSuperAdmin' },
    { result: 'FAILURE' },
    { afterValue: null },
    { afterValue: {} },
    { action: 'site.delete' },
    { auditId: null },
  ])
    assert.equal(bindSuccessfulAudit(candidate, { ...detail, ...changed }), null);
});
