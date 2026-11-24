import { contractHandler, createAjv } from '../../../contracts/testing/device-contract.js';
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
 * - 认证：DEC-014 窗口内待确认 Retired 仅 Sync 放行，窗口关闭 → 403；未登记/缺身份 → 401。
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
import { createAdminConfigurationHandlers } from '../src/admin/configuration/handler.js';
import { parseConfigurationDeliveryTargets } from '../src/device/configuration-delivery.js';
import type { ConfigurationDeliveryView } from '../src/device/configuration-delivery.js';
import { assertOpenApiResponse } from './openapi-response.js';

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
  return checkedCreateDeviceSyncHandler(deps);
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

type ErrorBody = { error: { code: string; message: string; requestId: string } };

const dataOf = (res: { body: unknown }) => res.body as Record<string, any>;
const syncReceiptStore = () =>
  (
    prisma as unknown as {
      deviceUserSyncReceipt: {
        findUnique(args: Record<string, unknown>): Promise<{
          servedAt: Date;
          acknowledgedAt: Date | null;
          deviceReportedLastSyncAt: Date | null;
        } | null>;
      };
    }
  ).deviceUserSyncReceipt;

describe('POST /api/v1/device/sync（完整事实快照）', () => {
  test.each([
    ['ACTIVE', 'Active', 300],
    ['MAINTENANCE', 'Maintenance', 900],
    ['SUSPENDED', 'Suspended', 300],
    ['RETIRED', 'Retired', 300],
  ] as const)('历史 MQTT %s 归一为 REST %s，ETag 与规范值一致', async (legacy, canonical, interval) => {
    const ctx = await plantDevice({ lifecycleStatus: 'Onboarded', operationalStatus: legacy });
    const first = await handler()({ identity: { clientCertPem: ctx.pem }, requestId: 'legacy-status' });
    assert.equal(first.status, 200);
    assert.equal(dataOf(first).operationalStatus.operationalStatus, canonical);
    assert.equal(dataOf(first).operationalStatus.syncIntervalSeconds, interval);
    await prisma.deviceLatestState.update({
      where: { deviceId: ctx.deviceId },
      data: { operationalStatus: canonical },
    });
    const second = await handler()({ identity: { clientCertPem: ctx.pem }, requestId: 'canonical-status' });
    assert.equal(dataOf(first).etag, dataOf(second).etag);
  });

  test('未知最新态不能泄漏进 REST 枚举；无可用生命周期回退时为 null', async () => {
    const ctx = await plantDevice({ lifecycleStatus: 'Onboarded', operationalStatus: 'UNRECOGNIZED' });
    const res = await handler()({ identity: { clientCertPem: ctx.pem }, requestId: 'unknown-status' });
    assert.equal(res.status, 200);
    assert.isNull(dataOf(res).operationalStatus.operationalStatus);
  });

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
    assert.equal(data.license.status, 'ACTIVE');
    assert.match(data.license.validFrom, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(data.license.validTo, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(data.license.signature, `sig-${deviceId}`);
    assert.equal(data.license.effective, true);
    assert.deepEqual([...data.license.entitlements].sort(), ['OTA', 'REMOTE_CONTROL']);

    // Device Users：DEC-004@1.0.0 PHC（Sync 唯一下发通道）
    assert.equal(data.deviceUsers.length, 1);
    const u = data.deviceUsers[0];
    assert.equal(u.userId, userId);
    assert.equal(u.username, 'operator-full');
    assert.equal(u.displayName, 'operator-full');
    assert.equal(u.passwordHash, DEVICE_USER_PHC);
    assert.equal(u.status, 'ACTIVE');

    const offered = await syncReceiptStore().findUnique({
      where: { deviceId_deviceUserId_entityVersion: { deviceId, deviceUserId: userId, entityVersion: 1 } },
    });
    assert.equal(offered?.servedAt.toISOString(), NOW.toISOString());
    assert.equal(offered?.acknowledgedAt, null);

    const acknowledged = await handler()({
      identity: { clientCertPem: pem },
      body: { lastSyncTime: NOW.toISOString() },
      requestId: 'req-s1-ack',
    });
    assert.equal(acknowledged.status, 200);
    const confirmed = await syncReceiptStore().findUnique({
      where: { deviceId_deviceUserId_entityVersion: { deviceId, deviceUserId: userId, entityVersion: 1 } },
    });
    assert.equal(confirmed?.acknowledgedAt?.toISOString(), NOW.toISOString());
    assert.equal(confirmed?.deviceReportedLastSyncAt?.toISOString(), NOW.toISOString());

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
    assert.equal(data.license.status, 'EXPIRED');
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

describe('证书 REST 验证提交', () => {
  test('仅成功快照的提交回调记录验证时间；错误响应不提供回调', async () => {
    const d = await plantDevice({ withAssignment: false });
    const where = { fingerprint: certificateFingerprintFromPem(d.pem) };
    const result = await handler()({ identity: { clientCertPem: d.pem }, requestId: 'rest-proof' });
    assert.equal(result.status, 200);
    assert.isNull((await prisma.deviceCertificate.findUnique({ where }))?.restVerifiedAt);
    await result.onCommitted?.();
    await result.onCommitted?.();
    const row = await prisma.deviceCertificate.findUnique({ where });
    assert.equal(row?.restVerifiedAt?.toISOString(), NOW.toISOString());
    assert.isNull(row?.mqttVerifiedAt);
    const bad = await handler()({
      identity: { clientCertPem: d.pem },
      body: { unknown: true },
      requestId: 'bad-proof',
    });
    assert.equal(bad.status, 400);
    assert.isUndefined(bad.onCommitted);
  });
});

describe('认证与请求校验', () => {
  test('DEC-014：Retired 待确认在 72h 内可 Sync，到达边界即 → 403', async () => {
    const retired = await plantDevice({ lifecycleStatus: 'Retired', customerName: 'Customer RET' });
    await prisma.deviceRetirement.create({
      data: {
        deviceId: retired.deviceId,
        reason: 'retire',
        initiatedBy: 'admin',
        initiatedAt: new Date(NOW.getTime() - 71 * 60 * 60 * 1000),
      },
    });
    const allowed = await handler()({ identity: { clientCertPem: retired.pem }, requestId: 'req-s13a' });
    assert.equal(allowed.status, 200);
    assert.equal(dataOf(allowed).operationalStatus.lifecycleStatus, 'Retired');

    await prisma.deviceRetirement.update({
      where: { deviceId: retired.deviceId },
      data: { initiatedAt: new Date(NOW.getTime() - 72 * 60 * 60 * 1000) },
    });
    const resRetired = await handler()({ identity: { clientCertPem: retired.pem }, requestId: 'req-s13b' });
    assert.equal(resRetired.status, 403);
    assert.equal((resRetired.body as ErrorBody).error.code, 'FORBIDDEN');
  });

  test('Retired 无待确认记录 → 403；未登记证书/缺身份 → 401', async () => {
    const retired = await plantDevice({ lifecycleStatus: 'Retired', customerName: 'Customer RET CLOSED' });
    const resRetired = await handler()({ identity: { clientCertPem: retired.pem }, requestId: 'req-s13c' });
    assert.equal(resRetired.status, 403);

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
    assertOpenApiResponse('syncDevice', res.status, res.body);
  });

  test('sync 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/device/', import.meta.url));
    for (const file of ['sync.ts', 'sync-handler.ts']) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});

const checkedCreateDeviceSyncHandler: typeof createDeviceSyncHandler = (deps) =>
  contractHandler('syncDevice', createDeviceSyncHandler(deps));

test('D/T11 R19 authenticated devices pull versioned JSON and only matching receipts advance delivery and application', async () => {
  const model = 'BNX-T11';
  const a = await plantDevice({ model, alias: 'T11-门店设备', lastHeartbeatAt: null });
  const modelConfigId = await plantConfiguration({ model }, new Date(NOW.getTime() - DAY_MS));
  const ownConfigId = await plantConfiguration({ deviceId: a.deviceId }, new Date(NOW.getTime() - DAY_MS));
  const ownSettings = { ...VALID_PAYLOAD, temperatureThreshold: 72.5 };
  await prisma.configurationVersion.update({
    where: { configurationId_version: { configurationId: ownConfigId, version: 1 } },
    data: { payload: ownSettings },
  });

  const b = await plantDevice({ model, lastHeartbeatAt: null });
  const customerId = a.customerId!;
  const contract = await prisma.contract.create({
    data: {
      contractNumber: 'T11-SAMPLE-01',
      name: 'T11 门店服务合约',
      customerId,
      status: 'EFFECTIVE',
      startAt: new Date(NOW.getTime() - DAY_MS),
      endAt: new Date(NOW.getTime() + DAY_MS),
      createdBy: 'fixture',
    },
  });
  await prisma.contractDevice.create({
    data: { contractId: contract.id, deviceId: a.deviceId, customerId, validFrom: contract.startAt },
  });
  await prisma.site.update({ where: { id: a.siteId! }, data: { name: 'T11 门店', region: '华东', subregion: 'T12' } });
  const clientVersion = 't11-host-fixture.1';
  const targets = parseConfigurationDeliveryTargets(
    JSON.stringify({
      [a.deviceId]: clientVersion,
      [b.deviceId]: clientVersion,
    }),
  );
  assert.equal(parseConfigurationDeliveryTargets('{ malformed').size, 0);
  assert.equal(parseConfigurationDeliveryTargets(JSON.stringify({ '*': clientVersion })).size, 0);
  const protocol = { configurationProtocol: { schemaVersion: 1, clientVersion } };
  const ajv = createAjv();
  const candidatePath = 'configuration/device-sync-configuration-delivery-candidate.openapi.json';
  const contracts = new URL('../../../contracts/', import.meta.url);
  for (const path of ['rest/openapi-base.json', 'rest/device-sync-api.json', candidatePath]) {
    ajv.addSchema(JSON.parse(readFileSync(new URL(path, contracts), 'utf8')), 'https://fdp.test/contracts/' + path);
  }
  const validate = (schema: string) =>
    ajv.compile({
      $ref: 'https://fdp.test/contracts/' + candidatePath + '#/components/schemas/' + schema,
    });
  const validRequest = validate('SyncRequest');
  const validSnapshot = validate('DeviceSyncSnapshot');
  const sync = async (device: PlantedDevice, body: unknown, at = NOW, gate = targets) => {
    const result = await createDeviceSyncHandler({
      client: prisma,
      configurationDeliveryTargets: gate,
      maintenanceSyncIntervalSeconds: MAINTENANCE_SYNC_SECONDS,
      now: () => at,
    })({ identity: { clientCertPem: device.pem }, requestId: 't11-sync', body });
    if (result.status === 200) {
      assert.isTrue(validRequest(body), ajv.errorsText(validRequest.errors));
      assert.isTrue(validSnapshot(result.body), ajv.errorsText(validSnapshot.errors));
    } else {
      assertOpenApiResponse('syncDevice', result.status, result.body);
    }
    return result;
  };

  const legacy = dataOf(await sync(a, {}));
  assert.notProperty(legacy, 'configurationDelivery');
  assert.deepEqual(legacy.configuration, ownSettings);
  for (const options of [
    { configurationProtocol: { schemaVersion: 1, clientVersion: 'different-build' } },
    { configurationProtocol: { schemaVersion: 2, clientVersion } },
  ]) {
    const fallback = dataOf(await sync(a, options));
    assert.notProperty(fallback, 'configurationDelivery');
    assert.equal(fallback.etag, legacy.etag);
  }
  assert.equal(await prisma.configurationDelivery.count({ where: { deviceId: a.deviceId } }), 0);

  const first = await sync(a, protocol);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const snapshot = dataOf(first);
  const delivery = snapshot.configurationDelivery as ConfigurationDeliveryView;
  assert.equal(delivery.schemaVersion, 1);
  assert.equal(delivery.configurationId, ownConfigId);
  assert.deepEqual(delivery.settings, ownSettings);
  assert.deepEqual(delivery.context, {
    alias: 'T11-门店设备',
    site: 'T11 门店',
    region: '华东',
    subregion: 'T12',
    contract: { contractNumber: 'T11-SAMPLE-01', name: 'T11 门店服务合约' },
  });
  assert.deepEqual(snapshot.configuration, ownSettings);
  assert.equal(snapshot.operationalStatus.connectivity, 'OFFLINE');
  assert.notEqual(snapshot.etag, legacy.etag);

  const modelSnapshot = dataOf(await sync(b, protocol));
  assert.equal(modelSnapshot.configurationDelivery.configurationId, modelConfigId);
  assert.deepEqual(modelSnapshot.configurationDelivery.settings, VALID_PAYLOAD);
  assert.isNull(modelSnapshot.configurationDelivery.context.contract);
  assert.notEqual(modelSnapshot.configurationDelivery.deliveryId, delivery.deliveryId);

  const receipt = { deliveryId: delivery.deliveryId, configurationId: ownConfigId, version: 1 };
  const receiptBody = (status: 'RECEIVED' | 'APPLIED') => ({
    ...protocol,
    configurationReceipt: { ...receipt, status },
  });
  const read = () => prisma.configurationDelivery.findUniqueOrThrow({ where: { id: delivery.deliveryId } });
  const next = new Date(NOW.getTime() + 1_000);
  const after = new Date(NOW.getTime() + 2_000);
  assert.equal((await sync(a, { ...protocol, lastSyncTime: next.toISOString() }, next)).status, 200);
  assert.isNull((await read()).receivedAt, 'legacy timestamp must not confirm configuration');
  assert.equal((await sync(b, receiptBody('APPLIED'), next)).status, 409, 'certificate identity must match');
  assert.equal(
    (await sync(a, { ...protocol, configurationReceipt: { ...receipt, version: 2, status: 'APPLIED' } }, next)).status,
    409,
  );
  assert.equal((await sync(a, { configurationReceipt: { ...receipt, status: 'APPLIED' } }, next)).status, 400);
  assert.equal((await sync(a, { ...protocol, configurationReceipt: { ...receipt, status: 'OK' } }, next)).status, 400);
  assert.isNull((await read()).receivedAt);

  assert.equal((await sync(a, receiptBody('RECEIVED'), next)).status, 200);
  assert.equal((await read()).receivedAt?.toISOString(), next.toISOString());
  assert.isNull((await read()).appliedAt);
  const retries = await Promise.all([sync(a, receiptBody('APPLIED'), after), sync(a, receiptBody('APPLIED'), after)]);
  assert.deepEqual(
    retries.map(({ status }) => status),
    [200, 200],
  );
  assert.equal((await read()).receivedAt?.toISOString(), next.toISOString());
  assert.equal((await read()).appliedAt?.toISOString(), after.toISOString());

  const admin = createAdminConfigurationHandlers({ client: prisma, now: () => after });
  const actor = {
    actorId: 't11-fixture',
    username: 't11-fixture',
    actorType: 'platform',
    roles: ['PlatformSuperAdmin'],
    customerId: null,
    tokenUse: 'access',
  } as const;
  const adminReq = (configurationId: string, version = 1) => ({
    actor,
    requestId: 't11-admin',
    headers: {},
    params: { configurationId, version: String(version) },
  });
  const state = await admin.versionStatus(adminReq(ownConfigId));
  assertOpenApiResponse('getConfigurationVersionStatus', state.status, state.body);
  const target = dataOf(state).data.targets[0];
  assert.equal(target.deviceId, a.deviceId);
  assert.equal(target.notificationStatus, 'NOT_QUEUED', 'offline pull does not imply any notification');
  assert.equal(target.delivery.appliedAt, after.toISOString());
  const effective = await admin.effectiveDevices(adminReq(modelConfigId));
  assertOpenApiResponse('listEffectiveConfigurationDevices', effective.status, effective.body);
  const rowA = dataOf(effective).data.find((row: { deviceId: string }) => row.deviceId === a.deviceId);
  const rowB = dataOf(effective).data.find((row: { deviceId: string }) => row.deviceId === b.deviceId);
  assert.equal(rowA.deviceAppliedConfiguration.configurationId, ownConfigId);
  assert.isNull(rowB.deviceAppliedConfiguration);

  await prisma.site.update({ where: { id: a.siteId! }, data: { subregion: 'T12-修订' } });
  const changed = dataOf(await sync(a, protocol, new Date(after.getTime() + 1_000))).configurationDelivery;
  assert.notEqual(changed.deliveryId, delivery.deliveryId);
  assert.equal(changed.context.subregion, 'T12-修订');
  const revised = dataOf(await admin.effectiveDevices(adminReq(ownConfigId))).data[0];
  assert.equal(revised.configurationDelivery.deliveryId, changed.deliveryId);
  assert.isNull(revised.deviceAppliedConfiguration, 'old JSON receipt cannot prove new derived context');

  const newer = await admin.createVersion({
    ...adminReq(ownConfigId),
    body: { payload: { ...ownSettings, heartbeatInterval: 120 } },
  });
  assert.equal(newer.status, 201);
  assert.equal((await admin.publishVersion({ ...adminReq(ownConfigId, 2), body: {} })).status, 200);
  const changedReceipt = {
    ...protocol,
    configurationReceipt: { ...receipt, deliveryId: changed.deliveryId, status: 'APPLIED' },
  };
  await prisma.$executeRawUnsafe(`CREATE FUNCTION t11_fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'controlled delivery failure'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER t11_fail_delivery BEFORE INSERT ON configuration_deliveries
    FOR EACH ROW EXECUTE FUNCTION t11_fail_delivery()`);
  try {
    assert.equal((await sync(a, changedReceipt, new Date(after.getTime() + 2_000))).status, 500);
    const unconfirmed = await prisma.configurationDelivery.findUniqueOrThrow({ where: { id: changed.deliveryId } });
    assert.isNull(unconfirmed.receivedAt);
    assert.isNull(unconfirmed.appliedAt);
    assert.equal(await prisma.configurationDelivery.count({ where: { deviceId: a.deviceId } }), 2);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER t11_fail_delivery ON configuration_deliveries');
    await prisma.$executeRawUnsafe('DROP FUNCTION t11_fail_delivery()');
  }
  const updated = dataOf(await sync(a, changedReceipt, new Date(after.getTime() + 2_000))).configurationDelivery;
  assert.equal(updated.version, 2);
  assert.equal(updated.settings.heartbeatInterval, 120);
  assert.isNull(dataOf(await admin.effectiveDevices(adminReq(ownConfigId))).data[0].deviceAppliedConfiguration);

  const rollback = await admin.createVersion({ ...adminReq(ownConfigId), body: { payload: ownSettings } });
  assert.equal(rollback.status, 201);
  assert.equal((await admin.publishVersion({ ...adminReq(ownConfigId, 3), body: {} })).status, 200);
  const restored = dataOf(await sync(a, protocol, new Date(after.getTime() + 3_000)));
  assert.equal(restored.configurationDelivery.version, 3);
  assert.deepEqual(restored.configurationDelivery.settings, ownSettings);
  const disabled = dataOf(await sync(a, receiptBody('APPLIED'), new Date(after.getTime() + 4_000), new Map()));
  assert.notProperty(disabled, 'configurationDelivery');
  assert.deepEqual(disabled.configuration, ownSettings);
  assert.equal((await read()).appliedAt?.toISOString(), after.toISOString());
});
