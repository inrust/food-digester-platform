import test from 'node:test';
import assert from 'node:assert/strict';
import { runRemainingNonActive } from './qa09-remaining-nonactive.mjs';
const prefix = 'qa09-1234567890abcdef';
const base = {
  prefix,
  devices: Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
  customers: ['a', 'b'].map((suffix, i) => ({
    id: `${i}0000000-0000-4000-8000-000000000000`,
    name: `${prefix}-${suffix}`,
  })),
};
test('remaining target rejects foreign fixture before an API or database call', async () => {
  let calls = 0;
  await assert.rejects(
    runRemainingNonActive({
      ...base,
      devices: ['foreign', ...base.devices.slice(1)],
      api() {
        calls++;
      },
      db() {
        calls++;
      },
    }),
    /OWN_BUSINESS_CONTEXT_REQUIRED/,
  );
  assert.equal(calls, 0);
});
test('unproved license activation fails legal stage and independent stage failures remain explicit without credentials', async () => {
  const calls = [];
  const ctx = {
    ...base,
    businessReceipt: {},
    save() {},
    semanticExports: [],
    sessions: new Map(),
    sites: [],
    async api(id, role, method, path) {
      calls.push(path);
      if (path === '/api/v1/admin/licenses') return { data: { licenseId: 'own', version: 1 } };
      if (path.endsWith('/issue')) return { data: { status: 'Issued' } };
      if (path.endsWith('/evaluate')) return { data: { status: 'Active' } };
      throw Error('NO_REAL_EXPORT');
    },
    async db() {
      throw Error('NO_DATABASE_RECEIPT');
    },
  };
  const result = await runRemainingNonActive(ctx);
  assert.equal(result.gate, 'FAIL');
  assert.equal(result.legalWrites, 'FAIL');
  assert.equal(result.security, 'FAIL');
  assert.equal(result.recovery, 'FAIL');
  assert.equal(result.checks[0].result, 'FAIL');
  assert.ok(calls.includes('/api/v1/admin/replay/jobs'));
  assert.ok(!JSON.stringify(result).includes('idToken'));
});
