import { withAuthorization } from '@fdp/auth';
import { assert, describe, expect, test, vi } from 'vitest';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';
import type { AdminHttpRequest } from '../src/admin/onboarding/handler.js';
import { createAdminLambdaHandler, createAdminRoute } from '../src/runtime/admin-lambda.js';

describe('AUTH-01 管理 API Lambda 组合根', () => {
  test('真实路由表把方法和路径映射到受保护业务 Handler', async () => {
    const approve = vi.fn(async (_request: AdminHttpRequest) => ({ status: 200, body: {} }));
    const route = createAdminRoute(
      { httpMethod: 'POST', path: '/api/v1/admin/onboarding/requests/request-1/approve' },
      {
        onboarding: {
          list: vi.fn(),
          detail: vi.fn(),
          approve,
          reject: vi.fn(),
        },
        certificateRotation: vi.fn(),
      },
    );
    await route({ headers: {}, requestId: 'trace-1' });
    assert.equal(approve.mock.calls[0]?.[0].params?.requestId, 'request-1');
  });

  test('未知路径失败关闭为 404', async () => {
    const route = createAdminRoute(
      { httpMethod: 'GET', path: '/api/v1/admin/unknown' },
      {
        onboarding: { list: vi.fn(), detail: vi.fn(), approve: vi.fn(), reject: vi.fn() },
        certificateRotation: vi.fn(),
      },
    );
    await expect(route({ headers: {}, requestId: 'trace-2' })).resolves.toMatchObject({ status: 404 });
  });

  test('证书轮换申请路由映射到受保护业务 Handler', async () => {
    const certificateRotation = vi.fn(async (_request: AdminHttpRequest) => ({ status: 201, body: {} }));
    const route = createAdminRoute(
      {
        httpMethod: 'POST',
        path: '/api/v1/admin/devices/device%2Fencoded/certificate-rotation-requests',
      },
      {
        onboarding: { list: vi.fn(), detail: vi.fn(), approve: vi.fn(), reject: vi.fn() },
        certificateRotation,
      },
    );
    const response = await route({ headers: {}, requestId: 'trace-cert' });

    assert.equal(response.status, 201);
    assert.equal(certificateRotation.mock.calls[0]?.[0].params?.deviceId, 'device/encoded');
  });

  test('只把重新验签后的 claims 转换为可信 ActorContext', async () => {
    const keys = await generateTestKeySet();
    const token = await signToken(keys, { groups: ['PlatformOperator'], sub: 'signed-sub' });
    const route = vi.fn(async (request) => ({ status: 200, body: { actor: request.actor } }));
    const handler = createAdminLambdaHandler(testConfig(keys.jwks), route);

    const response = await handler({
      headers: { Authorization: `Bearer ${token}` },
      actor: { actorId: 'forged', roles: ['PlatformSuperAdmin'] },
      requestContext: {
        requestId: 'req-1',
        authorizer: { claims: { sub: 'forged', 'cognito:groups': ['PlatformSuperAdmin'] } },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(route.mock.calls[0]?.[0].actor?.actorId, 'signed-sub');
    assert.deepEqual(route.mock.calls[0]?.[0].actor?.roles, ['PlatformOperator']);
  });

  test('伪造 actor/authorizer claims 不能绕过缺失 JWT', async () => {
    const keys = await generateTestKeySet();
    const route = vi.fn(async () => ({ status: 200, body: {} }));
    const handler = createAdminLambdaHandler(testConfig(keys.jwks), route);
    const response = await handler({
      headers: {},
      actor: { actorId: 'forged', roles: ['PlatformSuperAdmin'] },
      requestContext: { requestId: 'req-2', authorizer: { claims: { sub: 'forged' } } },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(route.mock.calls.length, 0);
  });

  test('低权限签名 JWT 不能借伪造 claims 绕过业务授权', async () => {
    const keys = await generateTestKeySet();
    const token = await signToken(keys, { groups: ['Auditor'] });
    const protectedRoute = withAuthorization({ permission: 'onboarding:approve' }, async () => ({
      status: 200,
      body: {},
    }));
    const handler = createAdminLambdaHandler(testConfig(keys.jwks), protectedRoute);
    const response = await handler({
      headers: { authorization: `Bearer ${token}` },
      requestContext: {
        requestId: 'req-3',
        authorizer: { claims: { 'cognito:groups': ['PlatformSuperAdmin'] } },
      },
    });

    assert.equal(response.statusCode, 403);
  });
});
