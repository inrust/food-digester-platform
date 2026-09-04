/**
 * BE-SYNC-01 Unified Device Sync API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 完整事实快照：Assignment（名称/Region/授权窗口）、Alias、License/Entitlements/签名、
 *   Device Users（DEC-004 验证材料四字段）、Configuration、Operational Status 六域齐备；
 * - 不同生命周期快照正确：Active（300s）/Suspended（900s，可同步）/Maintenance（DEC-001 注入）；
 * - 未分配/未许可状态：assignment/license/configuration 为 null、deviceUsers 为空；
 * - Customer 数据不串线：仅本 Customer 且 ACTIVE 分配到本设备的用户下发；停用用户不下发；
 * - 未来生效配置不下发；etag 稳定域内容寻址（重复一致、alias 变更后变化）；
 * - 认证：Retired → 403；未登记证书/缺身份 → 401；请求体封闭校验 → 400。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { certificateFingerprintFromPem } from '@fdp/auth';
import { DEVICE_SYNC_ERROR_HTTP_STATUS, createDeviceSyncHandler } from '../src/index.js';
import type { DeviceSyncHandlerDeps } from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-08-30T08:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;
const DEVICE_USER_PHC =
  '$argon2id$v=19$m=32768,t=3,p=1$AAECAwQFBgcICQoLDA0ODw$u+TOcl2LGub4w/cLIdrGdoG/cbU//EuAXDXm+qRHfqs';
/** DEC-001 冻结值（组合根经 getMaintenanceSyncIntervalSeconds() 注入，测试直接给值）。 */
const MAINTENANCE_SYNC_SECONDS = 900;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function handler(): ReturnType<typeof createDeviceSyncHandler> {
  const deps: DeviceSyncHandlerDeps = {
    client: prisma,
    now,
    maintenanceSyncIntervalSeconds: MAINTENANCE_SYNC_SECONDS,
  };
  return createDeviceSyncHandler(deps);
}

function fixturePem(seed: string): string {
  const body = Buffer.from(`sync-cert-${seed}`, 'utf8').toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

let seq = 0;

interface PlantedDevice {
  deviceId: string;
  pem: string;
  customerId: string | null;
  siteId: string | null;
}

interface PlantOptions {
  readonly lifecycleStatus?: string;
  readonly operationalStatus?: string | null;
  readonly alias?: string | null;
  readonly withAssignment?: boolean;
  readonly customerName?: string;
  readonly model?: string;
  readonly lastHeartbeatAt?: Date | null;
}

async function plantDevice(options: PlantOptions = {}): Promise<PlantedDevice> {
  seq += 1;
  const n = seq;
  const lifecycleStatus = options.lifecycleStatus ?? 'Active';
  const withAssignment = options.withAssignment ?? true;

  let customerId: string | null = null;
  let siteId: string | null = null;
  if (withAssignment) {
    const customer = await prisma.customer.create({ data: { name: options.customerName ?? `Customer SYNC ${n}` } });
    const site = await prisma.site.create({
      data: { customerId: customer.id, name: `Site SYNC ${n}`, region: 'CN-East', subregion: 'Shanghai' },
    });
    customerId = customer.id;
    siteId = site.id;
  }

  const deviceId = `dev-sync-${n}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-SYNC-${n}`,
      model: options.model ?? 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus,
      alias: options.alias === undefined ? `发酵罐-${n}` : options.alias,
      customerId,
      siteId,
      firmwareVersion: 'FW-2.1.0',
    },
  });

  if (withAssignment && customerId && siteId) {
    await prisma.deviceAssignment.create({
      data: {
        deviceId,
        customerId,
        siteId,
        status: 'ACTIVE',
        assignedBy: 'admin-1',
        assignedAt: new Date(NOW.getTime() - 10 * DAY_MS),
      },
    });
  }

  const pem = fixturePem(`${n}`);
  await prisma.deviceCertificate.create({
    data: {
      id: `cert-sync-${n}`,
      deviceId,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      certificatePem: pem,
      packageCiphertext: Buffer.from('sync-secret-package'),
      notBefore: new Date(NOW.getTime() - 30 * DAY_MS),
      notAfter: new Date(NOW.getTime() + 200 * DAY_MS),
    },
  });

  if (options.operationalStatus !== undefined || options.lastHeartbeatAt !== undefined) {
    await prisma.deviceLatestState.create({
      data: {
        deviceId,
        customerId,
        operationalStatus: options.operationalStatus ?? null,
        lastHeartbeatAt:
          options.lastHeartbeatAt === undefined ? new Date(NOW.getTime() - 60_000) : options.lastHeartbeatAt,
      },
    });
  }

  return { deviceId, pem, customerId, siteId };
}

