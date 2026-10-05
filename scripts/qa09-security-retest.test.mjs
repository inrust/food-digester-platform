import test from 'node:test';
import assert from 'node:assert/strict';
import { runSecurityRetest } from './qa09-security-retest.mjs';
test('security retest rejects foreign fixture before any credential or live API access', async () => {
  let calls = 0;
  await assert.rejects(
    runSecurityRetest({
      prefix: 'foreign',
      devices: [],
      customers: [],
      api() {
        calls++;
      },
      db() {
        calls++;
      },
    }),
  );
  assert.equal(calls, 0);
});

test('six tampered tokens require HTTP rejection and keep credentials out of receipt', async () => {
  const prefix = 'qa09-1234567890abcdef';
  const token = 'header.' + Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url') + '.signature';
  const businessReceipt = {};
  let jwtCalls = 0;
  const result = await runSecurityRetest({
    prefix,
    devices: Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0')),
    customers: [
      { id: '11111111-1111-1111-1111-111111111111', name: prefix + '-a', suffix: 'a' },
      { id: '22222222-2222-2222-2222-222222222222', name: prefix + '-b', suffix: 'b' },
    ],
    businessReceipt,
    save() {},
    sessions: new Map([['PlatformSuperAdmin', { idToken: token }]]),
    logins: new Map([['PlatformSuperAdmin', { password: 'private-test-password' }]]),
    async db() {
      return { counts: {}, businessFingerprints: {} };
    },
    async api(id, role, method, path, expected) {
      if (id.includes(':jwt-')) {
        jwtCalls++;
        assert.deepEqual(expected, [401, 403]);
      }
      return { data: [] };
    },
  });
  assert.equal(jwtCalls, 6);
  assert.equal(result.gate, 'PASS');
  assert.equal(JSON.stringify(businessReceipt).includes(token), false);
  assert.equal(JSON.stringify(businessReceipt).includes('private-test-password'), false);
});
