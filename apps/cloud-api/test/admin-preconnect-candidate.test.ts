import { createAdminAuthenticatedAccountHook } from '../src/runtime/admin-account-hook.js';
import { EventEmitter } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { assert, test, vi } from 'vitest';
import { createAdminPreconnectCandidate } from '@fdp/database';
import { createAdminLambdaRouter } from '../src/runtime/admin-lambda.js';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';

test('offline candidate checkout starts only after signed JWT and valid JSON; account query remains per request', async () => {
  vi.stubEnv('FDP_DB_POOL_MAX', '1');
  const keys = await generateTestKeySet(),
    token = await signToken(keys, { groups: ['PlatformOperator'] });
  const release = vi.fn(),
    query = vi.fn((_config, _values, callback) => callback(undefined, { rows: [], fields: [], rowCount: 0 }));
  const driver = Object.assign(new EventEmitter(), { release, query });
  const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation((callback) => {
    if (callback) return callback(undefined, driver as unknown as PoolClient, release);
    return Promise.resolve(driver as unknown as PoolClient);
  });
  const end = vi.spyOn(Pool.prototype, 'end').mockResolvedValue();
  const { client, prepareAuthenticated } = createAdminPreconnectCandidate(
    'postgresql://unused:unused@localhost/offline',
  );
  const account = vi.fn(createAdminAuthenticatedAccountHook(client, prepareAuthenticated, true));
  const router = createAdminLambdaRouter(testConfig(keys.jwks), () => async () => ({ status: 200, body: {} }), {
    onAuthenticated: account,
  });
  try {
    assert.equal((await router({ headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
    assert.equal((await router({ headers: { authorization: `Bearer ${token}` }, body: '{' })).statusCode, 400);
    assert.equal(connect.mock.calls.length, 0);
    assert.equal(account.mock.calls.length, 0);
    for (let i = 0; i < 2; i++)
      assert.equal((await router({ headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
    assert.equal(account.mock.calls.length, 2);
    assert.equal(query.mock.calls.length, 2);
    assert.equal(connect.mock.calls.length, 3);
    assert.equal(release.mock.calls.length, 3);
  } finally {
    await client.$disconnect();
    connect.mockRestore();
    end.mockRestore();
    vi.unstubAllEnvs();
  }
});
