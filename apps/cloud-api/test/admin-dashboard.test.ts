/**
 * BE-DASH-01 管理后台总览聚合 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖（固定 10 设备 Fixture）：
 * - Contract/在线率/授权/ESG 指标可复算：有效 Contract（EFFECTIVE+EXPIRING_SOON，
 *   DRAFT/EXPIRED/TERMINATED 不计）、online（lastHeartbeatAt ≤ 10 分钟）/total/onlineRatePct、
 *   licenseStatus 分布（无状态行 → NONE）、今日 UTC 日 ESG 求和；
 * - 最新告警排序稳定：ACTIVE 限定、detectedTime 倒序 + id 决胜、固定 5 条；
 * - 无数据返回 0 而非错误：空 Customer → total/rate/ESG/Contract 全 0、告警与卡片空数组；
 * - Customer 汇总不串线：Customer actor 仅见自身 Customer 的全部指标；
 * - 卡片动作与 BE-CMD-01 权限矩阵一致：无 command:send（CustomerViewer）→ 全部
 *   FORBIDDEN；设备状态门（Maintenance/Retired/Suspended）→ DEVICE_* 原因码；
 *   动作仅描述不执行；四轴分离（lifecycle/operational/connectivity/license 独立字段）；
 * - 权限：dashboard:read 全角色（Viewer 200）；无 actor → 401。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { COMMAND_CATALOG } from '@fdp/domain';
import { createAdminDashboardHandlers } from '../src/index.js';
import type { AdminHttpRequest, DashboardDeps } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-05T12:00:00Z');
const TODAY_UTC = new Date(Date.UTC(2026, 8, 5));
const YESTERDAY_UTC = new Date(Date.UTC(2026, 8, 4));

const superAdmin: ActorContext = {
  actorId: 'sub-dash-super',
  username: 'super',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};

const viewer = (customerId: string): ActorContext => ({
  actorId: `sub-viewer-${customerId.slice(0, 8)}`,
  username: 'viewer',
  actorType: 'customer',
  roles: ['CustomerViewer'],
  customerId,
  tokenUse: 'access',
});

const customerAdmin = (customerId: string): ActorContext => ({
  ...viewer(customerId),
  roles: ['CustomerAdmin'],
});

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

const deps = (): DashboardDeps => ({ client: prisma, now: () => NOW });

const req = (actor: ActorContext | undefined): AdminHttpRequest => ({
  actor,
  headers: {},
  requestId: `req-${Math.random()}`,
});

type DataBody = { data: any; meta: Record<string, any> };

let customerAId: string;
let customerBId: string;
let customerCId: string; // 空 Customer（无数据 → 0）
const deviceIdsA: string[] = [];

async function plantDevice(
  id: string,
  customerId: string | null,
  lifecycleStatus = 'Active',
  firmware = 'FW-1.0',
): Promise<void> {
  await prisma.device.create({
    data: {
      id,
      serialNumber: `SN-${id}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus,
      customerId,
      firmwareVersion: firmware,
    },
  });
}

async function plantState(
  deviceId: string,
  customerId: string,
  options: {
    lastHeartbeatAt?: Date | null;
    operationalStatus?: string;
    licenseStatus?: string;
    firmwareVersion?: string | null;
    signalStrength?: number;
    networkType?: string;
  } = {},
): Promise<void> {
  await prisma.deviceLatestState.create({
    data: {
      deviceId,
      customerId,
      lastHeartbeatAt:
        options.lastHeartbeatAt === undefined ? new Date(NOW.getTime() - 5 * 60_000) : options.lastHeartbeatAt,
      operationalStatus: options.operationalStatus ?? 'Active',
      licenseStatus: options.licenseStatus ?? 'Active',
      firmwareVersion: options.firmwareVersion === undefined ? 'FW-1.1' : options.firmwareVersion,
      signalStrength: options.signalStrength ?? -70,
      networkType: options.networkType ?? '4G',
    },
  });
}

async function plantContract(
  customerId: string,
  name: string,
  status: string,
  startAt: Date,
  endAt: Date,
): Promise<void> {
  await prisma.contract.create({
    data: {
      contractNumber: `CT-${name}`,
      name,
      customerId,
      status,
      startAt,
      endAt,
      createdBy: 'fixture',
    },
  });
}

async function plantAlarm(
  customerId: string,
  deviceId: string,
  code: string,
  detectedTime: Date,
  status = 'ACTIVE',
): Promise<string> {
  const row = await prisma.alarm.create({
    data: { deviceId, customerId, code, category: 'PROCESS', severity: 'WARNING', status, detectedTime },
  });
  return row.id;
}

async function plantEsg(
  deviceId: string,
  customerId: string,
  summaryDate: Date,
  carbon: number,
  power: number,
  feeding: number,
): Promise<void> {
  await prisma.esgDailySummary.create({
    data: {
      deviceId,
      customerId,
      summaryDate,
      carbonReductionKg: carbon,
      powerConsumptionKwh: power,
      feedingWeightKg: feeding,
    },
  });
}

async function plantRemoteControlLicense(
  deviceId: string,
  customerId: string,
  status: string,
  options: { expired?: boolean; enabled?: boolean } = {},
): Promise<void> {
  const license = await prisma.license.create({
    data: {
      deviceId,
      customerId,
      status,
      validFrom: new Date(NOW.getTime() - 86_400_000),
      validTo: options.expired ? new Date(NOW.getTime() - 1_000) : new Date(NOW.getTime() + 86_400_000),
      createdBy: 'dashboard-fixture',
    },
  });
  await prisma.licenseEntitlement.create({
    data: { licenseId: license.id, code: 'REMOTE_CONTROL', enabled: options.enabled ?? true },
  });
}

beforeAll(async () => {
  const cA = await prisma.customer.create({ data: { name: 'DASH A' } });
  const cB = await prisma.customer.create({ data: { name: 'DASH B' } });
  const cC = await prisma.customer.create({ data: { name: 'DASH C' } });
  customerAId = cA.id;
  customerBId = cB.id;
  customerCId = cC.id;

  // ---------- Customer A：固定 10 设备 Fixture ----------
  for (let i = 1; i <= 10; i += 1) {
    const id = `dash-a-${String(i).padStart(2, '0')}`;
    deviceIdsA.push(id);
    const lifecycle = i === 9 ? 'Suspended' : i === 10 ? 'Retired' : 'Active';
    await plantDevice(id, customerAId, lifecycle, `FW-ledger-${i}`);
  }
  // A1..A4 在线（5 分钟前心跳）；A5 离线（20 分钟前）；A6..A10 无状态行
  for (let i = 1; i <= 4; i += 1) {
    await plantState(deviceIdsA[i - 1]!, customerAId, {
      licenseStatus: i === 2 ? 'Expired' : i === 4 ? 'Renewed' : 'Active',
      operationalStatus: i === 2 ? 'Maintenance' : 'Active',
    });
  }
  await plantState(deviceIdsA[4]!, customerAId, {
    lastHeartbeatAt: new Date(NOW.getTime() - 20 * 60_000),
    licenseStatus: 'ExpiringSoon',
  });
  await plantRemoteControlLicense(deviceIdsA[0]!, customerAId, 'Active');
  await plantRemoteControlLicense(deviceIdsA[1]!, customerAId, 'Active');
  await plantRemoteControlLicense(deviceIdsA[2]!, customerAId, 'Active', { expired: true });
  await plantRemoteControlLicense(deviceIdsA[3]!, customerAId, 'Revoked');
  await plantRemoteControlLicense(deviceIdsA[4]!, customerAId, 'Active', { enabled: false });

  // Contract：EFFECTIVE + EXPIRING_SOON 有效；DRAFT/EXPIRED/TERMINATED 不计
  await plantContract(
    customerAId,
    'A-EFFECTIVE',
    'EFFECTIVE',
    new Date('2026-01-01T00:00:00Z'),
    new Date('2027-01-01T00:00:00Z'),
  );
  await plantContract(
    customerAId,
    'A-EXPIRING',
    'EXPIRING_SOON',
    new Date('2026-01-01T00:00:00Z'),
    new Date('2026-09-20T00:00:00Z'),
  );
  await plantContract(
    customerAId,
    'A-DRAFT',
    'DRAFT',
    new Date('2026-01-01T00:00:00Z'),
    new Date('2027-01-01T00:00:00Z'),
  );
  await plantContract(
    customerAId,
    'A-EXPIRED',
    'EXPIRED',
    new Date('2025-01-01T00:00:00Z'),
    new Date('2026-01-01T00:00:00Z'),
  );
  await plantContract(
    customerAId,
    'A-TERMINATED',
    'TERMINATED',
    new Date('2026-01-01T00:00:00Z'),
    new Date('2027-01-01T00:00:00Z'),
  );

  // ESG 今日（UTC）：A1 + A2；昨日与他 Customer 不计
  await plantEsg(deviceIdsA[0]!, customerAId, TODAY_UTC, 1.5, 10, 100);
  await plantEsg(deviceIdsA[1]!, customerAId, TODAY_UTC, 2.5, 5, 50);
  await plantEsg(deviceIdsA[0]!, customerAId, YESTERDAY_UTC, 99, 99, 99);

  // 告警：7 条 ACTIVE（含同刻决胜）+ 1 条 ACKNOWLEDGED（排除）
  for (let i = 1; i <= 5; i += 1) {
    await plantAlarm(customerAId, deviceIdsA[0]!, `ALM-${i}`, new Date(NOW.getTime() - i * 60_000));
  }
  await plantAlarm(customerAId, deviceIdsA[1]!, 'ALM-TIE-A', new Date(NOW.getTime() - 6 * 60_000));
  await plantAlarm(customerAId, deviceIdsA[1]!, 'ALM-TIE-B', new Date(NOW.getTime() - 6 * 60_000));
  await plantAlarm(customerAId, deviceIdsA[0]!, 'ALM-ACK', NOW, 'ACKNOWLEDGED');

  // 耗材：A1 两种投影（一种未知 + stale）
  await prisma.consumableProjection.create({
    data: { deviceId: deviceIdsA[0]!, customerId: customerAId, consumableType: 'CARBON_FILTER', remainingPercent: 80 },
  });
  await prisma.consumableProjection.create({
    data: {
      deviceId: deviceIdsA[0]!,
      customerId: customerAId,
      consumableType: 'BIO_ADDITIVE',
      remainingPercent: null,
      stale: true,
    },
  });

  // ---------- Customer B：隔离对照 ----------
  await plantDevice('dash-b-01', customerBId);
  await plantState('dash-b-01', customerBId, { licenseStatus: 'Revoked' });
  await plantContract(
    customerBId,
    'B-EFFECTIVE',
    'EFFECTIVE',
    new Date('2026-01-01T00:00:00Z'),
    new Date('2027-01-01T00:00:00Z'),
  );
  await plantEsg('dash-b-01', customerBId, TODAY_UTC, 7, 70, 700);
  await plantAlarm(customerBId, 'dash-b-01', 'ALM-B', NOW);
});

describe('BE-DASH-01 总览聚合（固定 10 设备 Fixture）', () => {
  test('Customer A 指标可复算：Contract/在线率/授权分布/今日 ESG', async () => {
    const h = createAdminDashboardHandlers(deps());
    const res = await h.getOverview(req(customerAdmin(customerAId)));
    assert.equal(res.status, 200);
    const view = (res.body as DataBody).data;

    assert.equal(view.generatedAt, NOW.toISOString());
    // 有效 Contract = EFFECTIVE + EXPIRING_SOON = 2
    assert.equal(view.contracts.effectiveTotal, 2);
    // 设备：10 台；在线 4（A1..A4）；在线率 40.0
    assert.equal(view.devices.total, 10);
    assert.equal(view.devices.online, 4);
    assert.equal(view.devices.onlineRatePct, 40);
    // 授权分布：Active 2（A1,A3）+ Expired 1（A2）+ Renewed 1（A4）+ ExpiringSoon 1（A5）+ NONE 5（A6..A10）
    assert.deepEqual(view.devices.licenseDistribution, {
      Active: 2,
      Expired: 1,
      Renewed: 1,
      ExpiringSoon: 1,
      NONE: 5,
    });
    // 今日 ESG：carbon 4.0 / power 15 / feeding 150（昨日 99 不计）
    assert.equal(view.esgToday.summaryDate, '2026-09-05');
    assert.equal(Number(view.esgToday.carbonReductionKg), 4);
    assert.equal(Number(view.esgToday.powerConsumptionKwh), 15);
    assert.equal(Number(view.esgToday.feedingWeightKg), 150);
  });

  test('最新告警：ACTIVE 限定、detectedTime 倒序 + id 决胜、固定 5 条（排序稳定）', async () => {
    const h = createAdminDashboardHandlers(deps());
    const res = await h.getOverview(req(customerAdmin(customerAId)));
    const alarms = (res.body as DataBody).data.latestAlarms;
    assert.equal(alarms.length, 5);
    // 全部 ACTIVE 且属 Customer A（ACKNOWLEDGED 与 B 的告警排除）
    assert.ok(alarms.every((a: Record<string, any>) => a.status === 'ACTIVE' && a.customerId === customerAId));
    // detectedTime 严格非升序
    const times = alarms.map((a: Record<string, any>) => a.detectedTime as string);
    assert.deepEqual(times, [...times].sort().reverse());
    // 最新的 5 条应为 ALM-1..ALM-5（-1..-5 分钟；同刻 TIE 对 -6 分钟均被挤出前 5）
    assert.deepEqual(
      alarms.map((a: Record<string, any>) => a.code),
      ['ALM-1', 'ALM-2', 'ALM-3', 'ALM-4', 'ALM-5'],
    );
    // 两次查询结果一致（排序稳定）
    const again = (await h.getOverview(req(customerAdmin(customerAId)))).body as DataBody;
    assert.deepEqual(
      again.data.latestAlarms.map((a: Record<string, any>) => a.alarmId),
      alarms.map((a: Record<string, any>) => a.alarmId),
    );
  });

  test('Customer 汇总不串线：B 只见自身；平台角色为全平台口径', async () => {
    const h = createAdminDashboardHandlers(deps());
    const resB = await h.getOverview(req(customerAdmin(customerBId)));
    const viewB = (resB.body as DataBody).data;
    assert.equal(viewB.contracts.effectiveTotal, 1);
    assert.equal(viewB.devices.total, 1);
    assert.equal(viewB.devices.online, 1);
    assert.deepEqual(viewB.devices.licenseDistribution, { Revoked: 1 });
    assert.equal(Number(viewB.esgToday.carbonReductionKg), 7);
    assert.equal(viewB.latestAlarms.length, 1);
    assert.equal(viewB.latestAlarms[0].code, 'ALM-B');
    assert.equal(viewB.deviceCards.length, 1);

    // 平台角色：全平台（A 10 台 + B 1 台；Contract 2+1）
    const resP = await h.getOverview(req(superAdmin));
    const viewP = (resP.body as DataBody).data;
    assert.equal(viewP.devices.total, 11);
    assert.equal(viewP.contracts.effectiveTotal, 3);
    assert.equal(Number(viewP.esgToday.carbonReductionKg), 11);
  });

  test('无数据返回 0 而非错误：空 Customer C', async () => {
    const h = createAdminDashboardHandlers(deps());
    const res = await h.getOverview(req(customerAdmin(customerCId)));
    assert.equal(res.status, 200);
    const view = (res.body as DataBody).data;
    assert.equal(view.contracts.effectiveTotal, 0);
    assert.deepEqual(view.devices, { total: 0, online: 0, onlineRatePct: 0, licenseDistribution: {} });
    assert.equal(Number(view.esgToday.carbonReductionKg), 0);
    assert.equal(Number(view.esgToday.powerConsumptionKwh), 0);
    assert.equal(Number(view.esgToday.feedingWeightKg), 0);
    assert.deepEqual(view.latestAlarms, []);
    assert.deepEqual(view.deviceCards, []);
  });

  test('设备卡片：10 台、四轴分离、固件回退、连接质量与耗材', async () => {
    const h = createAdminDashboardHandlers(deps());
    const res = await h.getOverview(req(customerAdmin(customerAId)));
    const cards = (res.body as DataBody).data.deviceCards;
    assert.equal(cards.length, 10);
    assert.deepEqual(
      cards.map((c: Record<string, any>) => c.deviceId),
      [...deviceIdsA].sort(),
    );

    const a1 = cards[0];
    // 四轴独立字段（DEC-010 不合并）
    assert.equal(a1.lifecycleStatus, 'Active');
    assert.equal(a1.operationalStatus, 'Active');
    assert.equal(a1.connectivity, 'ONLINE');
    assert.equal(a1.licenseStatus, 'Active');
    assert.ok(!('enabled' in a1), 'DEC-010：不得派生 enabled 单字段');
    // 固件（最近上报优先）与连接质量
    assert.equal(a1.firmwareVersion, 'FW-1.1');
    assert.equal(a1.signalStrength, -70);
    assert.equal(a1.networkType, '4G');
    // 耗材：两种投影；未知剩余量为 null + stale
    assert.deepEqual(
      a1.consumables.find((c: Record<string, any>) => c.consumableType === 'CARBON_FILTER'),
      {
        consumableType: 'CARBON_FILTER',
        remainingPercent: 80,
        stale: false,
      },
    );
    assert.deepEqual(
      a1.consumables.find((c: Record<string, any>) => c.consumableType === 'BIO_ADDITIVE'),
      {
        consumableType: 'BIO_ADDITIVE',
        remainingPercent: null,
        stale: true,
      },
    );

    // A6 无状态行：OFFLINE + 固件回退台账值 + licenseStatus null
    const a6 = cards.find((c: Record<string, any>) => c.deviceId === deviceIdsA[5]);
    assert.equal(a6.connectivity, 'OFFLINE');
    assert.equal(a6.firmwareVersion, 'FW-ledger-6');
    assert.equal(a6.licenseStatus, null);
    assert.equal(a6.operationalStatus, null);
  });

  test('卡片动作与 BE-CMD-01 权限矩阵一致：状态门原因码 + Viewer 全 FORBIDDEN（仅描述不执行）', async () => {
    const h = createAdminDashboardHandlers(deps());
    const res = await h.getOverview(req(customerAdmin(customerAId)));
    const cards = (res.body as DataBody).data.deviceCards;
    const actionOf = (card: Record<string, any>, command: string) =>
      card.actions.find((a: Record<string, any>) => a.command === command);

    // 全目录 22 条动作描述
    assert.equal(cards[0].actions.length, COMMAND_CATALOG.length);
    // Active 设备：START 允许（denyReason null）
    assert.deepEqual(actionOf(cards[0], 'START'), { command: 'START', allowed: true, denyReason: null });
    // 无有效 License：过期、吊销、Entitlement disabled 均与 BE-CMD-01 一致失败关闭
    for (const index of [2, 3, 4]) {
      assert.deepEqual(actionOf(cards[index], 'START'), { command: 'START', allowed: false, denyReason: 'FORBIDDEN' });
    }
    assert.deepEqual(actionOf(cards[5], 'START'), { command: 'START', allowed: false, denyReason: 'FORBIDDEN' });
    // Maintenance（A2 operationalStatus=Maintenance）：START 拒绝 DEVICE_MAINTENANCE_RESTRICTED；STOP 放行
    const a2 = cards.find((c: Record<string, any>) => c.deviceId === deviceIdsA[1]);
    assert.deepEqual(actionOf(a2, 'START'), {
      command: 'START',
      allowed: false,
      denyReason: 'DEVICE_MAINTENANCE_RESTRICTED',
    });
    assert.equal(actionOf(a2, 'STOP').allowed, true);
    // Suspended（A9 lifecycle=Suspended）：START 拒绝 DEVICE_SUSPENDED_RESTRICTED
    const a9 = cards.find((c: Record<string, any>) => c.deviceId === deviceIdsA[8]);
    assert.equal(actionOf(a9, 'START').denyReason, 'DEVICE_SUSPENDED_RESTRICTED');
    // Retired（A10）：全部 DEVICE_RETIRED
    const a10 = cards.find((c: Record<string, any>) => c.deviceId === deviceIdsA[9]);
    assert.ok(a10.actions.every((a: Record<string, any>) => a.allowed === false && a.denyReason === 'DEVICE_RETIRED'));

    // CustomerViewer（无 command:send）：全部 FORBIDDEN；dashboard:read 仍 200
    const resV = await h.getOverview(req(viewer(customerAId)));
    assert.equal(resV.status, 200);
    const viewerCards = (resV.body as DataBody).data.deviceCards;
    assert.ok(
      viewerCards.every((c: Record<string, any>) =>
        c.actions.every((a: Record<string, any>) => a.allowed === false && a.denyReason === 'FORBIDDEN'),
      ),
    );

    // 无 actor → 401
    assert.equal((await h.getOverview(req(undefined))).status, 401);
  });
});
