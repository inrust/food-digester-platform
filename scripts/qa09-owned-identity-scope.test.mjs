import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnUnseededIdentity, assertOwnIdentityMetadata } from './qa09-owned-identity-scope.mjs';
const prefix = 'qa09-1234567890abcdef',
  username = prefix + '-platformsuperadmin@example.invalid';
const parent = {
  mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
  gate: 'FAIL',
  prefix,
  target: { accountId: '065986019555', region: 'ap-southeast-1' },
  customers: [],
  databaseBuilds: [],
  identity: { username, created: true },
  startedAt: '2026-10-03T02:19:28Z',
  finishedAt: '2026-10-03T02:20:10Z',
};
test('unseeded identity cleanup rejects unfinished, foreign, seeded and pre-existing admin ledgers', () => {
  assert.equal(assertOwnUnseededIdentity(parent), username);
  for (const patch of [
    { finishedAt: null },
    { gate: 'PASS' },
    { prefix: 'original-admin' },
    { customers: [{ id: 'old' }] },
    { databaseBuilds: [{ action: 'seed' }] },
    { identity: { username: 'existing-admin', created: true } },
    { identity: { username, created: false } },
    { target: { accountId: '000000000000', region: 'ap-southeast-1' } },
  ])
    assert.throws(() => assertOwnUnseededIdentity({ ...parent, ...patch }));
});
test('Cognito canonical UUID is allowed only with exact own email and creation within this failed run', () => {
  const user = {
    Username: '993a659c-20f1-70dd-914b-a8338689dd0e',
    UserCreateDate: '2026-10-03T02:19:31Z',
    UserAttributes: [{ Name: 'email', Value: username }],
  };
  assert.equal(assertOwnIdentityMetadata(parent, user), username);
  for (const patch of [
    { UserCreateDate: '2026-01-01T00:00:00Z' },
    { UserCreateDate: '2026-10-03T03:00:00Z' },
    { UserCreateDate: 'invalid' },
    { UserAttributes: [{ Name: 'email', Value: 'existing-admin@example.invalid' }] },
  ])
    assert.throws(() => assertOwnIdentityMetadata(parent, { ...user, ...patch }), /CREATION_SCOPE_DRIFT/);
});
