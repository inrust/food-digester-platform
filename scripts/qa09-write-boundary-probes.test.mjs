import test from 'node:test';
import assert from 'node:assert/strict';
import { WRITES, writePermission, ownProbePath, forgeClaimsToken } from './qa09-write-boundary-probes.mjs';
test('all delivered writes have an explicit permission and own or absent object path', () => {
  assert.ok(WRITES.length > 50);
  for (const operation of WRITES) {
    assert.match(writePermission(operation), /^[a-z-]+:[a-z]+$/);
    assert.ok(!ownProbePath(operation, 'qa09-1234567890abcdef', 'qa09-1234567890abcdef-01').includes('{'));
  }
  assert.throws(() => ownProbePath(WRITES[0], 'foreign', 'existing'));
  assert.throws(() => writePermission({ path: '/unknown', operationId: 'unknown' }));
});

test('identical claims still change signed payload bytes rather than unused base64 signature bits', () => {
  const claims = { exp: 123, 'cognito:groups': ['PlatformSuperAdmin'] };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = 'header.' + encoded + '.signatureA';
  const forged = forgeClaimsToken(token, claims);
  assert.notEqual(forged.split('.')[1], encoded);
  assert.equal(forged.split('.')[2], 'signatureA');
});
