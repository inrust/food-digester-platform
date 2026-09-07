import { assert, describe, expect, test, vi } from 'vitest';
import type { DeviceRoute, DeviceRouteSet } from '../src/runtime/device-lambda.js';
import { createDeviceApiLambdaHandler } from '../src/runtime/device-lambda.js';

function routes(overrides: Partial<DeviceRouteSet> = {}): DeviceRouteSet {
  const unused = vi.fn(async () => ({ status: 200, body: {} }));
  return {
    certificateStatus: unused,
    certificateRotate: unused,
    sync: unused,
    deactivate: unused,
    ...overrides,
  };
}

describe('Device API Lambda 生产路由', () => {
  test.each([
    ['GET', '/api/v1/device/certificate/status', 'certificateStatus'],
    ['POST', '/api/v1/device/certificate/rotate', 'certificateRotate'],
    ['POST', '/api/v1/device/sync', 'sync'],
    ['POST', '/api/v1/device/deactivate', 'deactivate'],
  ] as const)('%s %s 映射到 %s Handler', async (method, path, key) => {
    const route: DeviceRoute = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const handler = createDeviceApiLambdaHandler(routes({ [key]: route }));
    const response = await handler({
      httpMethod: method,
      path,
      requestContext: {
        requestId: 'device-request-1',
        identity: { clientCert: { clientCertPem: 'trusted-gateway-value' } },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual((route as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].identity, {
      clientCertPem: 'trusted-gateway-value',
    });
  });

  test('事件顶层伪造 identity 不会成为 AUTH-03 身份', async () => {
    const sync = vi.fn<DeviceRoute>(async () => ({ status: 401, body: {} }));
    const handler = createDeviceApiLambdaHandler(routes({ sync }));
    await handler({
      httpMethod: 'POST',
      path: '/api/v1/device/sync',
      identity: { clientCertPem: 'forged' },
      requestContext: { requestId: 'device-request-2' },
    });

    assert.isUndefined(sync.mock.calls[0]?.[0].identity);
  });

  test('未知方法或路径失败关闭为 404', async () => {
    const routeSet = routes();
    const handler = createDeviceApiLambdaHandler(routeSet);
    const response = await handler({ httpMethod: 'GET', path: '/api/v1/device/sync' });
    assert.equal(response.statusCode, 404);
    for (const route of Object.values(routeSet)) assert.equal((route as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });

  test('Rotate 先序列化响应再提交交付确认', async () => {
    const order: string[] = [];
    const body = {
      toJSON() {
        order.push('serialize');
        return { privateKey: 'one-time-key' };
      },
    };
    const certificateRotate = vi.fn(async () => ({
      status: 200,
      body,
      onCommitted: async () => {
        order.push('commit');
      },
    }));
    const response = await createDeviceApiLambdaHandler(routes({ certificateRotate }))({
      httpMethod: 'POST',
      path: '/api/v1/device/certificate/rotate',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(order, ['serialize', 'commit']);
  });

  test('Rotate 提交回调失败时不返回含私钥的成功响应', async () => {
    const certificateRotate = vi.fn(async () => ({
      status: 200,
      body: { data: { privateKey: 'must-not-leak' } },
      onCommitted: async () => {
        throw new Error('database unavailable');
      },
    }));
    const response = await createDeviceApiLambdaHandler(routes({ certificateRotate }))({
      httpMethod: 'POST',
      path: '/api/v1/device/certificate/rotate',
      requestContext: { requestId: 'device-request-3' },
    });

    assert.equal(response.statusCode, 500);
    expect(response.body).not.toContain('must-not-leak');
    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'device-request-3' },
    });
  });

  test('Rotate 序列化失败时不执行提交回调', async () => {
    const onCommitted = vi.fn(async () => undefined);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const certificateRotate = vi.fn(async () => ({ status: 200, body: circular, onCommitted }));
    const response = await createDeviceApiLambdaHandler(routes({ certificateRotate }))({
      httpMethod: 'POST',
      path: '/api/v1/device/certificate/rotate',
    });

    assert.equal(response.statusCode, 500);
    assert.equal(onCommitted.mock.calls.length, 0);
  });
});
