import { test, assert, vi } from 'vitest';
import { Socket } from 'node:net';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';
const state = vi.hoisted(() => ({ client: undefined as any, jwt: undefined as any }));
vi.mock('@fdp/aws-clients', async (original) => ({
  ...(await original<object>()),
  resolveDatabaseUrl: async () => 'postgresql://unused:unused@invalid.invalid/never-connect',
  resolveSecretString: async () => 'offline-signing-key',
}));
vi.mock('@fdp/database', async (original) => ({
  ...(await original<object>()),
  createAdminPreconnectCandidate: () => ({ client: state.client, prepareAuthenticated: async () => {} }),
}));
vi.mock('../src/runtime/admin-lambda.js', async (original) => {
  const actual = await original<typeof import('../src/runtime/admin-lambda.js')>();
  return {
    ...actual,
    createAdminLambdaRouter: (
      _config: unknown,
      route: Parameters<typeof actual.createAdminLambdaRouter>[1],
      hooks: Parameters<typeof actual.createAdminLambdaRouter>[2],
    ) => actual.createAdminLambdaRouter(state.jwt, route, hooks),
  };
});
const enabled = process.env.QA09_ADMIN_OBSERVER_MODE !== 'false';
test(`actual Lambda JSON/redaction/account/contract entry observer=${enabled} preserves signed business and negative matrix`, async () => {
  vi.resetModules();
  const env = {
    AWS_REGION: 'ap-southeast-1',
    DB_SECRET_ARN: 'db-reference',
    LICENSE_SIGNING_KEY_SECRET_ARN: 'license-reference',
    EXPORT_BUCKET_NAME: 'exports',
    OTA_BUCKET_NAME: 'ota',
    MEDIA_BUCKET_NAME: 'media',
    OTA_SIGNING_KEY_ARN: 'signing-reference',
    USER_POOL_ID: 'ap-southeast-1_TestPool',
    USER_POOL_CLIENT_ID: 'test-client-id',
    FDP_DB_POOL_MAX: '1',
    ENV_NAME: 'test',
    FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true',
    FDP_QA09_AUTHENTICATED_PRECONNECT: 'true',
    FDP_QA09_ACCOUNT_READ_CANDIDATE: 'true',
    FDP_QA09_CONTRACT_LOAD_DETAIL: 'true',
    FDP_QA09_CONTRACT_PUBLIC_BOUNDARIES: 'true',
    FDP_CONTRACT_OBSERVER_COST: String(enabled),
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const { createTestDb } = await import('./helpers.js');
  const db = await createTestDb();
  state.client = db.prisma;
  const keys = await generateTestKeySet();
  state.jwt = testConfig(keys.jwks);
  const logs: string[] = [],
    sink = vi.spyOn(console, 'info').mockImplementation((r) => logs.push(String(r))),
    network = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
      throw Error('NETWORK_FORBIDDEN');
    });
  try {
    const customer = await db.prisma.customer.create({ data: { name: 'offline observer' } });
    const contract = await db.prisma.contract.create({
      data: {
        contractNumber: 'OBSERVER-' + enabled,
        name: 'before',
        customerId: customer.id,
        startAt: new Date('2026-01-01Z'),
        endAt: new Date('2027-01-01Z'),
        createdBy: 'observer-super',
      },
    });
    await db.prisma.user.create({
      data: {
        email: 'observer@example.invalid',
        displayName: 'observer',
        cognitoSub: 'observer-super',
        status: 'ACTIVE',
      },
    });
    const { handler } = await import('../src/runtime/lambda-entry.js');
    let seq = 0;
    const call = async (
      token: string,
      body: unknown = { name: 'after', reason: 'offline observer' },
      version = '1',
    ) => {
      logs.length = 0;
      const result = await handler(
        {
          httpMethod: 'PATCH',
          path: `/api/v1/admin/contracts/${contract.id}`,
          headers: { authorization: `Bearer ${token}`, 'if-match': version },
          body: typeof body === 'string' ? body : JSON.stringify(body),
          requestContext: { requestId: `observer-${enabled}-${++seq}`, extendedRequestId: `extended-${seq}` },
        },
        { awsRequestId: `lambda-${enabled}-${seq}` },
      );
      return {
        result,
        summaries: logs
          .map((r) => {
            try {
              return JSON.parse(r);
            } catch {
              return {};
            }
          })
          .filter((r) => r.event === 'data-path.contract-load.observer-cost'),
      };
    };
    const token = await signToken(keys, { groups: ['PlatformSuperAdmin'], sub: 'observer-super' });
    for (const [auth, body, status] of [
      ['invalid', {}, 401],
      [token, '{', 400],
      [token, { name: 'bad' }, 400],
    ] as const) {
      const r = await call(auth, body);
      assert.equal(r.result.statusCode, status);
      assert.equal(r.summaries.length, 0);
    }
    for (const role of ['PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer']) {
      const r = await call(
        await signToken(keys, {
          groups: [role],
          sub: 'observer-super',
          ...(role.startsWith('Customer') ? { customerId: customer.id } : {}),
        }),
      );
      assert.equal(r.result.statusCode, 403);
      assert.equal(r.summaries.length, 0);
    }
    const success = await call(token);
    assert.equal(success.result.statusCode, 200);
    assert.equal(success.summaries.length, enabled ? 1 : 0);
    if (enabled) {
      assert.equal(success.summaries[0].schemaVersion, 2);
      assert.equal(success.summaries[0].ownedBoundaries.seam, 'SELF_OWNED_CALL_SITES');
      assert.equal(success.summaries[0].status, 'OWNERSHIP_INVALID');
    } // PGlite is not the observed pg adapter: never fabricate public proof.
    const conflict = await call(token);
    assert.equal(conflict.result.statusCode, 409);
    assert.equal(conflict.summaries.length, enabled ? 1 : 0);
    assert.equal((await db.prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).version, 2);
    assert.equal(
      await db.prisma.auditLog.count({
        where: { objectId: contract.id, action: 'contract.update', result: 'SUCCESS' },
      }),
      1,
    );
    assert.equal(
      await db.prisma.auditLog.count({
        where: { objectId: contract.id, action: 'contract.update', result: 'FAILURE' },
      }),
      1,
    );
    await db.prisma.user.updateMany({ where: { cognitoSub: 'observer-super' }, data: { status: 'DISABLED' } });
    const disabled = await call(token, undefined, '2');
    assert.equal(disabled.result.statusCode, 401);
    assert.equal(disabled.summaries.length, 0);
    assert.equal(network.mock.calls.length, 0);
    assert.isFalse(logs.some((r) => r.includes(token) || r.includes('postgresql://')));
  } finally {
    network.mockRestore();
    sink.mockRestore();
    await db.prisma.$disconnect();
    await db.pg.close();
    vi.unstubAllEnvs();
    state.client = undefined;
    state.jwt = undefined;
  }
}, 60000);