async function plantLicense(deviceId: string, customerId: string, status: string): Promise<string> {
  const license = await prisma.license.create({
    data: {
      deviceId,
      customerId,
      status,
      validFrom: new Date(NOW.getTime() - 5 * DAY_MS),
      validTo: new Date(NOW.getTime() + 60 * DAY_MS),
      signature: `sig-${deviceId}`,
      createdBy: 'admin-1',
      entitlements: {
        create: [
          { code: 'REMOTE_CONTROL', enabled: true },
          { code: 'OTA_UPDATE', enabled: true },
          { code: 'ESG_REPORTING', enabled: false },
        ],
      },
    },
  });
  return license.id;
}

async function plantDeviceUser(
  customerId: string,
  username: string,
  opts: { status?: string; assignTo?: string } = {},
): Promise<string> {
  const user = await prisma.deviceUser.create({
    data: {
      customerId,
      username,
      displayName: username,
      passwordHash: DEVICE_USER_PHC,
      status: opts.status ?? 'ACTIVE',
    },
  });
  if (opts.assignTo) {
    await prisma.deviceUserAssignment.create({
      data: {
        deviceUserId: user.id,
        deviceId: opts.assignTo,
        customerId,
        status: 'ACTIVE',
        assignedAt: new Date(NOW.getTime() - DAY_MS),
      },
    });
  }
  return user.id;
}

const VALID_PAYLOAD = {
  heartbeatInterval: 60,
  telemetryInterval: 30,
  cameraRefreshInterval: 1,
  temperatureThreshold: 80,
};

async function plantConfiguration(target: { deviceId?: string; model?: string }, effectiveAt: Date): Promise<string> {
  const config = await prisma.deviceConfiguration.create({
    data: {
      name: `CFG-${target.deviceId ?? target.model}`,
      targetDeviceId: target.deviceId ?? null,
      targetModel: target.model ?? null,
      createdBy: 'admin-1',
    },
  });
  await prisma.configurationVersion.create({
    data: {
      configurationId: config.id,
      version: 1,
      payload: VALID_PAYLOAD,
      status: 'PUBLISHED',
      effectiveAt,
    },
  });
  return config.id;
}

