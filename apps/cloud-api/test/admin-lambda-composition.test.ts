import { withAuthorization } from '@fdp/auth';
import { assert, describe, expect, test, vi } from 'vitest';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';
import type { AdminHttpRequest } from '../src/admin/onboarding/handler.js';
import { createAdminLambdaHandler, createAdminRoute } from '../src/runtime/admin-lambda.js';
import type { AdminOnboardingRouteSet } from '../src/runtime/admin-lambda.js';
import { DELIVERED_OPERATIONS } from '../src/runtime/delivered-operations.js';

const handler = () => vi.fn(async (_request: AdminHttpRequest) => ({ status: 200, body: {} }));

const routeSet = (): AdminOnboardingRouteSet => ({
  onboarding: { list: handler(), detail: handler(), approve: handler(), reject: handler() },
  certificateRotation: handler(),
  replay: { create: handler(), list: handler(), detail: handler() },
  customers: {
    list: handler(),
    create: handler(),
    detail: handler(),
    update: handler(),
    deactivate: handler(),
    remove: handler(),
  },
  sites: {
    list: handler(),
    create: handler(),
    detail: handler(),
    update: handler(),
    deactivate: handler(),
    remove: handler(),
  },
  devices: { list: handler(), detail: handler(), updateMetadata: handler() },
  assignments: { assign: handler(), history: handler() },
  statuses: { suspend: handler(), reactivate: handler() },
  retirements: { retire: handler(), forceComplete: handler() },
  console: {
    getDeviceConsole: handler(),
    listDeviceActivities: handler(),
    createActivityExport: handler(),
    getActivityExport: handler(),
  },
  licenses: {
    create: handler(),
    issue: handler(),
    activate: handler(),
    renew: handler(),
    revoke: handler(),
    evaluate: handler(),
    detail: handler(),
    history: handler(),
  },
  contracts: {
    create: handler(),
    list: handler(),
    detail: handler(),
    update: handler(),
    activate: handler(),
    renew: handler(),
    terminate: handler(),
    evaluate: handler(),
  },
  contractDevices: {
    listDevices: handler(),
    listAvailable: handler(),
    listAssociations: handler(),
    bind: handler(),
    unbind: handler(),
  },
  configurations: {
    create: handler(),
    list: handler(),
    detail: handler(),
    createVersion: handler(),
    publishVersion: handler(),
    getVersion: handler(),
    versionStatus: handler(),
  },
  consumables: { list: handler() },
  consumableRequests: {
    create: handler(),
    list: handler(),
    detail: handler(),
    process: handler(),
    complete: handler(),
    cancel: handler(),
  },
  deviceUsers: {
    create: handler(),
    list: handler(),
    detail: handler(),
    update: handler(),
    disable: handler(),
    assign: handler(),
    revoke: handler(),
  },
  alarms: {
    listAlarms: handler(),
    alarmDetail: handler(),
    acknowledge: handler(),
    clear: handler(),
    listEvents: handler(),
    listTamperEvents: handler(),
  },
  esg: {
    overview: handler(),
    listHourly: handler(),
    listDaily: handler(),
    listReports: handler(),
    listDailySummary: handler(),
    listCalculationVersions: handler(),
    createExport: handler(),
    exportDetail: handler(),
  },
});

