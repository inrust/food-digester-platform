/**
 * AUTH-01 验收：角色越权 403；Customer A 无法读取或修改 Customer B 数据。
 * 覆盖授权 Guard（requirePermission / assertCustomerScope）与 Decorator（withAuthorization）。
 */
import { assert, describe, test } from 'vitest';
import { assertCustomerScope, requirePermission, withAuthorization } from '../src/index.js';
import type { ActorContext } from '../src/index.js';
import { expectAuthError, expectAuthErrorSync } from './helpers.js';

const platformSuperAdmin: ActorContext = {
  actorId: 'p-1',
  username: 'root',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};

const auditor: ActorContext = {
  actorId: 'p-2',
  username: 'auditor',
  actorType: 'platform',
  roles: ['Auditor'],
  customerId: null,
  tokenUse: 'access',
};

const customerAdminA: ActorContext = {
  actorId: 'c-1',
  username: 'admin-a',
  actorType: 'customer',
  roles: ['CustomerAdmin'],
  customerId: 'cust-a',
  tokenUse: 'id',
};

const customerViewerB: ActorContext = {
  actorId: 'c-2',
  username: 'viewer-b',
  actorType: 'customer',
  roles: ['CustomerViewer'],
  customerId: 'cust-b',
  tokenUse: 'id',
};

describe('requirePermission：角色越权 → 403', () => {
  test('持有权限点放行', () => {
    assert.doesNotThrow(() => requirePermission(platformSuperAdmin, 'user:write'));
    assert.doesNotThrow(() => requirePermission(customerAdminA, 'device-user:write'));
  });

  test('Auditor 发起写操作 → 403；Customer 角色使用平台域权限 → 403', () => {
    expectAuthErrorSync(() => requirePermission(auditor, 'device:write'), 'FORBIDDEN');
    expectAuthErrorSync(() => requirePermission(customerAdminA, 'license:write'), 'FORBIDDEN');
    expectAuthErrorSync(() => requirePermission(customerViewerB, 'command:send'), 'FORBIDDEN');
  });
});

describe('assertCustomerScope：跨 Customer 访问 → 403', () => {
  test('platform actor 跨 Customer 放行（审计场景）', () => {
    assert.doesNotThrow(() => assertCustomerScope(auditor, 'cust-a'));
  });

  test('Customer A 访问自身数据放行', () => {
    assert.doesNotThrow(() => assertCustomerScope(customerAdminA, 'cust-a'));
  });

  test('Customer A 无法读取或修改 Customer B 数据', () => {
    expectAuthErrorSync(() => assertCustomerScope(customerAdminA, 'cust-b'), 'FORBIDDEN');
    expectAuthErrorSync(() => assertCustomerScope(customerViewerB, 'cust-a'), 'FORBIDDEN');
  });
});

describe('withAuthorization 授权 Decorator', () => {
  interface Req {
    readonly actor?: ActorContext | undefined;
    readonly customerId?: string | undefined;
  }

  const handler = withAuthorization<Req, string>(
    { permission: 'device:read', customerOf: (req) => req.customerId },
    async () => 'ok',
  );

  test('未注入 actor（未认证）→ 401', async () => {
    await expectAuthError(handler({ customerId: 'cust-a' }), 'UNAUTHENTICATED');
  });

  test('权限不足 → 403，不进入业务 Handler', async () => {
    let called = false;
    const guarded = withAuthorization<Req, void>({ permission: 'user:write' }, () => {
      called = true;
    });
    await expectAuthError(guarded({ actor: customerAdminA }), 'FORBIDDEN');
    assert.isFalse(called);
  });

  test('Customer A 请求 Customer B 资源 → 403；自身资源 → 通过', async () => {
    await expectAuthError(handler({ actor: customerAdminA, customerId: 'cust-b' }), 'FORBIDDEN');
    assert.equal(await handler({ actor: customerAdminA, customerId: 'cust-a' }), 'ok');
    assert.equal(await handler({ actor: auditor, customerId: 'cust-b' }), 'ok');
  });

  test('无 Customer 维度路由不做 scope 校验', async () => {
    const guarded = withAuthorization<Req, string>({ permission: 'dashboard:read' }, async () => 'ok');
    assert.equal(await guarded({ actor: customerViewerB }), 'ok');
  });
});
