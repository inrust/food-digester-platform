import { rejects } from 'node:assert/strict';
import { assert, test, vi } from 'vitest';
import { withDataPathTrace } from '@fdp/observability';
import {
  createAuthenticatedEngineDiagnostic,
  resolveEngineCpuDiagnosis,
} from '../src/runtime/admin-engine-diagnostic.js';
import { createAdminLambdaRouter } from '../src/runtime/admin-lambda.js';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';

test('engine diagnosis fails closed outside exact test pool1 and is off by default', () => {
  assert.isFalse(resolveEngineCpuDiagnosis({}));
  assert.isTrue(
    resolveEngineCpuDiagnosis({ ENV_NAME: 'test', FDP_DB_POOL_MAX: '1', FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true' }),
  );
  for (const env of [
    { FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'yes' },
    { ENV_NAME: 'prod', FDP_DB_POOL_MAX: '1', FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true' },
    { ENV_NAME: 'test', FDP_DB_POOL_MAX: '2', FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true' },
  ])
    assert.throws(() => resolveEngineCpuDiagnosis(env));
});

test('engine diagnostic uses one existing client, single flight and retains failure/retry ownership', async () => {
  let release!: () => void;
  const client = {
    $connect: vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    ),
  };
  const prepare = createAuthenticatedEngineDiagnostic(true, client);
  const first = prepare(),
    second = prepare();
  assert.equal(client.$connect.mock.calls.length, 1);
  release();
  await Promise.all([first, second]);
  await prepare();
  assert.equal(client.$connect.mock.calls.length, 1);
  await createAuthenticatedEngineDiagnostic(false, client)();
  assert.equal(client.$connect.mock.calls.length, 1);
  const error = Error('private connection details');
  const fail = { $connect: vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined) };
  const retry = createAuthenticatedEngineDiagnostic(true, fail);
  await rejects(retry(), (e) => e === error);
  await retry();
  await retry();
  assert.equal(fail.$connect.mock.calls.length, 2);
});

test('signed JWT precedes engine preparation and unchanged per-request account hook; bad JWT never prepares', async () => {
  const keys = await generateTestKeySet();
  const token = await signToken(keys, { groups: ['PlatformOperator'] });
  const order: string[] = [],
    rows: Record<string, unknown>[] = [];
  const prepare = createAuthenticatedEngineDiagnostic(true, {
    $connect: async () => {
      order.push('engine');
    },
  });
  const router = createAdminLambdaRouter(
    testConfig(keys.jwks),
    () => async () => {
      order.push('route');
      return { status: 200, body: {} };
    },
    {
      onAuthenticated: async () => {
        await prepare();
        order.push('account');
      },
    },
  );
  assert.equal((await router({ headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
  assert.deepEqual(order, []);
  for (let i = 0; i < 2; i++)
    await withDataPathTrace(
      { gatewayRequestId: `req-${i}` },
      () => router({ headers: { authorization: `Bearer ${token}` } }),
      (r) => rows.push(r),
    );
  assert.deepEqual(order, ['engine', 'account', 'route', 'account', 'route']);
  const engine = rows.filter((r) => r.phase === 'db-engine-prepare');
  assert.equal(engine.length, 1);
  assert.equal(engine[0].completionBoundary, 'OPERATION_SETTLED');
  assert.equal(engine[0].processCpuScope, 'PROCESS_ALL_THREADS');
  assert.isAtLeast(engine[0].processCpuUserUs as number, 0);
  assert.notInclude(JSON.stringify(rows), token);
});

test('authenticated preconnect is off by default and fails closed unless test/pool1/engine is explicit', async () => {
  const { resolveAuthenticatedPreconnect } = await import('../src/runtime/admin-engine-diagnostic.js');
  assert.isFalse(resolveAuthenticatedPreconnect({}));
  const env = {
    ENV_NAME: 'test',
    FDP_DB_POOL_MAX: '1',
    FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true',
    FDP_QA09_AUTHENTICATED_PRECONNECT: 'true',
  };
  assert.isTrue(resolveAuthenticatedPreconnect(env));
  for (const patch of [
    { ENV_NAME: 'prod' },
    { FDP_DB_POOL_MAX: '2' },
    { FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'false' },
    { FDP_QA09_AUTHENTICATED_PRECONNECT: 'yes' },
  ])
    assert.throws(() => resolveAuthenticatedPreconnect({ ...env, ...patch }));
});
