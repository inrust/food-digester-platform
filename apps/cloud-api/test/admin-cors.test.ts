import { assert, test } from 'vitest';
import { withAdminCors, validateAdminOrigin } from '../src/runtime/admin-cors.js';
import type { ApiGatewayAdminEvent } from '../src/runtime/admin-lambda.js';

const origin = 'https://admin.bio-nexa.com';
const preflight: ApiGatewayAdminEvent = {
  path: '/api/v1/admin/devices',
  httpMethod: 'OPTIONS',
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': 'PATCH',
    'Access-Control-Request-Headers': 'Authorization, Content-Type, If-Match, Idempotency-Key',
  },
};
test('actual Lambda entry returns preflight without DB Secret or Cognito configuration', async () => {
  const previous = process.env.ADMIN_WEB_ORIGIN;
  process.env.ADMIN_WEB_ORIGIN = origin;
  try {
    const { handler } = await import('../src/runtime/lambda-entry.js');
    assert.equal((await handler(preflight)).statusCode, 204);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_WEB_ORIGIN;
    else process.env.ADMIN_WEB_ORIGIN = previous;
  }
});
test('approved preflight bypasses cold-start/auth/DB and allows concurrency headers without credentials', async () => {
  const result = await withAdminCors(preflight, origin, async () => {
    throw new Error('must not initialize');
  });
  assert.equal(result.statusCode, 204);
  assert.equal(result.headers['Access-Control-Allow-Origin'], origin);
  assert.include(result.headers['Access-Control-Allow-Headers'], 'if-match');
  assert.notProperty(result.headers, 'Access-Control-Allow-Credentials');
});
test('unknown/null origin, header, method, internal path and absent config fail closed', async () => {
  for (const event of [
    { ...preflight, headers: { ...preflight.headers, Origin: 'https://admin.bio-nexa.com.evil.test' } },
    { ...preflight, headers: { ...preflight.headers, Origin: 'null' } },
    { ...preflight, headers: { ...preflight.headers, 'Access-Control-Request-Headers': 'x-evil' } },
    { ...preflight, headers: { ...preflight.headers, 'Access-Control-Request-Method': 'TRACE' } },
    { ...preflight, path: '/api/v1/internal/devices' },
  ]) {
    const result = await withAdminCors(event, origin, async () => {
      throw new Error('must not initialize');
    });
    assert.equal(result.statusCode, 403);
    assert.notProperty(result.headers, 'Access-Control-Allow-Origin');
  }
  assert.equal(
    (
      await withAdminCors(preflight, undefined, async () => {
        throw new Error('no');
      })
    ).statusCode,
    403,
  );
});
test('success and all application errors retain exact-origin CORS; initialization errors are redacted', async () => {
  for (const statusCode of [200, 400, 401, 403, 409, 500]) {
    const result = await withAdminCors({ ...preflight, httpMethod: 'GET' }, origin, async () => ({
      statusCode,
      headers: {},
      body: '{}',
    }));
    assert.equal(result.statusCode, statusCode);
    assert.equal(result.headers['Access-Control-Allow-Origin'], origin);
  }
  const result = await withAdminCors({ ...preflight, httpMethod: 'GET' }, origin, async () => {
    throw new Error('secret');
  });
  assert.equal(result.statusCode, 500);
  assert.notInclude(result.body, 'secret');
});
test('ordinary requests without approved origin still authenticate; CORS is not an access control bypass', async () => {
  let calls = 0;
  const result = await withAdminCors({ path: '/api/v1/admin/devices', httpMethod: 'GET' }, origin, async () => {
    calls += 1;
    return { statusCode: 401, headers: {}, body: '{}' };
  });
  assert.equal(calls, 1);
  assert.equal(result.statusCode, 401);
  assert.notProperty(result.headers, 'Access-Control-Allow-Origin');
});
test('invalid Origin configuration cannot introduce wildcard/path/credentials or insecure remote HTTP', () => {
  for (const value of [
    '*',
    'https://admin.bio-nexa.com/',
    'https://user:pass@admin.bio-nexa.com',
    'http://admin.bio-nexa.com',
  ])
    assert.throws(() => validateAdminOrigin(value));
  assert.equal(validateAdminOrigin('http://localhost:4173'), 'http://localhost:4173');
});
