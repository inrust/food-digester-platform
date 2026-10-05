import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITES,
  writePermission,
  ownProbePath,
  forgeClaimsToken,
  runWriteBoundaryProbes,
} from './qa09-write-boundary-probes.mjs';
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

test('Gateway 403 rejects tampered signatures while protected 2xx must fail', async () => {
  const token =
    'header.' +
    Buffer.from(JSON.stringify({ exp: 4102444800, 'cognito:groups': ['PlatformSuperAdmin'] })).toString('base64url') +
    '.signature';
  for (const jwtStatus of [403, 200]) {
    const result = await runWriteBoundaryProbes(
      { receipt: { prefix: 'qa09-1234567890abcdef', devices: ['qa09-1234567890abcdef-01'] } },
      async (id, role, method, path, expected) => {
        const actual = id.startsWith('jwt-reject-') ? jwtStatus : Array.isArray(expected) ? expected[0] : expected;
        if (!(Array.isArray(expected) ? expected : [expected]).includes(actual))
          throw Error('UNEXPECTED_HTTP_RESPONSE');
      },
      new Map([['PlatformSuperAdmin', { idToken: token }]]),
      () => {},
    );
    assert.equal(result.jwt.length, 6);
    assert.ok(result.jwt.every((row) => row.result === (jwtStatus === 403 ? 'PASS' : 'FAIL')));
  }
});
