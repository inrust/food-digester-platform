/**
 * BE-DEV-01 Device 台账查询 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 原型设备群表格字段均有来源（序列号/型号/证书摘要/固件/Customer/Site/Region/Subregion/
 *   生命周期/Operational/连接/License+Entitlement/Contract 摘要/最新 Heartbeat）；
 * - 四轴状态可组合筛选且互不覆盖（lifecycle × operational × connectivity × licenseStatus）；
 * - 连接状态由 lastHeartbeatAt 与明确阈值派生，不写回生命周期字段；
 * - Customer 角色只看到本 Customer 设备（列表强制 scope、详情跨 Customer/未分配 403）；
 * - 无 N+1 查询回归（列表：1 次 device.findMany + 1 次 contractDevice.findMany，计数器断言）；
 * - 不返回私钥或完整证书（仅 certificateId + fingerprint）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { DbClient, PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_DEVICE_ERROR_HTTP_STATUS, createAdminDeviceHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-28T14:00:00Z');
const THRESHOLD_MS = 10 * 60 * 1000;

const superAdmin: ActorContext = {
  actorId: 'admin-1',
  username: 'admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};
const operator: ActorContext = { ...superAdmin, actorId: 'op-1', roles: ['PlatformOperator'] };
const auditor: ActorContext = { ...superAdmin, actorId: 'au-1', roles: ['Auditor'] };

function customerActor(customerId: string): ActorContext {
  return { ...superAdmin, actorId: 'ca-1', actorType: 'customer', roles: ['CustomerAdmin'], customerId };
}

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function handlers(client?: DbClient) {
  return createAdminDeviceHandlers({
    client: client ?? prisma,
    now: () => NOW,
    connectivityThresholdMs: THRESHOLD_MS,
  });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

let seq = 0;
async function plantCustomer() {
  seq += 1;
  return prisma.customer.create({ data: { name: `Customer DEV ${seq}` } });
}

async function plantSite(customerId: string, region: string, subregion: string) {
  seq += 1;
  return prisma.site.create({ data: { customerId, name: `Site ${seq}`, region, subregion } });
}

interface DeviceSeed {
  readonly customerId?: string;
  readonly siteId?: string;
  readonly lifecycleStatus?: string;
  readonly model?: string;
  readonly alias?: string;
  readonly serialNumber?: string;
  readonly firmwareVersion?: string;
  readonly operationalStatus?: string;
  /** 相对 NOW 的心跳偏移（毫秒）；undefined = 不写 latestState。 */
  readonly heartbeatOffsetMs?: number;
}

async function plantDevice(seed: DeviceSeed = {}) {
  seq += 1;
  const id = `dev-inv-${seq}`;
  const device = await prisma.device.create({
    data: {
      id,
      serialNumber: seed.serialNumber ?? `SN-INV-${seq}`,
      model: seed.model ?? 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      alias: seed.alias ?? null,
      firmwareVersion: seed.firmwareVersion ?? 'FW-1.2.3',
      lifecycleStatus: seed.lifecycleStatus ?? 'Active',
      customerId: seed.customerId ?? null,
      siteId: seed.siteId ?? null,
    },
  });
  if (seed.heartbeatOffsetMs !== undefined || seed.operationalStatus !== undefined) {
    await prisma.deviceLatestState.create({
      data: {
        deviceId: id,
        customerId: seed.customerId ?? null,
        operationalStatus: seed.operationalStatus ?? null,
        lastHeartbeatAt: seed.heartbeatOffsetMs !== undefined ? new Date(NOW.getTime() + seed.heartbeatOffsetMs) : null,
      },
    });
  }
  return device;
}

async function plantCertificate(deviceId: string, status: string) {
  seq += 1;
  return prisma.deviceCertificate.create({
    data: {
      id: `cert-${seq}`,
      deviceId,
      fingerprint: `fp-${seq}-${'a'.repeat(32)}`,
      status,
      certificatePem: '-----BEGIN CERTIFICATE-----MIIB-----END CERTIFICATE-----',
      packageCiphertext: Buffer.from('super-secret-package-material'),
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    },
  });
}

async function plantLicense(deviceId: string, customerId: string, status: string) {
  seq += 1;
  return prisma.license.create({
    data: {
      id: `lic-${seq}`,
      deviceId,
      customerId,
      status,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validTo: new Date('2027-01-01T00:00:00Z'),
      createdBy: 'test',
      entitlements: {
        create: [
          { code: 'REMOTE_CONTROL', enabled: true },
          { code: 'OTA_UPDATE', enabled: false },
        ],
      },
    },
  });
}

