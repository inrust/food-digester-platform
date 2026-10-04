import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnedBusinessUser, assertOwnedSessionSite } from './run-qa09-signed-session-target.mjs';
test('business session cleanup never accepts a foreign email id role scope or lifecycle', () => {
  const prefix = 'qa09-1234567890abcdef';
  const expected = {
    email: prefix + '-h01-customeradmin@example.invalid',
    userId: '11111111-1111-4111-8111-111111111111',
    customerId: '22222222-2222-4222-8222-222222222222',
    role: 'CustomerAdmin',
  };
  const view = { ...expected, roles: ['CustomerAdmin'], status: 'ACTIVE' };
  assert.equal(assertOwnedBusinessUser(prefix, expected, view), expected.userId);
  for (const patch of [
    { email: 'existing@example.com' },
    { userId: '33333333-3333-4333-8333-333333333333' },
    { roles: ['PlatformSuperAdmin'] },
    { customerId: 'foreign' },
    { status: 'UNKNOWN' },
  ])
    assert.throws(() => assertOwnedBusinessUser(prefix, expected, { ...view, ...patch }));
  assert.throws(() => assertOwnedBusinessUser('foreign', expected, view));
  assert.throws(() => assertOwnedBusinessUser(prefix, { ...expected, email: 'existing@example.com' }, view));
});
test('session fixtures require exact own customer and site binding before cleanup', () => {
  const prefix = 'qa09-1234567890abcdef';
  const customer = { id: '11111111-1111-4111-8111-111111111111', name: prefix + '-a', suffix: 'a' };
  const site = { id: '22222222-2222-4222-8222-222222222222', customerId: customer.id, name: prefix + '-site-a' };
  assertOwnedSessionSite(prefix, customer, site);
  for (const patch of [{ customerId: 'foreign' }, { name: 'original' }, { id: 'invalid' }])
    assert.throws(() => assertOwnedSessionSite(prefix, customer, { ...site, ...patch }));
  assert.throws(() => assertOwnedSessionSite('foreign', customer, site));
});