describe('AUTH-01 管理 API Lambda 组合根', () => {
  test('P0 范围 56 个管理业务 operation 全部可达真实 Handler', async () => {
    const targetIds = new Set([
      'createLicense',
      'createContract',
      'createConfiguration',
      'listConsumableStatus',
      'createConsumableRequest',
      'createDeviceUser',
      'listAlarms',
      'getEsgOverview',
    ]);
    const firstTargetIndex = DELIVERED_OPERATIONS.findIndex((operation) => targetIds.has(operation.operationId));
    const operations = DELIVERED_OPERATIONS.slice(firstTargetIndex);
    assert.equal(operations.length, 56);
    for (const operation of operations) {
      const path = operation.path.replaceAll(/\{[^}]+\}/gu, 'encoded%2Fid');
      const response = await createAdminRoute(
        { httpMethod: operation.method, path },
        routeSet(),
      )({
        headers: {},
        requestId: `trace-${operation.operationId}`,
      });
      assert.equal(response.status, 200, `${operation.operationId} 未路由到业务 Handler`);
    }
  });
  test('真实路由表把方法和路径映射到受保护业务 Handler', async () => {
    const approve = vi.fn(async (_request: AdminHttpRequest) => ({ status: 200, body: {} }));
    const route = createAdminRoute(
      { httpMethod: 'POST', path: '/api/v1/admin/onboarding/requests/request-1/approve' },
      { ...routeSet(), onboarding: { list: handler(), detail: handler(), approve, reject: handler() } },
    );
    await route({ headers: {}, requestId: 'trace-1' });
    assert.equal(approve.mock.calls[0]?.[0].params?.requestId, 'request-1');
  });

  test('未知路径失败关闭为 404', async () => {
    const route = createAdminRoute({ httpMethod: 'GET', path: '/api/v1/admin/unknown' }, routeSet());
    await expect(route({ headers: {}, requestId: 'trace-2' })).resolves.toMatchObject({ status: 404 });
  });

  test('证书轮换申请路由映射到受保护业务 Handler', async () => {
    const certificateRotation = vi.fn(async (_request: AdminHttpRequest) => ({ status: 201, body: {} }));
    const route = createAdminRoute(
      {
        httpMethod: 'POST',
        path: '/api/v1/admin/devices/device%2Fencoded/certificate-rotation-requests',
      },
      { ...routeSet(), certificateRotation },
    );
    const response = await route({ headers: {}, requestId: 'trace-cert' });

    assert.equal(response.status, 201);
    assert.equal(certificateRotation.mock.calls[0]?.[0].params?.deviceId, 'device/encoded');
  });

  test('Replay 创建/列表/详情均路由到真实 Handler，详情注入解码后的 jobId', async () => {
    const create = vi.fn(async (_request: AdminHttpRequest) => ({ status: 201, body: {} }));
    const list = vi.fn(async (_request: AdminHttpRequest) => ({ status: 200, body: {} }));
    const detail = vi.fn(async (_request: AdminHttpRequest) => ({ status: 200, body: {} }));
    const routes = { ...routeSet(), replay: { create, list, detail } };
    await createAdminRoute(
      { httpMethod: 'POST', path: '/api/v1/admin/replay/jobs' },
      routes,
    )({
      headers: {},
      requestId: 'trace-replay-create',
    });
    await createAdminRoute(
      { httpMethod: 'GET', path: '/api/v1/admin/replay/jobs' },
      routes,
    )({
      headers: {},
      requestId: 'trace-replay-list',
    });
    await createAdminRoute(
      { httpMethod: 'GET', path: '/api/v1/admin/replay/jobs/job%2F1' },
      routes,
    )({
      headers: {},
      requestId: 'trace-replay-detail',
    });

    assert.equal(create.mock.calls.length, 1);
    assert.equal(list.mock.calls.length, 1);
    assert.equal(detail.mock.calls[0]?.[0].params?.jobId, 'job/1');
  });

  test('CUS/DEV 25 个 OpenAPI operation 全部路由到生产 Handler，并解码路径参数', async () => {
    const cases: ReadonlyArray<{
      method: string;
      path: string;
      select: (routes: AdminOnboardingRouteSet) => ReturnType<typeof handler>;
      param?: readonly [string, string];
    }> = [
      { method: 'GET', path: '/api/v1/admin/customers', select: (r) => r.customers.list as ReturnType<typeof handler> },
      {
        method: 'POST',
        path: '/api/v1/admin/customers',
        select: (r) => r.customers.create as ReturnType<typeof handler>,
      },
      {
        method: 'GET',
        path: '/api/v1/admin/customers/customer%2F1',
        select: (r) => r.customers.detail as ReturnType<typeof handler>,
        param: ['customerId', 'customer/1'],
      },
      {
        method: 'PATCH',
        path: '/api/v1/admin/customers/customer%2F1',
        select: (r) => r.customers.update as ReturnType<typeof handler>,
        param: ['customerId', 'customer/1'],
      },
      {
        method: 'DELETE',
        path: '/api/v1/admin/customers/customer%2F1',
        select: (r) => r.customers.remove as ReturnType<typeof handler>,
        param: ['customerId', 'customer/1'],
      },
      {
        method: 'POST',
        path: '/api/v1/admin/customers/customer%2F1/deactivate',
        select: (r) => r.customers.deactivate as ReturnType<typeof handler>,
        param: ['customerId', 'customer/1'],
      },
      { method: 'GET', path: '/api/v1/admin/sites', select: (r) => r.sites.list as ReturnType<typeof handler> },
      { method: 'POST', path: '/api/v1/admin/sites', select: (r) => r.sites.create as ReturnType<typeof handler> },
      {
        method: 'GET',
        path: '/api/v1/admin/sites/site%2F1',
        select: (r) => r.sites.detail as ReturnType<typeof handler>,
        param: ['siteId', 'site/1'],
      },
      {
        method: 'PATCH',
        path: '/api/v1/admin/sites/site%2F1',
        select: (r) => r.sites.update as ReturnType<typeof handler>,
        param: ['siteId', 'site/1'],
      },
      {
        method: 'DELETE',
        path: '/api/v1/admin/sites/site%2F1',
        select: (r) => r.sites.remove as ReturnType<typeof handler>,
        param: ['siteId', 'site/1'],
      },
      {
        method: 'POST',
        path: '/api/v1/admin/sites/site%2F1/deactivate',
        select: (r) => r.sites.deactivate as ReturnType<typeof handler>,
        param: ['siteId', 'site/1'],
      },
      { method: 'GET', path: '/api/v1/admin/devices', select: (r) => r.devices.list as ReturnType<typeof handler> },
      {
        method: 'GET',
        path: '/api/v1/admin/devices/device%2F1',
        select: (r) => r.devices.detail as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'PATCH',
        path: '/api/v1/admin/devices/device%2F1/metadata',
        select: (r) => r.devices.updateMetadata as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'POST',
        path: '/api/v1/admin/devices/device%2F1/assignment',
        select: (r) => r.assignments.assign as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'GET',
        path: '/api/v1/admin/devices/device%2F1/assignments',
        select: (r) => r.assignments.history as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'POST',
        path: '/api/v1/admin/devices/device%2F1/suspend',
        select: (r) => r.statuses.suspend as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'POST',
        path: '/api/v1/admin/devices/device%2F1/reactivate',
        select: (r) => r.statuses.reactivate as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'POST',
        path: '/api/v1/admin/devices/device%2F1/retire',
        select: (r) => r.retirements.retire as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'POST',
        path: '/api/v1/admin/devices/device%2F1/retire/complete',
        select: (r) => r.retirements.forceComplete as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'GET',
        path: '/api/v1/admin/devices/device%2F1/console',
        select: (r) => r.console.getDeviceConsole as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'GET',
        path: '/api/v1/admin/devices/device%2F1/activities',
        select: (r) => r.console.listDeviceActivities as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'POST',
        path: '/api/v1/admin/devices/device%2F1/activities/export',
        select: (r) => r.console.createActivityExport as ReturnType<typeof handler>,
        param: ['deviceId', 'device/1'],
      },
      {
        method: 'GET',
        path: '/api/v1/admin/activity-exports/export%2F1',
        select: (r) => r.console.getActivityExport as ReturnType<typeof handler>,
        param: ['exportId', 'export/1'],
      },
    ];

    for (const item of cases) {
      const routes = routeSet();
      const selected = item.select(routes);
      const response = await createAdminRoute(
        { httpMethod: item.method, path: item.path },
        routes,
      )({
        headers: {},
        requestId: `trace-${item.method}-${item.path}`,
      });
      assert.equal(response.status, 200, `${item.method} ${item.path}`);
      assert.equal(selected.mock.calls.length, 1, `${item.method} ${item.path}`);
      if (item.param) assert.equal(selected.mock.calls[0]?.[0].params?.[item.param[0]], item.param[1]);
    }
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
