/**
 * P1 跨模块写请求失败关闭：每个目标写 Handler 必须在 DB/KDF/外部副作用前拒绝未知字段。
 * 同时以真实 Handler 错误响应反向校验统一 OpenAPI bundle。
 */
import type { ActorContext } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { assert, describe, test } from 'vitest';
import {
  createAdminAlarmHandlers,
  createAdminConfigurationHandlers,
  createAdminConsumableRequestHandlers,
  createAdminContractDeviceHandlers,
  createAdminContractHandlers,
  createAdminDeviceUserHandlers,
  createAdminEsgHandlers,
  createAdminLicenseHandlers,
} from '../src/index.js';
import type { AdminHttpRequest, AdminHttpResponse } from '../src/index.js';
import { assertOpenApiResponse } from './openapi-response.js';

const actor: ActorContext = {
  actorId: 'admin-p1',
  username: 'admin-p1',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};

function request(body: unknown, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: 'req-admin-p1-strict',
    body,
    ...options,
  };
}

describe('P1 目标写 Handler 严格请求边界', () => {
  test('所有写操作在任何 DB/KDF/外部副作用前拒绝未知字段，且 400 响应符合 OpenAPI', async () => {
    let dataAccesses = 0;
    let kdfCalls = 0;
    const client = new Proxy(
      {},
      {
        get() {
          dataAccesses += 1;
          throw new Error('strict validation accessed the database');
        },
      },
    ) as DbClient;
    const common = { client, now: () => new Date('2026-09-08T12:45:00.000Z') };
    const license = createAdminLicenseHandlers({ ...common, signingKey: 'strict-test-key' });
    const contract = createAdminContractHandlers(common);
    const contractDevice = createAdminContractDeviceHandlers(common);
    const configuration = createAdminConfigurationHandlers(common);
    const consumable = createAdminConsumableRequestHandlers(common);
    const deviceUser = createAdminDeviceUserHandlers({
      ...common,
      hashPassword: async () => {
        kdfCalls += 1;
        return 'must-not-run';
      },
    });
    const alarm = createAdminAlarmHandlers(common);
    const esg = createAdminEsgHandlers({
      ...common,
      storage: { put: async () => undefined },
      urlSigner: { sign: async () => 'https://example.invalid/export' },
    });
    const unknown = { unexpected: true };
    const path = {
      params: {
        licenseId: 'lic-1',
        contractId: 'con-1',
        deviceUserId: 'usr-1',
        alarmId: 'alm-1',
        configurationId: 'cfg-1',
        requestId: 'csr-1',
      },
    };
    const versioned = { ...path, headers: { 'If-Match': '1' } };

    const cases: readonly [string, () => Promise<AdminHttpResponse>][] = [
      ['createLicense', () => license.create(request(unknown))],
      ['issueLicense', () => license.issue(request(unknown, path))],
      ['activateLicense', () => license.activate(request(unknown, path))],
      ['renewLicense', () => license.renew(request(unknown, path))],
      ['revokeLicense', () => license.revoke(request(unknown, path))],
      ['evaluateLicense', () => license.evaluate(request(unknown, path))],
      ['createContract', () => contract.create(request(unknown))],
      ['updateContract', () => contract.update(request(unknown, versioned))],
      ['activateContract', () => contract.activate(request(unknown, versioned))],
      ['renewContract', () => contract.renew(request(unknown, versioned))],
      ['terminateContract', () => contract.terminate(request(unknown, versioned))],
      ['evaluateContract', () => contract.evaluate(request(unknown, versioned))],
      ['bindContractDevices', () => contractDevice.bind(request(unknown, path))],
      ['unbindContractDevices', () => contractDevice.unbind(request(unknown, path))],
      ['createConfiguration', () => configuration.create(request(unknown))],
      ['createConfigurationVersion', () => configuration.createVersion(request(unknown, path))],
      ['publishConfigurationVersion', () => configuration.publishVersion(request(unknown, path))],
      ['createConsumableRequest', () => consumable.create(request(unknown))],
      ['processConsumableRequest', () => consumable.process(request(unknown, versioned))],
      ['completeConsumableRequest', () => consumable.complete(request(unknown, versioned))],
      ['cancelConsumableRequest', () => consumable.cancel(request(unknown, versioned))],
      ['createDeviceUser', () => deviceUser.create(request(unknown))],
      ['updateDeviceUser', () => deviceUser.update(request(unknown, versioned))],
      ['disableDeviceUser', () => deviceUser.disable(request(unknown, versioned))],
      ['assignDeviceUser', () => deviceUser.assign(request(unknown, versioned))],
      ['revokeDeviceUser', () => deviceUser.revoke(request(unknown, versioned))],
      ['acknowledgeAlarm', () => alarm.acknowledge(request(unknown, path))],
      ['clearAlarm', () => alarm.clear(request(unknown, path))],
      ['createEsgExport', () => esg.createExport(request(unknown))],
    ];

    for (const [operationId, invoke] of cases) {
      const response = await invoke();
      assert.equal(response.status, 400, `${operationId} must reject unknown fields`);
      assertOpenApiResponse(operationId, 400, response.body);
    }
    assert.equal(dataAccesses, 0, '严格解析必须发生在数据库访问前');
    assert.equal(kdfCalls, 0, '严格解析必须发生在密码 KDF 前');
  });

  test('各模块拒绝非对象 body 与已知字段错误类型', async () => {
    const client = {} as DbClient;
    const common = { client };
    const handlers = [
      () => createAdminLicenseHandlers({ ...common, signingKey: 'strict-test-key' }).create(request([])),
      () => createAdminContractHandlers(common).create(request([])),
      () => createAdminContractDeviceHandlers(common).bind(request([])),
      () => createAdminConfigurationHandlers(common).create(request([])),
      () => createAdminConsumableRequestHandlers(common).create(request([])),
      () => createAdminDeviceUserHandlers(common).create(request([])),
      () => createAdminAlarmHandlers(common).acknowledge(request([])),
      () =>
        createAdminEsgHandlers({
          ...common,
          storage: { put: async () => undefined },
          urlSigner: { sign: async () => 'https://example.invalid/export' },
        }).createExport(request([])),
    ];
    for (const invoke of handlers) assert.equal((await invoke()).status, 400);

    assert.equal(
      (await createAdminLicenseHandlers({ ...common, signingKey: 'strict-test-key' }).create(request({ deviceId: 7 })))
        .status,
      400,
    );
    assert.equal((await createAdminAlarmHandlers(common).acknowledge(request({ reason: 7 }))).status, 400);
  });
});
