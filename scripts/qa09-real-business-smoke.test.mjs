import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnedIdentity, assertOwnedRecord } from './run-qa09-real-business-smoke.mjs';
test('identity cleanup only accepts this run and the five known role identities', () => {
  const prefix = 'qa09-0123456789abcdef';
  assert.doesNotThrow(() => assertOwnedIdentity(`${prefix}-auditor@example.invalid`, prefix));
  for (const username of [
    'admin@example.com',
    'qa09-fedcba9876543210-auditor@example.invalid',
    `${prefix}-root@example.invalid`,
  ])
    assert.throws(() => assertOwnedIdentity(username, prefix));
  assert.throws(() => assertOwnedIdentity('qa09-a-auditor@example.invalid', 'qa09-a'));
});
test('record cleanup requires exact run namespace, not merely a partial prefix', () => {
  const prefix = 'qa09-0123456789abcdef';
  assert.doesNotThrow(() => assertOwnedRecord({ name: `${prefix}-site-a` }, prefix));
  for (const name of ['existing-customer', `${prefix}0-site-a`, 'qa09-fedcba9876543210-site-a'])
    assert.throws(() => assertOwnedRecord({ name }, prefix));
  assert.throws(() => assertOwnedRecord({}, prefix));
});
