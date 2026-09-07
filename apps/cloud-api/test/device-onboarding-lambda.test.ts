import { assert, describe, expect, test } from 'vitest';
import { createDeviceOnboardingLambdaHandler } from '../src/runtime/device-onboarding-lambda.js';

describe('Device Onboarding API Gateway 生产适配器', () => {
  test('POST request 直达 Token Handler，传递来源信息且不要求 Cognito', async () => {
    let received: unknown;
    const handler = createDeviceOnboardingLambdaHandler({
      request: async (request) => {
        received = request;
        return { status: 202, body: { data: { status: 'PENDING' } } };
      },
      status: async () => ({ status: 500, body: {} }),
    });

    const response = await handler({
      httpMethod: 'POST',
      path: '/api/v1/device/onboarding/request',
      headers: { authorization: 'Bearer onboarding-token' },
      body: JSON.stringify({ serialNumber: 'SN-001' }),
      requestContext: { requestId: 'req-1', identity: { sourceIp: '203.0.113.9' } },
    });

    assert.equal(response.statusCode, 202);
    assert.deepEqual(JSON.parse(response.body), { data: { status: 'PENDING' } });
    assert.deepInclude(received as Record<string, unknown>, {
      requestId: 'req-1',
      sourceIp: '203.0.113.9',
      body: { serialNumber: 'SN-001' },
    });
  });

  test('GET status 在成功体序列化后、返回 API Gateway 前确认一次性交付', async () => {
    const order: string[] = [];
    const body = {
      toJSON() {
        order.push('serialized');
        return { data: { status: 'APPROVED', privateKey: 'secret' } };
      },
    };
    const handler = createDeviceOnboardingLambdaHandler({
      request: async () => ({ status: 500, body: {} }),
      status: async () => ({
        status: 200,
        body,
        onCommitted: async () => void order.push('committed'),
      }),
    });

    const response = await handler({
      httpMethod: 'GET',
      path: '/api/v1/device/onboarding/status',
      queryStringParameters: { serialNumber: 'SN-001' },
      headers: { authorization: 'Bearer onboarding-token' },
      requestContext: { requestId: 'req-2' },
    });

    assert.deepEqual(order, ['serialized', 'committed']);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).data.privateKey, 'secret');
  });

  test('交付确认失败时禁止返回含私钥的成功响应', async () => {
    const handler = createDeviceOnboardingLambdaHandler({
      request: async () => ({ status: 500, body: {} }),
      status: async () => ({
        status: 200,
        body: { data: { privateKey: 'must-not-leak' } },
        onCommitted: async () => Promise.reject(new Error('commit failed')),
      }),
    });
    const response = await handler({
      httpMethod: 'GET',
      path: '/api/v1/device/onboarding/status',
      requestContext: { requestId: 'req-3' },
    });
    assert.equal(response.statusCode, 500);
    expect(response.body).not.toContain('must-not-leak');
  });

  test('非法 JSON 与未知路由分别返回 400/404', async () => {
    const handler = createDeviceOnboardingLambdaHandler({
      request: async () => ({ status: 200, body: {} }),
      status: async () => ({ status: 200, body: {} }),
    });
    assert.equal(
      (await handler({ httpMethod: 'POST', path: '/api/v1/device/onboarding/request', body: '{' })).statusCode,
      400,
    );
    assert.equal((await handler({ httpMethod: 'GET', path: '/other' })).statusCode, 404);
  });
});
