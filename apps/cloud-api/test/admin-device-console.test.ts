/**
 * BE-DEV-05 设备控制台组合查询与活动导出 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 原型设备查看页字段可追溯：台账四轴（DEC-010 分字段）、五类部件状态、遥测指标
 *   （单位 + avg/min/max）、网络质量、固件、耗材投影、最近告警、Contract 摘要、
 *   近 7 日 ESG、最新 Media；
 * - 乱序遥测不倒退最新值：控制台始终读最新整点桶（插入顺序不影响）；
 * - 部分缺失返回明确空值/stale：无状态/遥测/合约/Media 设备 → 各块 null/空数组 +
 *   stale，响应不失败；离线设备 stale=true；
 * - 筛选结果与 CSV 一致：导出 Worker 与列表查询同源（级别/时间筛选、排序）；
 * - 跨 Customer 请求失败（404 不泄露存在性）；导出权限 export:create（Viewer 403）；
 *   下载 URL 过期后不可用；审计齐备（activity.export.create/download）。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminDeviceConsoleHandlers, fetchAllDeviceActivities, processActivityExportJobs } from '../src/index.js';
import type { ActivityExportDeps, AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-05T12:30:00Z');
const TODAY_UTC = new Date(Date.UTC(2026, 8, 5));

const superAdmin: ActorContext = {
  actorId: 'sub-con-super',
  username: 'super',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};

const custActor = (customerId: string, roles: ActorContext['roles'] = ['CustomerAdmin']): ActorContext => ({
  actorId: `sub-con-${customerId.slice(0, 8)}-${roles[0]}`,
  username: 'cust',
  actorType: 'customer',
  roles,
  customerId,
  tokenUse: 'access',
});

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

const storedCsv = new Map<string, string>();
const deps = (): ActivityExportDeps => ({
  client: prisma,
  now: () => NOW,
  storage: {
    async put(input) {
      storedCsv.set(input.key, input.body);
    },
  },
  urlSigner: { sign: (input) => `https://signed.local/${input.key}?exp=${input.expiresAt.toISOString()}` },
});

const req = (actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest => ({
  actor,
  headers: {},
  requestId: `req-${Math.random()}`,
  ...options,
});

type DataBody = { data: any; meta: Record<string, any> };
type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };

let customerAId: string;
let customerBId: string;
const DEV_A1 = 'con-a-01';
const DEV_A2 = 'con-a-02'; // 全无数据
const DEV_A3 = 'con-a-03'; // 离线
const DEV_B1 = 'con-b-01';

async function plantDevice(id: string, customerId: string, firmware: string): Promise<void> {
  await prisma.device.create({
    data: {
      id,
      serialNumber: `SN-${id}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId,
      firmwareVersion: firmware,
    },
  });
}

beforeAll(async () => {
  const cA = await prisma.customer.create({ data: { name: 'CON A' } });
  const cB = await prisma.customer.create({ data: { name: 'CON B' } });
  customerAId = cA.id;
  customerBId = cB.id;
  await plantDevice(DEV_A1, customerAId, 'FW-ledger-1');
  await plantDevice(DEV_A2, customerAId, 'FW-ledger-2');
  await plantDevice(DEV_A3, customerAId, 'FW-ledger-3');
  await plantDevice(DEV_B1, customerBId, 'FW-ledger-b');

  // A1 最新状态（在线，5 分钟前心跳）
  await prisma.deviceLatestState.create({
    data: {
      deviceId: DEV_A1,
      customerId: customerAId,
      connectivity: 'ONLINE',
      lastHeartbeatAt: new Date(NOW.getTime() - 5 * 60_000),
      operationalStatus: 'Active',
      licenseStatus: 'Active',
      firmwareVersion: 'FW-2.0',
      signalStrength: -65,
      networkType: '4G',
      networkStatus: 'CONNECTED',
      sensorStatus: { overall: 'NORMAL', temperature: 'WARNING', humidity: 'NORMAL', weight: 'NORMAL', gas: 'FAILED' },
    },
  });
  // A3 离线（30 分钟前心跳）
  await prisma.deviceLatestState.create({
    data: {
      deviceId: DEV_A3,
      customerId: customerAId,
      connectivity: 'ONLINE', // 存储字段不权威；派生为 OFFLINE
      lastHeartbeatAt: new Date(NOW.getTime() - 30 * 60_000),
      operationalStatus: 'Maintenance',
      licenseStatus: 'Expired',
    },
  });

  // 遥测整点桶：先插旧桶再插新桶（乱序插入不倒退最新值）
  await prisma.telemetryHourly.create({
    data: {
      deviceId: DEV_A1,
      customerId: customerAId,
      bucketStart: new Date('2026-09-05T11:00:00Z'),
      sampleCount: 6,
      metrics: { powerConsumptionKw: { avg: 9.9, min: 9, max: 10, count: 6 } },
    },
  });
  await prisma.telemetryHourly.create({
    data: {
      deviceId: DEV_A1,
      customerId: customerAId,
      bucketStart: new Date('2026-09-05T12:00:00Z'),
      sampleCount: 12,
      metrics: {
        powerConsumptionKw: { avg: 1.5, min: 1, max: 2, count: 12 },
        currentAmp: { avg: 3.2, min: 3, max: 3.5, count: 12 },
        chamberWeightKg: { avg: 42, min: 40, max: 45, count: 12 },
        heatTemperatureC: { avg: 65, min: 60, max: 70, count: 12 },
        o2Pct: { avg: 20.5, min: 20, max: 21, count: 12 },
      },
    },
  });

  // 耗材投影
  await prisma.consumableProjection.create({
    data: {
      deviceId: DEV_A1,
      customerId: customerAId,
      consumableType: 'CARBON_FILTER',
      remainingPercent: 60,
      observedAt: new Date(NOW.getTime() - 60 * 60_000),
    },
  });

  // 告警 6 条（控制台取最新 5）；含 1 条 CRITICAL 供活动级别筛选
  for (let i = 1; i <= 6; i += 1) {
    await prisma.alarm.create({
      data: {
        deviceId: DEV_A1,
        customerId: customerAId,
        code: `ALM-C${i}`,
        category: 'PROCESS',
        severity: i === 1 ? 'CRITICAL' : 'WARNING',
        status: 'ACTIVE',
        message: `告警 ${i}`,
        detectedTime: new Date(NOW.getTime() - i * 60_000),
      },
    });
  }
  // 同刻决胜两条
  await prisma.alarm.create({
    data: {
      deviceId: DEV_A1,
      customerId: customerAId,
      code: 'ALM-TIE-1',
      category: 'PROCESS',
      severity: 'INFO',
      detectedTime: new Date(NOW.getTime() - 10 * 60_000),
    },
  });

  // 活动事件（含 CSV 转义字符）
  const eventRows = [
    { type: 'FILTER_REPLACED', at: 2, remarks: '更换, "碳滤" 完成' },
    { type: 'USER_LOGIN', at: 4, remarks: null },
    { type: 'CONFIG_APPLIED', at: 8, remarks: 'v3' },
  ];
  for (const [i, e] of eventRows.entries()) {
    await prisma.deviceEvent.create({
      data: {
        deviceId: DEV_A1,
        customerId: customerAId,
        eventType: e.type,
        source: 'REMOTE',
        userId: 'u-1',
        username: 'operator',
        remarks: e.remarks,
        occurredAt: new Date(NOW.getTime() - e.at * 60_000),
        sourceMessageId: `EVT-A1-${i}`,
      },
    });
  }

  // 合约关联
  const contract = await prisma.contract.create({
    data: {
      contractNumber: 'CT-CON-A',
      name: 'A 合约',
      customerId: customerAId,
      status: 'EFFECTIVE',
      startAt: new Date('2026-01-01T00:00:00Z'),
      endAt: new Date('2027-01-01T00:00:00Z'),
      createdBy: 'fixture',
    },
  });
  await prisma.contractDevice.create({
    data: {
      contractId: contract.id,
      deviceId: DEV_A1,
      customerId: customerAId,
      validFrom: new Date('2026-01-01T00:00:00Z'),
    },
  });

  // ESG：today-1 与 today-5 有行，其余日槽空
  const day1 = new Date(TODAY_UTC.getTime() - 1 * 86400_000);
  const day5 = new Date(TODAY_UTC.getTime() - 5 * 86400_000);
  await prisma.esgDailySummary.create({
    data: {
      deviceId: DEV_A1,
      customerId: customerAId,
      summaryDate: day1,
      carbonReductionKg: 1.5,
      powerConsumptionKwh: 10,
      feedingWeightKg: 100,
    },
  });
  await prisma.esgDailySummary.create({
    data: {
      deviceId: DEV_A1,
      customerId: customerAId,
      summaryDate: day5,
      carbonReductionKg: 2.5,
      powerConsumptionKwh: 20,
      feedingWeightKg: 200,
    },
  });

  // Media：两张 + 一张更新的 DELETED（排除）
  await prisma.mediaObject.create({
    data: {
      id: 'med-a1-old',
      deviceId: DEV_A1,
      customerId: customerAId,
      mediaType: 'IMAGE',
      objectPath: 'media/a1/old.jpg',
      fileName: 'old.jpg',
      sha256: 'd'.repeat(64),
      sizeKb: 100,
      captureTime: new Date(NOW.getTime() - 3 * 60 * 60_000),
    },
  });
  await prisma.mediaObject.create({
    data: {
      id: 'med-a1-deleted',
      deviceId: DEV_A1,
      customerId: customerAId,
      mediaType: 'IMAGE',
      objectPath: 'media/a1/deleted.jpg',
      fileName: 'deleted.jpg',
      sha256: 'e'.repeat(64),
      sizeKb: 100,
      captureTime: new Date(NOW.getTime() - 30 * 60_000),
      status: 'DELETED',
    },
  });
  await prisma.mediaObject.create({
    data: {
      id: 'med-a1-new',
      deviceId: DEV_A1,
      customerId: customerAId,
      mediaType: 'VIDEO',
      objectPath: 'media/a1/new.mp4',
      fileName: 'new.mp4',
      sha256: 'f'.repeat(64),
      sizeKb: 500,
      captureTime: new Date(NOW.getTime() - 60 * 60_000),
    },
  });
});

describe('BE-DEV-05 控制台组合查询', () => {
  test('全部数据块可追溯：四轴/部件/遥测/网络/固件/耗材/告警/合约/近7日ESG/最新Media', async () => {
    const h = createAdminDeviceConsoleHandlers(deps());
    const res = await h.getDeviceConsole(req(custActor(customerAId), { params: { deviceId: DEV_A1 } }));
    assert.equal(res.status, 200);
    const view = (res.body as DataBody).data;

    // 四轴分离 + 固件（上报优先）
    assert.equal(view.device.lifecycleStatus, 'Active');
    assert.equal(view.device.operationalStatus, 'Active');
    assert.equal(view.device.connectivity, 'ONLINE');
    assert.equal(view.device.licenseStatus, 'Active');
    assert.equal(view.device.firmwareVersion, 'FW-2.0');
    assert.ok(!('enabled' in view.device));

    // 部件状态（五键 + observedAt/stale）
    assert.equal(view.components.stale, false);
    assert.equal(view.components.observedAt, new Date(NOW.getTime() - 5 * 60_000).toISOString());
    assert.deepEqual(view.components.status, {
      overall: 'NORMAL',
      temperature: 'WARNING',
      humidity: 'NORMAL',
      weight: 'NORMAL',
      gas: 'FAILED',
    });

    // 遥测：最新 12:00 桶（乱序插入不倒退；旧桶 9.9 不出现）+ 单位
    assert.equal(view.metrics.observedAt, '2026-09-05T12:00:00.000Z');
    assert.equal(view.metrics.stale, false);
    assert.deepEqual(view.metrics.metrics.powerConsumptionKw, { avg: 1.5, min: 1, max: 2, unit: 'kW' });
    assert.deepEqual(view.metrics.metrics.currentAmp, { avg: 3.2, min: 3, max: 3.5, unit: 'A' });
    assert.equal(view.metrics.metrics.chamberWeightKg.avg, 42);
    assert.equal(view.metrics.metrics.co2Ppm, null); // 未上报指标明确空值

    // 网络质量
    assert.equal(view.network.signalStrength, -65);
    assert.equal(view.network.networkType, '4G');
    assert.equal(view.network.stale, false);

    // 耗材投影
    assert.deepEqual(view.consumables, [
      {
        consumableType: 'CARBON_FILTER',
        remainingPercent: 60,
        stale: false,
        observedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      },
    ]);

    // 最近告警：5 条、detectedTime 倒序
    assert.equal(view.recentAlarms.length, 5);
    assert.deepEqual(
      view.recentAlarms.map((a: Record<string, any>) => a.code),
      ['ALM-C1', 'ALM-C2', 'ALM-C3', 'ALM-C4', 'ALM-C5'],
    );
    assert.equal(view.recentAlarms[0].severity, 'CRITICAL');

    // Contract 摘要
    assert.equal(view.contract.contractNumber, 'CT-CON-A');
    assert.equal(view.contract.status, 'EFFECTIVE');

    // 近 7 日 ESG：7 个固定日槽，升序，缺失日为 null
    assert.equal(view.esgLast7Days.length, 7);
    assert.equal(view.esgLast7Days[0].summaryDate, '2026-08-30');
    assert.equal(view.esgLast7Days[6].summaryDate, '2026-09-05');
    const d1 = view.esgLast7Days[5];
    assert.equal(d1.carbonReductionKg, 1.5);
    const d5 = view.esgLast7Days[1];
    assert.equal(d5.feedingWeightKg, 200);
    assert.equal(view.esgLast7Days[6].carbonReductionKg, null); // 今日无聚合 → null

    // 最新 Media（DELETED 排除，取 captureTime 最新非删除）
    assert.deepEqual(view.latestMedia, {
      mediaId: 'med-a1-new',
      mediaType: 'VIDEO',
      captureTime: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    });
  });

  test('部分缺失返回明确空值/stale，响应不失败；离线设备 stale=true；固件回退台账', async () => {
    const h = createAdminDeviceConsoleHandlers(deps());
    // A2：无任何运行时数据
    const res2 = await h.getDeviceConsole(req(custActor(customerAId), { params: { deviceId: DEV_A2 } }));
    assert.equal(res2.status, 200);
    const v2 = (res2.body as DataBody).data;
    assert.equal(v2.device.connectivity, 'OFFLINE');
    assert.equal(v2.device.operationalStatus, null);
    assert.equal(v2.device.licenseStatus, null);
    assert.equal(v2.device.firmwareVersion, 'FW-ledger-2'); // 回退台账
    assert.deepEqual(v2.components, {
      observedAt: null,
      stale: true,
      status: { overall: null, temperature: null, humidity: null, weight: null, gas: null },
    });
    assert.equal(v2.metrics.observedAt, null);
    assert.equal(v2.metrics.stale, true);
    assert.ok(Object.values(v2.metrics.metrics).every((m: unknown) => m === null));
    assert.deepEqual(v2.network, {
      observedAt: null,
      stale: true,
      signalStrength: null,
      networkType: null,
      networkStatus: null,
    });
    assert.deepEqual(v2.consumables, []);
    assert.deepEqual(v2.recentAlarms, []);
    assert.equal(v2.contract, null);
    assert.ok(v2.esgLast7Days.every((d: Record<string, any>) => d.carbonReductionKg === null));
    assert.equal(v2.latestMedia, null);

    // A3：离线（心跳 30 分钟前）→ stale，四轴各自独立
    const res3 = await h.getDeviceConsole(req(superAdmin, { params: { deviceId: DEV_A3 } }));
    const v3 = (res3.body as DataBody).data;
    assert.equal(v3.device.connectivity, 'OFFLINE'); // 派生口径，不读存储字段
    assert.equal(v3.device.operationalStatus, 'Maintenance');
    assert.equal(v3.device.licenseStatus, 'Expired');
    assert.equal(v3.components.stale, true);
  });

  test('跨 Customer 请求失败（404）；无 actor → 401；不存在设备 → 404', async () => {
    const h = createAdminDeviceConsoleHandlers(deps());
    assert.equal((await h.getDeviceConsole(req(custActor(customerBId), { params: { deviceId: DEV_A1 } }))).status, 404);
    assert.equal((await h.getDeviceConsole(req(custActor(customerAId), { params: { deviceId: DEV_B1 } }))).status, 404);
    assert.equal(
      (await h.getDeviceConsole(req(custActor(customerAId), { params: { deviceId: 'ghost' } }))).status,
      404,
    );
    assert.equal((await h.getDeviceConsole(req(undefined, { params: { deviceId: DEV_A1 } }))).status, 401);
  });
});

describe('BE-DEV-05 活动日志筛选', () => {
  test('级别/类型/时间筛选；EVENT 固定 INFO；排序稳定（倒序 + 同刻决胜）+ 分页不丢不重', async () => {
    const h = createAdminDeviceConsoleHandlers(deps());
    // 全量：3 事件 + 7 告警 = 10
    const all = (
      await h.listDeviceActivities(
        req(custActor(customerAId), { params: { deviceId: DEV_A1 }, query: { limit: '50' } }),
      )
    ).body as ListBody;
    assert.equal(all.data.length, 10);
    const times = all.data.map((a) => a.occurredAt as string);
    assert.deepEqual(times, [...times].sort().reverse());
    // EVENT 固定 INFO
    assert.ok(all.data.filter((a) => a.kind === 'EVENT').every((a) => a.level === 'INFO'));
    assert.equal(all.data.find((a) => a.kind === 'EVENT')?.detail.remarks !== undefined, true);

    // level=CRITICAL → 仅 CRITICAL 告警
    const critical = (
      await h.listDeviceActivities(
        req(custActor(customerAId), { params: { deviceId: DEV_A1 }, query: { level: 'CRITICAL' } }),
      )
    ).body as ListBody;
    assert.equal(critical.data.length, 1);
    assert.equal(critical.data[0]?.summary, 'ALM-C1');

    // kind=EVENT → 仅事件
    const events = (
      await h.listDeviceActivities(
        req(custActor(customerAId), { params: { deviceId: DEV_A1 }, query: { kind: 'EVENT' } }),
      )
    ).body as ListBody;
    assert.equal(events.data.length, 3);
    assert.ok(events.data.every((a) => a.kind === 'EVENT'));

    // level=INFO → EVENT（INFO）+ INFO 告警（ALM-TIE-1）
    const info = (
      await h.listDeviceActivities(
        req(custActor(customerAId), { params: { deviceId: DEV_A1 }, query: { level: 'INFO' } }),
      )
    ).body as ListBody;
    assert.equal(info.data.length, 4);

    // 时间范围：from 含端点
    const ranged = (
      await h.listDeviceActivities(
        req(custActor(customerAId), {
          params: { deviceId: DEV_A1 },
          query: { from: new Date(NOW.getTime() - 3 * 60_000).toISOString(), to: NOW.toISOString() },
        }),
      )
    ).body as ListBody;
    assert.ok(ranged.data.every((a) => a.occurredAt >= new Date(NOW.getTime() - 3 * 60_000).toISOString()));
    assert.ok(ranged.data.some((a) => a.summary === 'ALM-C1'));

    // 非法筛选 → 400
    assert.equal(
      (
        await h.listDeviceActivities(
          req(custActor(customerAId), { params: { deviceId: DEV_A1 }, query: { level: 'P0' } }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.listDeviceActivities(
          req(custActor(customerAId), { params: { deviceId: DEV_A1 }, query: { from: 'bad' } }),
        )
      ).status,
      400,
    );

    // 分页：limit=3 翻页与全量一致（含同刻决胜）
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await h.listDeviceActivities(
        req(custActor(customerAId), {
          params: { deviceId: DEV_A1 },
          query: { limit: '3', ...(cursor ? { cursor } : {}) },
        }),
      );
      const body = res.body as ListBody;
      seen.push(...body.data.map((a) => a.activityId as string));
      cursor = body.meta.nextCursor ?? undefined;
      if (!cursor) break;
    }
    assert.deepEqual(
      seen,
      all.data.map((a) => a.activityId),
    );

    // 跨 Customer → 404
    assert.equal(
      (await h.listDeviceActivities(req(custActor(customerBId), { params: { deviceId: DEV_A1 }, query: {} }))).status,
      404,
    );
  });
});

describe('BE-DEV-05 活动导出（异步 Worker）', () => {
  test('创建 202 入队 + 审计；Worker 完成后 CSV 与筛选结果一致；URL 过期语义；权限与隔离', async () => {
    const h = createAdminDeviceConsoleHandlers(deps());
    // Viewer 无 export:create
    assert.equal(
      (
        await h.createActivityExport(
          req(custActor(customerAId, ['CustomerViewer']), { params: { deviceId: DEV_A1 }, body: {} }),
        )
      ).status,
      403,
    );
    // 非法筛选 → 400（入队前拒绝）
    assert.equal(
      (
        await h.createActivityExport(
          req(custActor(customerAId), { params: { deviceId: DEV_A1 }, body: { level: 'P0' } }),
        )
      ).status,
      400,
    );

    // 创建（CustomerAdmin，冻结筛选 level=WARNING）
    const created = await h.createActivityExport(
      req(custActor(customerAId), { params: { deviceId: DEV_A1 }, body: { level: 'WARNING' } }),
    );
    assert.equal(created.status, 202);
    const job = (created.body as DataBody).data;
    assert.equal(job.status, 'PENDING');
    assert.deepEqual(job.filters, { level: 'WARNING' });

    // Worker 处理
    const result = await processActivityExportJobs(deps());
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);

    // 详情：COMPLETED + 短期 URL；Customer A 可读
    const detail = await h.getActivityExport(req(custActor(customerAId), { params: { exportId: job.exportId } }));
    const done = (detail.body as DataBody).data;
    assert.equal(done.status, 'COMPLETED');
    assert.ok(done.downloadUrl?.startsWith('https://signed.local/activity-exports/'));
    assert.equal(done.urlExpired, false);

    // CSV 与筛选结果一致（同源查询）
    const expected = await fetchAllDeviceActivities(deps(), DEV_A1, { level: 'WARNING' });
    assert.equal(done.rowCount, expected.length);
    const csv = storedCsv.get(`activity-exports/${job.exportId}.csv`)!;
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(
      lines[0],
      'activityId,kind,level,occurredAt,summary,eventType,source,userId,username,remarks,code,status,message,currentValue,threshold,unit',
    );
    assert.equal(lines.length - 1, expected.length);
    // 行序与查询一致（occurredAt 倒序）
    assert.deepEqual(
      lines.slice(1).map((line) => line.split(',')[0]),
      expected.map((item) => item.activityId),
    );
    // 全部 WARNING（筛选一致）
    assert.ok(lines.slice(1).every((line) => line.split(',')[2] === 'WARNING'));

    // CSV 转义：另建全量导出验证 remarks 引号转义
    const full = await h.createActivityExport(req(custActor(customerAId), { params: { deviceId: DEV_A1 }, body: {} }));
    const fullJob = (full.body as DataBody).data;
    await processActivityExportJobs(deps());
    const fullCsv = storedCsv.get(`activity-exports/${fullJob.exportId}.csv`)!;
    assert.ok(fullCsv.includes('"更换, ""碳滤"" 完成"'), 'CSV 必须 RFC 4180 转义');

    // 审计齐备
    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'activity_export', objectId: { in: [DEV_A1, job.exportId] } },
    });
    const actions = audits.map((a) => a.action).sort();
    assert.ok(actions.includes('activity.export.create'));
    assert.ok(actions.includes('activity.export.download'));

    // 跨 Customer 详情 → 404
    assert.equal(
      (await h.getActivityExport(req(custActor(customerBId), { params: { exportId: job.exportId } }))).status,
      404,
    );
  });

  test('下载 URL 过期后不可用（urlExpired=true，downloadUrl=null）', async () => {
    const h = createAdminDeviceConsoleHandlers(deps());
    const created = await h.createActivityExport(
      req(custActor(customerAId), { params: { deviceId: DEV_A1 }, body: {} }),
    );
    const job = (created.body as DataBody).data;
    await processActivityExportJobs(deps());
    // 过期视角（now 超过 urlExpiresAt）
    const expiredDeps: ActivityExportDeps = { ...deps(), now: () => new Date(NOW.getTime() + 16 * 60_000) };
    const h2 = createAdminDeviceConsoleHandlers(expiredDeps);
    const detail = await h2.getActivityExport(req(custActor(customerAId), { params: { exportId: job.exportId } }));
    const view = (detail.body as DataBody).data;
    assert.equal(view.downloadUrl, null);
    assert.equal(view.urlExpired, true);
  });

  test('Worker 失败路径：存储异常 → FAILED + error（不丢任务记录）', async () => {
    const h = createAdminDeviceConsoleHandlers(deps());
    const created = await h.createActivityExport(
      req(custActor(customerAId), { params: { deviceId: DEV_A2 }, body: {} }),
    );
    const job = (created.body as DataBody).data;
    const failingDeps: ActivityExportDeps = {
      ...deps(),
      storage: {
        async put() {
          throw new Error('storage unavailable');
        },
      },
    };
    const result = await processActivityExportJobs(failingDeps);
    assert.equal(result.failed, 1);
    const detail = await h.getActivityExport(req(custActor(customerAId), { params: { exportId: job.exportId } }));
    const view = (detail.body as DataBody).data;
    assert.equal(view.status, 'FAILED');
    assert.equal(view.error, 'storage unavailable');
  });

  test('Worker 回收租约已过期的 PROCESSING 任务，但不抢占有效租约', async () => {
    const h = createAdminDeviceConsoleHandlers(deps());
    const expired = (
      await h.createActivityExport(req(custActor(customerAId), { params: { deviceId: DEV_A1 }, body: {} }))
    ).body as DataBody;
    const active = (
      await h.createActivityExport(req(custActor(customerAId), { params: { deviceId: DEV_A2 }, body: {} }))
    ).body as DataBody;
    await prisma.activityExportJob.update({
      where: { id: expired.data.exportId },
      data: {
        status: 'PROCESSING',
        claimedAt: new Date(NOW.getTime() - 10 * 60_000),
        leaseUntil: new Date(NOW.getTime() - 60_000),
      },
    });
    await prisma.activityExportJob.update({
      where: { id: active.data.exportId },
      data: {
        status: 'PROCESSING',
        claimedAt: NOW,
        leaseUntil: new Date(NOW.getTime() + 5 * 60_000),
      },
    });

    const result = await processActivityExportJobs(deps(), { leaseSeconds: 300 });
    assert.deepEqual(result, { processed: 1, completed: 1, failed: 0 });
    const [recovered, untouched] = await Promise.all([
      prisma.activityExportJob.findUniqueOrThrow({ where: { id: expired.data.exportId } }),
      prisma.activityExportJob.findUniqueOrThrow({ where: { id: active.data.exportId } }),
    ]);
    assert.equal(recovered.status, 'COMPLETED');
    assert.equal(recovered.attemptCount, 1);
    assert.equal(recovered.leaseUntil, null);
    assert.equal(recovered.leaseToken, null);
    assert.equal(untouched.status, 'PROCESSING');
    assert.equal(untouched.attemptCount, 0);
  });
});
