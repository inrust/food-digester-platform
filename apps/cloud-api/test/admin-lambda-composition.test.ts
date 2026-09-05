import { withAuthorization } from '@fdp/auth';
import { assert, describe, test, vi } from 'vitest';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';
import { createAdminLambdaHandler } from '../src/runtime/admin-lambda.js';

describe('AUTH-01 管理 API Lambda 组合根', () => {
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