async function plantContract(customerId: string, deviceId: string) {
  seq += 1;
  const contract = await prisma.contract.create({
    data: {
      contractNumber: `CT-${seq}`,
      name: `合同 ${seq}`,
      customerId,
      startAt: new Date('2026-01-01T00:00:00Z'),
      endAt: new Date('2026-12-31T00:00:00Z'),
      status: 'EFFECTIVE',
      createdBy: 'test',
    },
  });
  await prisma.contractDevice.create({
    data: {
      contractId: contract.id,
      deviceId,
      customerId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      status: 'ACTIVE',
    },
  });
  return contract;
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ListBody = { data: Array<Record<string, unknown>>; meta: { nextCursor: string | null } };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

describe('GET /admin/devices/{deviceId}（详情：字段来源与敏感材料边界）', () => {
  test('原型设备群表格字段均有来源；证书仅摘要（不泄露 PEM/私钥/证书包）', async () => {
    const customer = await plantCustomer();
    const site = await plantSite(customer.id, '华东', '上海');
    const device = await plantDevice({
      customerId: customer.id,
      siteId: site.id,
      lifecycleStatus: 'Active',
      alias: '食堂一号机',
      operationalStatus: 'Active',
      heartbeatOffsetMs: -60_000,
    });
    const cert = await plantCertificate(device.id, 'ACTIVE');
    const license = await plantLicense(device.id, customer.id, 'Active');
    const contract = await plantContract(customer.id, device.id);

    const res = await handlers().detail(req(operator, { params: { deviceId: device.id } }));
    assert.equal(res.status, 200);
    assertOpenApiResponse('getDevice', res.status, res.body);
    const d = (res.body as DataBody).data as Record<string, any>;

    assert.equal(d.serialNumber, device.serialNumber);
    assert.equal(d.model, 'BNX-100');
    assert.equal(d.hardwareVersion, 'HW1.0');
    assert.equal(d.manufacturer, 'Hiddenjoy');
    assert.equal(d.manufactureDate, '2026-01-01');
    assert.equal(d.alias, '食堂一号机');
    assert.equal(d.firmwareVersion, 'FW-1.2.3');
    assert.deepEqual(d.customer, { id: customer.id, name: customer.name });
    assert.deepEqual(d.site, { id: site.id, name: site.name, region: '华东', subregion: '上海' });
    assert.equal(d.lifecycleStatus, 'Active');
    assert.equal(d.operationalStatus, 'Active');
    assert.equal(d.connectivity, 'ONLINE');
    assert.equal(d.lastHeartbeatAt, new Date(NOW.getTime() - 60_000).toISOString());
    assert.deepEqual(d.certificate, {
      certificateId: cert.id,
      fingerprint: cert.fingerprint,
      status: 'ACTIVE',
      mqttVerifiedAt: null,
      restVerifiedAt: null,
      rotationDeadlineAt: null,
      rotationConfirmedAt: null,
    });
    assert.equal(d.license.licenseId, license.id);
    assert.equal(d.license.status, 'Active');
    assert.equal(d.license.validFrom, '2026-01-01');
    assert.equal(d.license.validTo, '2027-01-01');
    assert.deepEqual(d.license.entitlements, ['REMOTE_CONTROL'], '仅启用中的 Entitlement');
    assert.equal(d.contract.contractId, contract.id);
    assert.equal(d.contract.contractNumber, contract.contractNumber);

    const raw = JSON.stringify(res.body);
    assert.ok(
      !/BEGIN CERTIFICATE|PRIVATE KEY|super-secret-package|certificatePem|packageCiphertext/.test(raw),
      '不返回私钥或完整证书',
    );
  });

  test('不存在 → 404；未认证 → 401', async () => {
    const h = handlers();
    assert.equal((await h.detail(req(operator, { params: { deviceId: 'dev-missing' } }))).status, 404);
    assert.equal((await h.detail(req(undefined, { params: { deviceId: 'x' } }))).status, 401);
  });
});

describe('GET /admin/devices（列表：四轴组合筛选互不覆盖）', () => {
  test('lifecycle × operational × connectivity × licenseStatus 组合精确命中', async () => {
    const customer = await plantCustomer();
    const site = await plantSite(customer.id, '华南', '深圳');
    // 目标设备：四轴全中
    const target = await plantDevice({
      customerId: customer.id,
      siteId: site.id,
      lifecycleStatus: 'Active',
      operationalStatus: 'Active',
      heartbeatOffsetMs: -60_000,
    });
    await plantLicense(target.id, customer.id, 'Active');
    // 干扰项：每个仅一轴偏离
    const wrongLifecycle = await plantDevice({
      customerId: customer.id,
      siteId: site.id,
      lifecycleStatus: 'Suspended',
      operationalStatus: 'Active',
      heartbeatOffsetMs: -60_000,
    });
    await plantLicense(wrongLifecycle.id, customer.id, 'Active');
    const wrongOperational = await plantDevice({
      customerId: customer.id,
      siteId: site.id,
      lifecycleStatus: 'Active',
      operationalStatus: 'Maintenance',
      heartbeatOffsetMs: -60_000,
    });
    await plantLicense(wrongOperational.id, customer.id, 'Active');
    const wrongConnectivity = await plantDevice({
      customerId: customer.id,
      siteId: site.id,
      lifecycleStatus: 'Active',
      operationalStatus: 'Active',
      heartbeatOffsetMs: -3_600_000,
    });
    await plantLicense(wrongConnectivity.id, customer.id, 'Active');
    const wrongLicense = await plantDevice({
      customerId: customer.id,
      siteId: site.id,
      lifecycleStatus: 'Active',
      operationalStatus: 'Active',
      heartbeatOffsetMs: -60_000,
    });
    await plantLicense(wrongLicense.id, customer.id, 'Expired');

    const h = handlers();
    const q = {
      customerId: customer.id,
      lifecycleStatus: 'Active',
      operationalStatus: 'Active',
      connectivity: 'ONLINE',
      licenseStatus: 'Active',
    };
    const res = await h.list(req(operator, { query: q }));
    assert.equal(res.status, 200);
    assertOpenApiResponse('listDevices', res.status, res.body);
    const ids = (res.body as ListBody).data.map((d) => d.id);
    assert.deepEqual(ids, [target.id], '四轴组合恰好命中目标设备');

    // 单轴验证：OFFLINE 命中超时与无 latestState 设备；None 命中无 License 设备
    const offline = await h.list(req(operator, { query: { customerId: customer.id, connectivity: 'OFFLINE' } }));
    const offlineIds = (offline.body as ListBody).data.map((d) => d.id);
    assert.ok(offlineIds.includes(wrongConnectivity.id) && !offlineIds.includes(target.id));
    const noLicense = await h.list(req(operator, { query: { customerId: customer.id, licenseStatus: 'None' } }));
    const noneIds = (noLicense.body as ListBody).data.map((d) => d.id);
    assert.equal(noneIds.length, 0, '本用例设备均有 License');
    const expired = await h.list(req(operator, { query: { customerId: customer.id, licenseStatus: 'Expired' } }));
    assert.deepEqual(
      (expired.body as ListBody).data.map((d) => d.id),
      [wrongLicense.id],
    );
  });

  test('连接状态由阈值派生且不写回生命周期字段', async () => {
    const customer = await plantCustomer();
    const online = await plantDevice({ customerId: customer.id, heartbeatOffsetMs: -(THRESHOLD_MS - 1000) });
    const edge = await plantDevice({ customerId: customer.id, heartbeatOffsetMs: -THRESHOLD_MS });
    const offline = await plantDevice({ customerId: customer.id, heartbeatOffsetMs: -(THRESHOLD_MS + 1) });
    const noState = await plantDevice({ customerId: customer.id });

    const h = handlers();
    const all = await h.list(req(operator, { query: { customerId: customer.id, limit: '100' } }));
    const byId = new Map((all.body as ListBody).data.map((d) => [d.id as string, d.connectivity as string]));
    assert.equal(byId.get(online.id), 'ONLINE');
    assert.equal(byId.get(edge.id), 'ONLINE', '恰好等于阈值仍在线');
    assert.equal(byId.get(offline.id), 'OFFLINE');
    assert.equal(byId.get(noState.id), 'OFFLINE', '无 latestState 视为 OFFLINE');

    const row = await prisma.device.findUniqueOrThrow({ where: { id: online.id } });
    assert.equal(row.lifecycleStatus, 'Active', '查询接口不修改生命周期字段');
    assert.equal(row.updatedAt.toISOString(), row.createdAt.toISOString(), '查询不产生任何写回');
  });

  test('region/subregion/siteId/model/keyword 筛选；非法枚举 → 400；分页不重不漏', async () => {
    const customer = await plantCustomer();
    const siteA = await plantSite(customer.id, '华东', '上海');
    const siteB = await plantSite(customer.id, '华北', '北京');
    const d1 = await plantDevice({
      customerId: customer.id,
      siteId: siteA.id,
      model: 'BNX-100',
      serialNumber: 'SN-KW-001',
      alias: '食堂一号机',
    });
    await plantDevice({ customerId: customer.id, siteId: siteB.id, model: 'BNX-200' });
    const h = handlers();

    const byRegion = await h.list(req(operator, { query: { customerId: customer.id, region: '华东' } }));
    assert.deepEqual(
      (byRegion.body as ListBody).data.map((d) => d.id),
      [d1.id],
    );
    const bySite = await h.list(req(operator, { query: { siteId: siteB.id } }));
    assert.equal((bySite.body as ListBody).data.length, 1);
    const byModel = await h.list(req(operator, { query: { customerId: customer.id, model: 'BNX-200' } }));
    assert.equal((byModel.body as ListBody).data.length, 1);
    const byKwSn = await h.list(req(operator, { query: { customerId: customer.id, keyword: 'kw-001' } }));
    assert.deepEqual(
      (byKwSn.body as ListBody).data.map((d) => d.id),
      [d1.id],
      '关键字大小写不敏感命中序列号',
    );
    const byKwAlias = await h.list(req(operator, { query: { customerId: customer.id, keyword: '食堂' } }));
    assert.deepEqual(
      (byKwAlias.body as ListBody).data.map((d) => d.id),
      [d1.id],
      '关键字命中别名',
    );

    for (const query of [
      { lifecycleStatus: 'Bogus' },
      { operationalStatus: 'Bogus' },
      { connectivity: 'Bogus' },
      { licenseStatus: 'Bogus' },
      { limit: '0' },
      { cursor: '!!!' },
    ]) {
      const res = await h.list(req(operator, { query }));
      assert.equal(res.status, 400, `query=${JSON.stringify(query)} 必须 400`);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.list(
        req(operator, { query: { customerId: customer.id, limit: '1', ...(cursor ? { cursor } : {}) } }),
      );
      const body = page.body as ListBody;
      seen.push(...body.data.map((d) => d.id as string));
      cursor = body.meta.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.length, 2);
    assert.equal(new Set(seen).size, 2, '分页不重不漏');
  });

  test('Customer 角色只看到本 Customer 设备；指定他人 customerId → 403', async () => {
    const a = await plantCustomer();
    const b = await plantCustomer();
    const devA = await plantDevice({ customerId: a.id });
    const devB = await plantDevice({ customerId: b.id });
    const unassigned = await plantDevice({});
    const h = handlers();

    const ownList = await h.list(req(customerActor(a.id), { query: { limit: '100' } }));
    const ids = (ownList.body as ListBody).data.map((d) => d.id);
    assert.ok(ids.includes(devA.id) && !ids.includes(devB.id) && !ids.includes(unassigned.id));

    const cross = await h.list(req(customerActor(a.id), { query: { customerId: b.id } }));
    assert.equal(cross.status, 403);
    assert.equal((cross.body as ErrorBody).error.code, 'FORBIDDEN');

    assert.equal((await h.detail(req(customerActor(a.id), { params: { deviceId: devA.id } }))).status, 200);
    assert.equal((await h.detail(req(customerActor(a.id), { params: { deviceId: devB.id } }))).status, 403);
    assert.equal(
      (await h.detail(req(customerActor(a.id), { params: { deviceId: unassigned.id } }))).status,
      403,
      '未分配设备对 Customer 角色不可见',
    );
    assert.equal((await h.detail(req(auditor, { params: { deviceId: devB.id } }))).status, 200, 'Auditor 平台只读');
  });

  test('无 N+1 查询回归：列表恰好 1 次 device.findMany + 1 次 contractDevice.findMany', async () => {
    const customer = await plantCustomer();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const d = await plantDevice({ customerId: customer.id });
      await plantContract(customer.id, d.id);
      ids.push(d.id);
    }

    const counts = { deviceFindMany: 0, contractDeviceFindMany: 0 };
    const countingClient = {
      device: {
        findMany: (args: unknown) => {
          counts.deviceFindMany += 1;
          return prisma.device.findMany(args as never);
        },
      },
      contractDevice: {
        findMany: (args: unknown) => {
          counts.contractDeviceFindMany += 1;
          return prisma.contractDevice.findMany(args as never);
        },
      },
    } as unknown as DbClient;

    const res = await handlers(countingClient).list(
      req(operator, { query: { customerId: customer.id, limit: '100' } }),
    );
    assert.equal(res.status, 200);
    assert.equal((res.body as ListBody).data.length, 3);
    assert.equal(counts.deviceFindMany, 1, '设备主查询恰好一次');
    assert.equal(counts.contractDeviceFindMany, 1, 'Contract 摘要按页批量一次');
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminDeviceError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_DEVICE_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('列表 DTO 字段与 OpenAPI Device 契约一致', async () => {
    const api = loadJson('admin-device-api.json');
    const required = [...api.components.schemas.Device.required].sort();
    const customer = await plantCustomer();
    const device = await plantDevice({ customerId: customer.id });
    const res = await handlers().detail(req(operator, { params: { deviceId: device.id } }));
    assert.deepEqual(Object.keys((res.body as DataBody).data).sort(), required);
  });

  test('admin/device 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/device/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
