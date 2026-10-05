import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLayoutDiagnosticFixture } from './run-qa09-layout-diagnostic.mjs';
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
