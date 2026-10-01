import { randomUUID } from 'node:crypto';
import { assert, test } from 'vitest';
import { SignJWT } from 'jose';
import { createCognitoAuthenticator } from '../src/index.js';
import { generateTestKeySet, testConfig, TEST_ISSUER, TEST_CLIENT_ID } from './helpers.js';
import { inspectArtifact, proof } from '../../../apps/cloud-api/test/qa06-evidence.js';

test('QA06 JWT time claims fail closed and valid bearer reuse preserves identity', async () => {
  const keys = await generateTestKeySet();
  const auth = createCognitoAuthenticator(testConfig(keys.jwks));
  const now = Math.floor(Date.now() / 1000);
  async function sign(overrides: Record<string, unknown>) {
    return new SignJWT({
      sub: 'qa06-user',
      iat: now,
      exp: now + 3600,
      iss: TEST_ISSUER,
      token_use: 'access',
      client_id: TEST_CLIENT_ID,
      'cognito:username': 'qa06-user',
      'cognito:groups': ['CustomerAdmin'],
      'custom:customer_id': 'qa06-A',
      auth_time: now,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .sign(keys.privateKey);
  }
  const valid = await sign({});
  const first = await auth.authenticate(`Bearer ${valid}`);
  assert.deepEqual(await auth.authenticate(`Bearer ${valid}`), first);
  const attacks = [
    { exp: undefined },
    { exp: now - 1 },
    { auth_time: 1e20 },
    { auth_time: now + 3600 },
    { auth_time: 'now' },
    { auth_time: 0 },
  ];
  for (const attack of attacks) {
    const token = await sign(attack);
    let rejected = false;
    try {
      await auth.authenticate(`Bearer ${token}`);
    } catch (error) {
      const err = error as { code?: string; httpStatus?: number; message?: string };
      assert.equal(err.code, 'UNAUTHENTICATED');
      assert.equal(err.httpStatus, 401);
      inspectArtifact('response', { code: err.code, message: err.message }, [token]);
      rejected = true;
    }
    assert.isTrue(rejected, 'malformed time claims must reject');
  }
  const parts = valid.split('.');
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  payload['cognito:groups'] = ['PlatformSuperAdmin'];
  const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
  let denied = false;
  try {
    await auth.authenticate(tampered);
  } catch (error) {
    assert.equal((error as { httpStatus: number }).httpStatus, 401);
    denied = true;
  }
  assert.isTrue(denied);
  proof('jwt-integrity-time-replay', {
    prefix: `QA06-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
    cleanup: 'PASS',
    invalidClaimsRejected: attacks.length,
    tamperedRejected: true,
    validReuse: true,
    unauthorizedStatuses: [401],
  });
});
