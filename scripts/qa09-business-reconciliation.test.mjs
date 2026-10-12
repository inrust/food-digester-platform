import test from 'node:test';
import assert from 'node:assert/strict';
import { operationMatches, reconcileLegalWrites, assertScopedSignedSession } from './qa09-business-reconciliation.mjs';
const operation = {
  operationId: 'write',
  method: 'PUT',
  path: '/users/{userId}/roles',
  roles: [
    { role: 'PlatformSuperAdmin', result: 'NOT_RUN' },
    { role: 'Auditor', result: 'NOT_APPLICABLE' },
  ],
};
const row = {
  role: 'PlatformSuperAdmin',
  method: 'PUT',
  path: '/users/own/roles',
  status: 200,
  result: 'PASS',
  requestId: 'gateway-1',
};
const receipt = {
  path: 'receipt.json',
  sha256: 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40),
  compatibility: 'CHANGED_SHARED_OR_DOMAIN_INPUTS_REVALIDATE',
  cleanup: 'PASS',
  scope: 'USER',
  rows: [row],
};
test('path matcher is anchored, escapes literals, and respects method', () => {
  assert(operationMatches(operation, row));
  for (const change of [
    { method: 'GET' },
    { path: '/prefix/users/own/roles' },
    { path: '/users/own/roles/extra' },
    { path: '/users/a/b/roles' },
  ])
    assert(!operationMatches(operation, { ...row, ...change }));
  assert(operationMatches({ ...operation, path: '/u.v/{id}' }, { ...row, path: '/u.v/x' }));
  assert(!operationMatches({ ...operation, path: '/u.v/{id}' }, { ...row, path: '/uZv/x' }));
});
test('HTTP observations deduplicate by version/request without transferring acceptance or changing domains', () => {
  const r = reconcileLegalWrites([operation], [receipt, receipt]);
  assert.equal(r.candidatePairs, 1);
  assert.equal(r.historicallyObservedPairs, 1);
  assert.equal(r.pairs[0].evidence.length, 1);
  assert.equal(r.currentLiveVersionObservedPairs, 0);
  assert.equal(r.fullQa09Accepted, false);
  const fresh = reconcileLegalWrites([operation], [{ ...receipt, compatibility: 'CURRENT_LIVE_VERSION_BOUND' }]);
  assert.equal(fresh.currentLiveVersionObservedPairs, 1);
  assert.equal(fresh.fullQa09Accepted, false);
});
test('denial, failed check, wrong actor and unknown request cannot close lawful-write gaps', () => {
  for (const patch of [
    { status: 403 },
    { result: 'FAIL' },
    { role: 'Auditor' },
    { method: 'POST' },
    { operationId: 'other' },
  ]) {
    const r = reconcileLegalWrites([operation], [{ ...receipt, rows: [{ ...row, ...patch }] }]);
    assert.equal(r.historicallyObservedPairs, 0);
  }
  assert.throws(
    () => reconcileLegalWrites([operation], [{ ...receipt, rows: [{ ...row, requestId: null }] }]),
    /SUCCESS_REQUEST/,
  );
  assert.throws(() => reconcileLegalWrites([operation], [{ ...receipt, sha256: 'bad' }]), /CONTENT_AND_VERSION/);
  assert.throws(
    () => reconcileLegalWrites([operation], [{ ...receipt, rows: [row, { ...row, status: 201 }] }]),
    /CONFLICTING|CROSS_PAIR/,
  );
  assert.throws(() => reconcileLegalWrites([operation, operation], [receipt]), /DUPLICATE/);
});
test('current cleanup is required and HTTP scope cannot upgrade full business acceptance', () => {
  const r = reconcileLegalWrites(
    [operation],
    [{ ...receipt, compatibility: 'CURRENT_LIVE_VERSION_BOUND', cleanup: 'FAIL' }],
  );
  assert.equal(r.currentLiveVersionObservedPairs, 0);
  assert.match(r.pairs[0].persistenceAcceptance, /NOT_IMPLIED/);
});
test('signed session aggregate label alone cannot replace per-role unexpired token and cleanup evidence', () => {
  assert.throws(
    () => assertScopedSignedSession({ gate: 'PASS_SCOPED_FIVE_ROLE_SIGNED_SESSION_AND_USER_WRITES' }),
    /SIGNED_SCOPE/,
  );
});

import { validateUserBrowserEvidence } from './qa09-user-closeout-browser.mjs';
test('browser claims require actual disable response, unchanged cancel, scope, screenshot and zero notification writes', () => {
  const r = {
    width: 375,
    userId: 'own',
    result: 'PASS',
    cancelReadback: 'ACTIVE',
    finalReadback: 'DISABLED',
    apiMock: false,
    notificationWrites: 0,
    viewport: 375,
    documentWidth: 375,
    screenshotSha256: 'a'.repeat(64),
    disableResponse: { requestId: 'gateway', status: 200, path: '/api/v1/admin/users/own/disable' },
  };
  assert.equal(validateUserBrowserEvidence(r).length, 2);
  for (const patch of [
    { notificationWrites: 1 },
    { apiMock: true },
    { cancelReadback: 'DISABLED' },
    { width: 800 },
    { documentWidth: 700 },
    { disableResponse: { ...r.disableResponse, requestId: null } },
    { finalReadback: 'ACTIVE' },
  ])
    assert.throws(() => validateUserBrowserEvidence({ ...r, ...patch }), /BUSINESS_PROOF/);
});

test('same request cannot be attributed to different roles or operations', () => {
  const other = { ...operation, operationId: 'other', path: '/other/{userId}/roles' };
  const a = { ...row, operationId: 'write' },
    b = { ...row, operationId: 'other', path: '/other/own/roles' };
  assert.throws(() => reconcileLegalWrites([operation, other], [{ ...receipt, rows: [a, b] }]), /CROSS_PAIR/);
  const r = reconcileLegalWrites(
    [operation],
    [{ ...receipt, rows: [{ ...row, operationId: 'write', method: 'GET' }] }],
  );
  assert.equal(r.historicallyObservedPairs, 0);
});