type DataBody = { data: Record<string, any>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

const dataOf = (res: { body: unknown }) => (res.body as DataBody).data;

describe('POST /api/v1/device/sync（完整事实快照）', () => {
  test('六域齐备：Assignment/Alias/License+签名/Device Users+验证材料/Configuration/Operational Status', async () => {
    const { deviceId, pem, customerId, siteId } = await plantDevice({
      lifecycleStatus: 'Active',
      operationalStatus: 'Active',
      lastHeartbeatAt: new Date(NOW.getTime() - 60_000),
      customerName: 'Customer FULL',
    });
    const licenseId = await plantLicense(deviceId, customerId as string, 'Active');
    const userId = await plantDeviceUser(customerId as string, 'operator-full', { assignTo: deviceId });
    const configId = await plantConfiguration({ deviceId }, new Date(NOW.getTime() - DAY_MS));

    const res = await handler()({
      identity: { clientCertPem: pem },
      body: { lastSyncTime: '2026-08-30T07:00:00Z' },
      requestId: 'req-s1',
    });
    assert.equal(res.status, 200);
    const data = dataOf(res);

    assert.equal(data.deviceId, deviceId);
    assert.equal(data.snapshotAt, NOW.toISOString());
    assert.equal(data.lastSyncTime, '2026-08-30T07:00:00.000Z');
    assert.equal(typeof data.etag, 'string');

    // Assignment：名称 + Region + 授权窗口
    assert.equal(data.assignment.customerId, customerId);
    assert.equal(data.assignment.customerName, 'Customer FULL');
    assert.equal(data.assignment.siteId, siteId);
    assert.equal(data.assignment.siteName, `Site SYNC ${seq}`);
    assert.equal(data.assignment.region, 'CN-East');
    assert.equal(data.assignment.subregion, 'Shanghai');
    assert.equal(data.assignment.endedAt, null);

    // Device Metadata：别名
    assert.equal(data.device.alias, `发酵罐-${seq}`);
    assert.equal(data.device.serialNumber, `SN-SYNC-${seq}`);
    assert.equal(data.device.model, 'BNX-100');
    assert.equal(data.device.firmwareVersion, 'FW-2.1.0');

    // License：状态/有效期/Entitlements（仅 enabled）/签名/版本
    assert.equal(data.license.licenseId, licenseId);
    assert.equal(data.license.status, 'Active');
    assert.equal(data.license.signature, `sig-${deviceId}`);
    assert.equal(data.license.effective, true);
    assert.deepEqual([...data.license.entitlements].sort(), ['OTA_UPDATE', 'REMOTE_CONTROL']);

    // Device Users：DEC-004@1.0.0 PHC（Sync 唯一下发通道）
    assert.equal(data.deviceUsers.length, 1);
    const u = data.deviceUsers[0];
    assert.equal(u.userId, userId);
    assert.equal(u.username, 'operator-full');
    assert.equal(u.displayName, 'operator-full');
    assert.equal(u.passwordHash, DEVICE_USER_PHC);
    assert.equal(u.status, 'ACTIVE');

    // Configuration：设备定向已生效版本
    assert.equal(data.configuration.heartbeatInterval, 60);
    assert.equal(data.configuration.telemetryInterval, 30);
    assert.ok(configId);

    // Operational Status：Active + ONLINE + 300s
    assert.equal(data.operationalStatus.lifecycleStatus, 'Active');
    assert.equal(data.operationalStatus.operationalStatus, 'Active');
    assert.equal(data.operationalStatus.connectivity, 'ONLINE');
    assert.equal(data.operationalStatus.syncIntervalSeconds, 300);
  });

  test('未分配/未许可设备：assignment/license/configuration 为 null、deviceUsers 为空（型号配置仍可下发）', async () => {
    const unassigned = await plantDevice({ lifecycleStatus: 'Onboarded', withAssignment: false });
    const res = await handler()({ identity: { clientCertPem: unassigned.pem }, requestId: 'req-s2' });
    assert.equal(res.status, 200);
    const data = dataOf(res);
    assert.equal(data.assignment, null);
    assert.equal(data.license, null);
    assert.deepEqual(data.deviceUsers, []);
    assert.equal(data.configuration, null);
    assert.equal(data.operationalStatus.lifecycleStatus, 'Onboarded');
    assert.equal(data.operationalStatus.connectivity, 'OFFLINE');
    assert.equal(data.operationalStatus.syncIntervalSeconds, 300);

    // 型号定向配置对未分配设备仍下发
    const modelCfg = await plantDevice({ lifecycleStatus: 'Onboarded', withAssignment: false });
    await plantConfiguration({ model: 'BNX-100' }, new Date(NOW.getTime() - DAY_MS));
    const res2 = await handler()({ identity: { clientCertPem: modelCfg.pem }, requestId: 'req-s3' });
    assert.equal(res2.status, 200);
    assert.ok(dataOf(res2).configuration, '型号定向配置应下发');
  });

  test('Suspended 设备可同步且节奏 900s；Maintenance 节奏经 DEC-001 注入', async () => {
    const suspended = await plantDevice({
      lifecycleStatus: 'Suspended',
      operationalStatus: 'Suspended',
      customerName: 'Customer SUSP',
    });
    const res = await handler()({ identity: { clientCertPem: suspended.pem }, requestId: 'req-s4' });
    assert.equal(res.status, 200);
    assert.equal(dataOf(res).operationalStatus.syncIntervalSeconds, 900);

    const maintenance = await plantDevice({
      lifecycleStatus: 'Active',
      operationalStatus: 'Maintenance',
      customerName: 'Customer MAINT',
    });
    const res2 = await handler()({ identity: { clientCertPem: maintenance.pem }, requestId: 'req-s5' });
    assert.equal(res2.status, 200);
    const op = dataOf(res2).operationalStatus;
    assert.equal(op.operationalStatus, 'Maintenance');
    assert.equal(op.syncIntervalSeconds, MAINTENANCE_SYNC_SECONDS, 'Maintenance 节奏由 DEC-001 注入');
  });

  test('Customer 数据不串线；停用用户与未分配本设备的用户不下发', async () => {
    const a = await plantDevice({ customerName: 'Customer A' });
    const b = await plantDevice({ customerName: 'Customer B' });
    await plantDeviceUser(a.customerId as string, 'op-a-assigned', { assignTo: a.deviceId });
    await plantDeviceUser(a.customerId as string, 'op-a-not-assigned');
    await plantDeviceUser(a.customerId as string, 'op-a-disabled', { status: 'DISABLED', assignTo: a.deviceId });
    await plantDeviceUser(b.customerId as string, 'op-b', { assignTo: b.deviceId });

    const res = await handler()({ identity: { clientCertPem: a.pem }, requestId: 'req-s6' });
    assert.equal(res.status, 200);
    const users = dataOf(res).deviceUsers;
    assert.equal(users.length, 1, '仅本 Customer + ACTIVE + 分配到本设备');
    assert.equal(users[0].username, 'op-a-assigned');

    const resB = await handler()({ identity: { clientCertPem: b.pem }, requestId: 'req-s7' });
    assert.equal(dataOf(resB).deviceUsers.length, 1);
    assert.equal(dataOf(resB).deviceUsers[0].username, 'op-b');
    assert.notEqual(dataOf(resB).assignment.customerName, dataOf(res).assignment.customerName);
  });

  test('未来生效配置不下发；过期 License 标记 effective=false 但仍可见最新状态', async () => {
    const d = await plantDevice({ customerName: 'Customer FUT', model: 'BNX-FUT' });
    await plantConfiguration({ deviceId: d.deviceId }, new Date(NOW.getTime() + DAY_MS));
    await plantLicense(d.deviceId, d.customerId as string, 'Expired');

    const res = await handler()({ identity: { clientCertPem: d.pem }, requestId: 'req-s8' });
    assert.equal(res.status, 200);
    const data = dataOf(res);
    assert.equal(data.configuration, null, '未来生效版本不下发');
    assert.equal(data.license.status, 'Expired');
    assert.equal(data.license.effective, false);
  });

  test('etag 稳定域内容寻址：重复一致；alias 变更后变化；心跳变化不影响 etag', async () => {
    const d = await plantDevice({
      customerName: 'Customer ETAG',
      operationalStatus: 'Active',
      lastHeartbeatAt: new Date(NOW.getTime() - 60_000),
    });
    const first = dataOf(await handler()({ identity: { clientCertPem: d.pem }, requestId: 'req-s9' }));
    const second = dataOf(await handler()({ identity: { clientCertPem: d.pem }, requestId: 'req-s10' }));
    assert.equal(second.etag, first.etag, '重复同步 etag 一致');

    // volatile 域（心跳）变化不影响 etag
    await prisma.deviceLatestState.update({
      where: { deviceId: d.deviceId },
      data: { lastHeartbeatAt: new Date(NOW.getTime() - 5_000) },
    });
    const heartbeatChanged = dataOf(await handler()({ identity: { clientCertPem: d.pem }, requestId: 'req-s11' }));
    assert.equal(heartbeatChanged.etag, first.etag, '心跳为 volatile 域');

    // 稳定域（alias）变化 → etag 变化
    await prisma.device.update({ where: { id: d.deviceId }, data: { alias: '新别名' } });
    const aliasChanged = dataOf(await handler()({ identity: { clientCertPem: d.pem }, requestId: 'req-s12' }));
    assert.notEqual(aliasChanged.etag, first.etag);
  });
});

describe('认证与请求校验', () => {
  test('Retired 设备 → 403；未登记证书/缺身份 → 401', async () => {
    const retired = await plantDevice({ lifecycleStatus: 'Retired', customerName: 'Customer RET' });
    const resRetired = await handler()({ identity: { clientCertPem: retired.pem }, requestId: 'req-s13' });
    assert.equal(resRetired.status, 403);
    assert.equal((resRetired.body as ErrorBody).error.code, 'FORBIDDEN');

    const resUnknown = await handler()({ identity: { clientCertPem: fixturePem('unknown') }, requestId: 'req-s14' });
    assert.equal(resUnknown.status, 401);

    const resMissing = await handler()({ requestId: 'req-s15' });
    assert.equal(resMissing.status, 401);
  });

  test('请求体封闭校验：非法 lastSyncTime/未知字段 → 400；省略 body 视为首次同步', async () => {
    const d = await plantDevice({ customerName: 'Customer VAL' });

    const badTs = await handler()({
      identity: { clientCertPem: d.pem },
      body: { lastSyncTime: '2026-08-30 08:00:00' },
      requestId: 'req-s16',
    });
    assert.equal(badTs.status, 400);
    assert.equal((badTs.body as ErrorBody).error.code, 'VALIDATION_FAILED');

    const unknownField = await handler()({
      identity: { clientCertPem: d.pem },
      body: { lastSyncTime: null, deviceId: d.deviceId },
      requestId: 'req-s17',
    });
    assert.equal(unknownField.status, 400);

    const firstSync = await handler()({ identity: { clientCertPem: d.pem }, requestId: 'req-s18' });
    assert.equal(firstSync.status, 200);
    assert.equal(dataOf(firstSync).lastSyncTime, null);

    // 响应不泄露敏感材料（证书包/私钥/明文密码字段）
    const raw = JSON.stringify(firstSync.body);
    assert.ok(!/sync-secret-package|BEGIN CERTIFICATE|privateKey|plainPassword/i.test(raw));
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('DeviceSyncError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(DEVICE_SYNC_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('响应字段与 OpenAPI DeviceSyncSnapshot 契约一致（含嵌套域）', async () => {
    const api = loadJson('device-sync-api.json');
    const d = await plantDevice({
      customerName: 'Customer CONTRACT',
      operationalStatus: 'Active',
      lastHeartbeatAt: new Date(NOW.getTime() - 60_000),
    });
    await plantLicense(d.deviceId, d.customerId as string, 'Active');
    await plantDeviceUser(d.customerId as string, 'op-contract', { assignTo: d.deviceId });
    await plantConfiguration({ deviceId: d.deviceId }, new Date(NOW.getTime() - DAY_MS));

    const res = await handler()({ identity: { clientCertPem: d.pem }, requestId: 'req-s19' });
    assert.equal(res.status, 200);
    const data = dataOf(res);
    const schemas = api.components.schemas;
    const assertContract = (
      value: Record<string, unknown>,
      schema: { required: string[]; properties: Record<string, unknown> },
    ) => {
      assert.ok(schema.required.every((field: string) => field in value));
      assert.ok(Object.keys(value).every((field) => field in schema.properties));
    };
    assertContract(data, schemas.DeviceSyncSnapshot);
    assertContract(data.assignment, schemas.SyncAssignment);
    assertContract(data.device, schemas.SyncDeviceMetadata);
    assertContract(data.license, schemas.SyncLicense);
    assertContract(data.deviceUsers[0], schemas.SyncDeviceUser);
    assertContract(data.configuration, schemas.SyncConfiguration);
    assertContract(data.operationalStatus, schemas.SyncOperationalStatus);
  });

  test('sync 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/device/', import.meta.url));
    for (const file of ['sync.ts', 'sync-handler.ts']) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
