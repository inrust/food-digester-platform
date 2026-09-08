import { assert, describe, test } from 'vitest';
import type { ActorContext } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import {
  createAdminCustomerHandlers,
  createAdminDeviceAssignmentHandlers,
  createAdminDeviceConsoleHandlers,
  createAdminDeviceHandlers,
  createAdminDeviceRetirementHandlers,
  createAdminDeviceStatusHandlers,
  createAdminSiteHandlers,
} from '../src/index.js';
import type { AdminHttpRequest, AdminHttpResponse } from '../src/index.js';
import { assertOpenApiResponse } from './openapi-response.js';

const client = {} as DbClient;
const actor: ActorContext = {
  actorId: 'strict-contract-admin',
  username: 'strict-contract-admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};
const now = () => new Date('2026-09-08T09:00:00Z');
const customer = createAdminCustomerHandlers({ client, now });
const site = createAdminSiteHandlers({ client, now });
const assignment = createAdminDeviceAssignmentHandlers({ client, now });
const status = createAdminDeviceStatusHandlers({ client, now });
const retirement = createAdminDeviceRetirementHandlers({
  client,
  now,
  iot: { deactivateCertificate: async () => {} },
});
const console_ = createAdminDeviceConsoleHandlers({
  client,
  now,
  storage: { put: async () => {} },
  urlSigner: { sign: async () => 'https://example.invalid/export.csv' },
});
const device = createAdminDeviceHandlers({ client, now });

const request = (body: unknown): AdminHttpRequest => ({
  actor,
  headers: { 'if-match': '1' },
  params: { customerId: 'customer-1', siteId: 'site-1', deviceId: 'device-1' },
  requestId: `strict-${Math.random().toString(36).slice(2)}`,
  body,
});

type Probe = readonly [
  operationId: string,
  invoke: (req: AdminHttpRequest) => Promise<AdminHttpResponse>,
  body: unknown,
];

const unknownFieldProbes: readonly Probe[] = [
  ['createCustomer', customer.create, { name: 'Customer', unexpected: true }],
  ['updateCustomer', customer.update, { name: 'Customer', unexpected: true }],
  ['deactivateCustomer', customer.deactivate, { reason: 'reason', unexpected: true }],
  ['deleteCustomer', customer.remove, {}],
  ['createSite', site.create, { customerId: 'customer-1', name: 'Site', unexpected: true }],
  ['updateSite', site.update, { name: 'Site', unexpected: true }],
  ['deactivateSite', site.deactivate, { reason: 'reason', unexpected: true }],
  ['deleteSite', site.remove, {}],
  ['assignDevice', assignment.assign, { customerId: 'customer-1', siteId: 'site-1', unexpected: true }],
  ['suspendDevice', status.suspend, { reason: 'reason', unexpected: true }],
  ['reactivateDevice', status.reactivate, { reason: 'reason', issueResolved: true, unexpected: true }],
  ['retireDevice', retirement.retire, { reason: 'reason', confirm: true, unexpected: true }],
  ['forceCompleteRetirement', retirement.forceComplete, { reason: 'reason', unexpected: true }],
  ['createActivityExport', console_.createActivityExport, { unexpected: true }],
  ['updateDeviceMetadata', device.updateMetadata, { alias: 'alias', unexpected: true }],
];

describe('BE-CUS/DEV 写请求与 OpenAPI 反向契约', () => {
  test('全部写操作在进入数据库前拒绝未知字段或未声明请求体，并以真实 Handler 响应通过 OpenAPI', async () => {
    for (const [operationId, invoke, body] of unknownFieldProbes) {
      const response = await invoke(request(body));
      assert.equal(response.status, 400, operationId);
      assertOpenApiResponse(operationId, response.status, response.body);
    }
  });

  test('共享封闭校验拒绝非对象请求体，Activity Export 不再静默丢弃错误类型', async () => {
    for (const [operationId, invoke] of unknownFieldProbes.filter(([id]) => !id.startsWith('delete'))) {
      const response = await invoke(request([]));
      assert.equal(response.status, 400, operationId);
      assertOpenApiResponse(operationId, response.status, response.body);
    }
    const wrongType = await console_.createActivityExport(request({ level: 42 }));
    assert.equal(wrongType.status, 400);
    assertOpenApiResponse('createActivityExport', wrongType.status, wrongType.body);
  });
});
