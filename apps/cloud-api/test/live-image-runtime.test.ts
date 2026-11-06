import { expect, test, vi } from 'vitest';
import { createDeviceApiLambdaHandler } from '../src/runtime/device-lambda.js';
import type { DeviceRouteSet } from '../src/runtime/device-lambda.js';
import { createAdminRoute, createAdminLambdaHandler } from '../src/runtime/admin-lambda.js';
import type { AdminOnboardingRouteSet } from '../src/runtime/admin-lambda.js';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';
import { withAdminCors } from '../src/runtime/admin-cors.js';
import { createLiveImageFrameHandler } from '../src/live-image/handler.js';
import { fixture } from './live-image-fixtures.js';
const deviceRoutes = (extra: Partial<DeviceRouteSet>): DeviceRouteSet => {
  const unused = vi.fn(async () => ({ status: 200, body: {} }));
  return {
    certificateStatus: unused,
    certificateRotate: unused,
    sync: unused,
    deactivate: unused,
    otaDownload: unused,
    mediaUpload: unused,
    ...extra,
  };
};
test.each([
  ['GET', '/api/v1/device/live-image/state', 'liveImageState'],
  ['POST', '/api/v1/device/live-image/frames', 'liveImageFrame'],
] as const)('device %s %s wires mTLS only from trusted Gateway context', async (httpMethod, path, key) => {
  const route = vi.fn(async () => ({ status: 200, body: {} }));
  const handler = createDeviceApiLambdaHandler(deviceRoutes({ [key]: route }));
  const raw = ' { "imageBase64" : "test" } ';
  const response = await handler({
    path,
    httpMethod,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(raw).toString('base64'),
    isBase64Encoded: true,
    identity: { clientCertPem: 'untrusted' },
    requestContext: { identity: { clientCert: { clientCertPem: 'trusted' } } },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['Cache-Control']).toBe('no-store');
  const request = (route.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  expect(request.identity).toEqual({ clientCertPem: 'trusted' });
  expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(request.body).toEqual(key === 'liveImageFrame' ? raw : JSON.parse(raw));
});
test('raw JSON byte limit is enforced before parsing, including Gateway base64 envelope', async () => {
  const f = fixture();
  const frame = createLiveImageFrameHandler({
    store: f.store,
    authorization: f.authorization,
    now: () => new Date(f.now()),
  });
  const handler = createDeviceApiLambdaHandler(deviceRoutes({ liveImageFrame: frame }));
  const body = ' '.repeat(184321);
  const response = await handler({
    path: '/api/v1/device/live-image/frames',
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(body).toString('base64'),
    isBase64Encoded: true,
    requestContext: { identity: { clientCert: { clientCertPem: 'trusted' } } },
  });
  expect(response.statusCode).toBe(413);
  expect(response.headers['Cache-Control']).toBe('no-store');
});
test('admin routes propagate both path parameters, 204 empty body and no-store / Retry-After through JWT and CORS', async () => {
  const keys = await generateTestKeySet();
  const token = await signToken(keys, { groups: ['CustomerViewer'], customerId: 'customer-A' });
  for (const [method, suffix, key, status] of [
    ['PUT', 'viewers/10000000-0000-4000-8000-000000000001', 'renewViewer', 429],
    ['DELETE', 'viewers/10000000-0000-4000-8000-000000000001', 'releaseViewer', 204],
    ['GET', 'latest', 'latest', 200],
  ] as const) {
    const route = vi.fn(async () => ({
      status,
      body: status === 204 ? undefined : { ok: true },
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' },
    }));
    const event = {
      path: `/api/v1/admin/devices/camera%201/live-image/${suffix}`,
      httpMethod: method,
      headers: { authorization: `Bearer ${token}`, origin: 'https://admin.example.com' },
      queryStringParameters: { viewerId: 'v' },
    };
    const routes = { liveImage: { [key]: route } } as unknown as AdminOnboardingRouteSet;
    const result = await withAdminCors(event, 'https://admin.example.com', () =>
      createAdminLambdaHandler(testConfig(keys.jwks), createAdminRoute(event, routes))(event),
    );
    expect(result.statusCode).toBe(status);
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(result.headers['Retry-After']).toBe('1');
    expect(result.headers['Access-Control-Expose-Headers']).toContain('Retry-After');
    if (status === 204) expect(result.body).toBe('');
    const request = (route.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    expect(request.params).toMatchObject({ deviceId: 'camera 1' });
    if (method !== 'GET') expect(request.params).toHaveProperty('viewerId', '10000000-0000-4000-8000-000000000001');
  }
});
test('invalid admin JWT still returns no-store without invoking route', async () => {
  const keys = await generateTestKeySet(),
    route = vi.fn();
  const result = await createAdminLambdaHandler(
    testConfig(keys.jwks),
    route,
  )({
    path: '/api/v1/admin/devices/camera/live-image/latest',
    httpMethod: 'GET',
    headers: { authorization: 'Bearer invalid' },
  });
  expect(result.statusCode).toBe(401);
  expect(result.headers['Cache-Control']).toBe('no-store');
  expect(route).not.toHaveBeenCalled();
});
test('preview OPTIONS bypasses initialization; wrong origin receives no permissive CORS', async () => {
  const next = vi.fn();
  const event = {
    path: '/api/v1/admin/devices/camera/live-image/latest',
    httpMethod: 'OPTIONS',
    headers: {
      origin: 'https://admin.example.com',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  };
  expect((await withAdminCors(event, 'https://admin.example.com', next)).statusCode).toBe(204);
  expect(next).not.toHaveBeenCalled();
  const denied = await withAdminCors(
    { ...event, headers: { origin: 'https://other.example.com' } },
    'https://admin.example.com',
    next,
  );
  expect(denied.headers).not.toHaveProperty('Access-Control-Allow-Origin');
});

test('preview cold-start failure is a safe 503 with CORS and no-store', async () => {
  const event = {
    path: '/api/v1/admin/devices/camera/live-image/latest',
    headers: { origin: 'https://admin.example.com' },
    requestContext: { requestId: 'cold' },
  };
  const result = await withAdminCors(event, 'https://admin.example.com', async () => {
    throw new Error('private initialization failure');
  });
  expect(result.statusCode).toBe(503);
  expect(result.headers['Cache-Control']).toBe('no-store');
  expect(result.body).not.toContain('private');
  expect(JSON.parse(result.body).error).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE', requestId: 'cold' });
});

test('authenticated account dependency failure maps to preview 503, no-store and no raw exception', async () => {
  const { createAdminLambdaRouter } = await import('../src/runtime/admin-lambda.js');
  const keys = await generateTestKeySet();
  const token = await signToken(keys, { groups: ['CustomerViewer'], customerId: 'customer-A' });
  const route = vi.fn();
  const result = await createAdminLambdaRouter(testConfig(keys.jwks), () => route, {
    onAuthenticated: async () => {
      throw new Error('private database details');
    },
  })({ path: '/api/v1/admin/devices/camera/live-image/latest', headers: { authorization: `Bearer ${token}` } });
  expect(result.statusCode).toBe(503);
  expect(result.headers['Cache-Control']).toBe('no-store');
  expect(result.body).not.toContain('private');
  expect(route).not.toHaveBeenCalled();
});
