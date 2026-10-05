import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLayoutDiagnosticFixture, cleanupLayoutDiagnosticIdentity } from './run-qa09-layout-diagnostic.mjs';
test('layout diagnostic fails closed before AWS calls for foreign, finished or unbound fixtures', () => {
  const prefix = 'qa09-720760a9e9dbca2d';
  const version = { gate: 'PASS', sourceCommit: 'e'.repeat(40) };
  const fixture = {
    gate: 'RUNNING',
    sourceCommit: version.sourceCommit,
    prefix,
    devices: [prefix + '-01'],
    fixtureMode: 'REAL_RDS_ONBOARDED_STATE_FOR_BUSINESS_APIS_NO_DEVICE_AUTH_CLAIM',
  };
  assert.doesNotThrow(() => validateLayoutDiagnosticFixture(fixture, version));
  for (const change of [
    { devices: ['other-customer-device'] },
    { devices: [] },
    { gate: 'PASS' },
    { sourceCommit: 'f'.repeat(40) },
    { prefix: 'qa09-wrong' },
    { fixtureMode: 'ACTIVE_SEED' },
  ]) {
    assert.throws(
      () => validateLayoutDiagnosticFixture({ ...fixture, ...change }, version),
      /OWN_RUNNING_FIXTURE_REQUIRED/,
    );
  }
  assert.throws(
    () => validateLayoutDiagnosticFixture(fixture, { ...version, gate: 'BLOCKED' }),
    /OWN_RUNNING_FIXTURE_REQUIRED/,
  );
});

for (const scenario of ['absent', 'still-present', 'read-denied', 'signout-failed', 'delete-failed']) {
  test('diagnostic cleanup retains all actions and fails closed: ' + scenario, async () => {
    const calls = [];
    const receipt = await cleanupLayoutDiagnosticIdentity(async (Cmd) => {
      calls.push(Cmd.name);
      if (Cmd.name === 'AdminUserGlobalSignOutCommand' && scenario === 'signout-failed') throw Error('signout failed');
      if (Cmd.name === 'AdminDeleteUserCommand' && scenario === 'delete-failed') throw Error('delete failed');
      if (Cmd.name === 'AdminGetUserCommand') {
        if (scenario === 'read-denied') throw Object.assign(Error('denied'), { name: 'AccessDeniedException' });
        if (scenario !== 'still-present') throw Object.assign(Error('absent'), { name: 'UserNotFoundException' });
      }
    });
    assert.deepEqual(calls, ['AdminUserGlobalSignOutCommand', 'AdminDeleteUserCommand', 'AdminGetUserCommand']);
    assert.equal(receipt.result, scenario === 'absent' ? 'PASS' : 'FAIL');
    assert.equal(receipt.absence, ['still-present', 'read-denied'].includes(scenario) ? 'FAIL' : 'PASS');
  });
}
