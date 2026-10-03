import test from 'node:test';
import assert from 'node:assert/strict';
import { closedDomainPrefixes, validateDomainVersions } from './qa09-owned-domain-cleanup.mjs';
test('domain cleanup refuses live run, foreign customer name, missing DB cleanup and out-of-scope objects', () => {
  const prefix = 'qa09-1234567890abcdef',
    customers = ['1', '2'].map((v, i) => ({
      id: `${v.repeat(8)}-${v.repeat(4)}-${v.repeat(4)}-${v.repeat(4)}-${v.repeat(12)}`,
      name: prefix + (i === 0 ? '-a' : '-b'),
    }));
  const r = {
    prefix,
    customers,
    mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
    target: { accountId: '065986019555', region: 'ap-southeast-1' },
    finishedAt: '2026-10-03T00:00:00Z',
    cleanup: [
      { type: 'database-fixtures', count: 10, result: 'PASS' },
      ...customers.map((c) => ({ type: 'customer', id: c.id, result: 'PASS' })),
    ],
  };
  const prefixes = closedDomainPrefixes(r);
  for (const change of [
    (x) => {
      x.finishedAt = null;
    },
    (x) => {
      x.customers[0].name = 'original';
    },
    (x) => {
      x.cleanup.shift();
    },
    (x) => {
      x.cleanup[0].result = 'FAIL';
    },
  ]) {
    const x = structuredClone(r);
    change(x);
    assert.throws(() => closedDomainPrefixes(x));
  }
  validateDomainVersions([{ Key: prefixes[0] + 'own.json.gz', VersionId: 'own' }], prefixes);
  assert.throws(() =>
    validateDomainVersions(
      [{ Key: 'domain/entity_type=license/customer_id=original/x', VersionId: 'original' }],
      prefixes,
    ),
  );
  assert.throws(() => validateDomainVersions([{ Key: prefixes[0] + 'own.json.gz' }], prefixes));
});
