/**
 * BE-ESG-02 ESG 查询与 CSV 导出 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 最近聚合窗口/小时/日汇总/设备 Report/完整率/计算版本查询；
 * - 按 Customer/Site/Device/日期过滤；键集游标分页；
 * - 过滤结果和 CSV 行数一致（导出与查询同源 where）；
 * - Customer 隔离通过（列表强制 scope；导出详情跨 Customer → 404）；
 * - 下载 URL 过期后不可用（urlExpired=true 且不返回 URL）；
 * - 导出有审计（esg.export.create + esg.export.download）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  ADMIN_ESG_ERROR_HTTP_STATUS,
  ESG_CSV_SCHEMAS,
  createAdminEsgHandlers,
  processEsgExportJob,
} from '../src/index.js';
import type { AdminEsgHandlerDeps, AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-30T14:00:00Z');
const DAY_MS = 86_400_000;
const URL_TTL = 900;

const superAdmin: ActorContext = {
  actorId: 'admin-1',
  username: 'admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};
const auditor: ActorContext = { ...superAdmin, actorId: 'au-1', roles: ['Auditor'] };
const operator: ActorContext = { ...superAdmin, actorId: 'op-1', roles: ['PlatformOperator'] };

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

/** 注入式存储/签名端口夹具（部署层接 S3；URL 内嵌过期时点供测试断言）。 */
function fakePorts() {
  const stored = new Map<string, string>();
  return {
    stored,
    storage: {
      async put(input: { key: string; body: string; contentType: string }) {
        stored.set(input.key, input.body);
      },
    },
    urlSigner: {
      sign(input: { key: string; expiresAt: Date }) {
        return `https://exports.test/${input.key}?expires=${input.expiresAt.toISOString()}`;
      },
    },
  };
}

function handlers(at: Date = NOW, ports = fakePorts()) {
  const deps: AdminEsgHandlerDeps = {
    client: prisma,
    now: () => at,
    storage: ports.storage,
    urlSigner: ports.urlSigner,
    urlTtlSeconds: URL_TTL,
  };
  return { h: createAdminEsgHandlers(deps), deps, ports };
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

type DataBody = { data: Record<string, any>; meta: Record<string, any> };
type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };

let seq = 0;

async function plantTenant(name: string) {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `${name} ${seq}` } });
  const site = await prisma.site.create({ data: { customerId: customer.id, name: `Site ${name} ${seq}` } });
  const deviceId = `dev-esg-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-ESG-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
      siteId: site.id,
    },
  });
  const customerAdmin: ActorContext = {
    actorId: `ca-${seq}`,
    username: `ca-${seq}`,
    actorType: 'customer',
    roles: ['CustomerAdmin'],
    customerId: customer.id,
    tokenUse: 'access',
  };
  const customerViewer: ActorContext = { ...customerAdmin, actorId: `cv-${seq}`, roles: ['CustomerViewer'] };
  return { customerId: customer.id, siteId: site.id, deviceId, customerAdmin, customerViewer };
}

async function plantCalcVersion() {
  return prisma.esgCalculationVersion.create({
    data: {
      version: `aggregator@1.0.${seq}`,
      description: 'BE-ESG-01 聚合计算方法',
      formula: { completeness: 'received/(max-min+1)' },
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      status: 'ACTIVE',
    },
  });
}

async function plantSummary(
  tenant: { customerId: string; deviceId: string },
  dayOffset: number,
  versionId: string,
  feeding: number,
) {
  return prisma.esgDailySummary.create({
    data: {
      deviceId: tenant.deviceId,
      customerId: tenant.customerId,
      summaryDate: new Date(Date.UTC(2026, 7, 1) + dayOffset * DAY_MS),
      feedingWeightKg: feeding,
      dischargeWeightKg: feeding - 2,
      reductionWeightKg: 2,
      powerConsumptionKwh: 30,
      carbonReductionKg: 14,
      dataCompletenessPct: 85,
      missingRecordCount: 1,
      calculationVersionId: versionId,
    },
  });
}

async function plantHourly(tenant: { customerId: string; deviceId: string }, hourOffset: number) {
  return prisma.telemetryHourly.create({
    data: {
      deviceId: tenant.deviceId,
      customerId: tenant.customerId,
      bucketStart: new Date(Date.UTC(2026, 7, 20, hourOffset)),
      sampleCount: 12,
      completenessPct: 75.5,
      metrics: { chamberTempC: { avg: 56, min: 40, max: 62, count: 12 } },
    },
  });
}

async function plantReport(tenant: { customerId: string; deviceId: string }, reportType: string, versionId: string) {
  seq += 1;
  return prisma.esgReport.create({
    data: {
      deviceId: tenant.deviceId,
      customerId: tenant.customerId,
      reportType,
      periodStartTime: new Date(Date.UTC(2026, 7, 25, seq % 24)),
      periodEndTime: new Date(Date.UTC(2026, 7, 25, (seq % 24) + 1)),
      feedingWeightKg: 10,
      powerConsumptionKwh: 5,
      carbonReductionKg: 3,
      dataCompletenessPct: 90,
      calculationVersionId: versionId,
    },
  });
}

describe('ESG 查询', () => {
  test('overview：最近聚合窗口 + ACTIVE 计算版本', async () => {
    const tenant = await plantTenant('ESG-OV');
    const version = await plantCalcVersion();
    await plantHourly(tenant, 10);
    await plantHourly(tenant, 12);
    await plantSummary(tenant, 3, version.id, 10);

    const { h } = handlers();
    const res = await h.overview(req(tenant.customerViewer, {}));
    assert.equal(res.status, 200);
    const data = (res.body as DataBody).data;
    assert.equal(data.latestHourlyBucketStart, new Date(Date.UTC(2026, 7, 20, 12)).toISOString());
    assert.equal(data.latestEsgSummaryDate, new Date(Date.UTC(2026, 7, 4)).toISOString());
    assert.equal(data.activeCalculationVersion.status, 'ACTIVE');
  });

  test('小时/日汇总/Report/日汇总筛选（device/site/日期/reportType）+ 游标分页', async () => {
    const tenant = await plantTenant('ESG-Q');
    const other = await plantTenant('ESG-QB');
    const version = await plantCalcVersion();
    await plantHourly(tenant, 1);
    await plantHourly(tenant, 2);
    await plantHourly(other, 3);
    await plantSummary(tenant, 10, version.id, 20);
    await plantSummary(other, 10, version.id, 99);
    await plantReport(tenant, 'DAILY', version.id);
    await plantReport(tenant, 'CYCLE', version.id);
    await plantReport(other, 'DAILY', version.id);

    const { h } = handlers();
    // 小时汇总：customerId 筛选
    const hourly = (await h.listHourly(req(superAdmin, { query: { customerId: tenant.customerId } }))).body as ListBody;
    assert.equal(hourly.data.length, 2);
    assert.equal(hourly.data[0].completenessPct, 75.5);
    assert.equal(hourly.data[0].metrics.chamberTempC.avg, 56);
    // site 筛选
    const bySite = (await h.listHourly(req(superAdmin, { query: { siteId: tenant.siteId } }))).body as ListBody;
    assert.equal(bySite.data.length, 2);
    // 日期范围
    const ranged = (
      await h.listHourly(req(superAdmin, { query: { from: '2026-08-20T02:00:00Z', to: '2026-08-20T02:59:59Z' } }))
    ).body as ListBody;
    assert.equal(ranged.data.length, 1);
    assert.equal(ranged.data[0].bucketStart, new Date(Date.UTC(2026, 7, 20, 2)).toISOString());

    // Report：reportType 筛选
    const dailyReports = (
      await h.listReports(req(superAdmin, { query: { customerId: tenant.customerId, reportType: 'DAILY' } }))
    ).body as ListBody;
    assert.equal(dailyReports.data.length, 1);
    assert.equal(dailyReports.data[0].reportType, 'DAILY');
    assert.equal(dailyReports.data[0].dataCompletenessPct, 90);
    const badType = await h.listReports(req(superAdmin, { query: { reportType: 'WEEKLY' } }));
    assert.equal(badType.status, 400);

    // 日汇总：完整率与计算版本引用
    const summary = (await h.listDailySummary(req(superAdmin, { query: { customerId: tenant.customerId } })))
      .body as ListBody;
    assert.equal(summary.data.length, 1);
    assert.equal(summary.data[0].dataCompletenessPct, 85);
    assert.equal(summary.data[0].calculationVersionId, version.id);

    // 游标分页
    const p1 = (await h.listHourly(req(superAdmin, { query: { customerId: tenant.customerId, limit: '1' } })))
      .body as ListBody;
    assert.equal(p1.data.length, 1);
    const p2 = (
      await h.listHourly(
        req(superAdmin, { query: { customerId: tenant.customerId, limit: '1', cursor: p1.meta.nextCursor } }),
      )
    ).body as ListBody;
    assert.equal(p2.data.length, 1);
    assert.notEqual(p1.data[0].bucketStart, p2.data[0].bucketStart);
    assert.equal(p2.meta.nextCursor, null);
  });

  test('Customer 隔离：列表仅本 Customer；计算版本全局可读', async () => {
    const tenant = await plantTenant('ESG-ISO');
    const other = await plantTenant('ESG-ISOB');
    const version = await plantCalcVersion();
    await plantSummary(tenant, 20, version.id, 10);
    await plantSummary(other, 20, version.id, 88);

    const { h } = handlers();
    const own = (await h.listDailySummary(req(tenant.customerViewer, { query: { customerId: other.customerId } })))
      .body as ListBody;
    assert.ok(
      own.data.every((r) => r.customerId === tenant.customerId),
      '显式跨 Customer 参数被强制覆盖',
    );
    assert.ok(own.data.some((r) => r.feedingWeightKg === 10));

    const versions = (await h.listCalculationVersions(req(tenant.customerViewer, {}))).body as ListBody;
    assert.ok(versions.data.length >= 1);
    assert.ok(versions.data.every((v) => typeof v.version === 'string'));
  });
});

describe('CSV 导出', () => {
  test('异步导出：202 入队 → Worker 生成 → 短期 URL；过滤结果与 CSV 行数一致；审计齐备', async () => {
    const tenant = await plantTenant('ESG-EXP');
    const version = await plantCalcVersion();
    await plantSummary(tenant, 30, version.id, 11);
    await plantSummary(tenant, 31, version.id, 22);

    const { h, deps, ports } = handlers();
    // 创建（export:create；CustomerViewer 无权限 → 403）
    const denied = await h.createExport(req(tenant.customerViewer, { body: { dataset: 'DAILY_SUMMARY' } }));
    assert.equal(denied.status, 403);
    const badDataset = await h.createExport(req(tenant.customerAdmin, { body: { dataset: 'RAW' } }));
    assert.equal(badDataset.status, 400);

    const created = await h.createExport(req(tenant.customerAdmin, { body: { dataset: 'DAILY_SUMMARY' } }));
    assert.equal(created.status, 202);
    const job = (created.body as DataBody).data;
    assert.equal(job.status, 'PENDING');
    assert.equal(job.downloadUrl, null);
    // Customer 角色导出快照强制本 Customer
    assert.equal((job.filters as Record<string, unknown>).customerId, tenant.customerId);

    // Worker 处理
    const done = await processEsgExportJob(deps, job.exportId);
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.rowCount, 2);

    // CSV 行数与查询结果一致（同源 where）
    const list = (await h.listDailySummary(req(tenant.customerAdmin, {}))).body as ListBody;
    const csv = ports.stored.get(`esg-exports/${job.exportId}.csv`);
    assert.ok(csv);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], ESG_CSV_SCHEMAS.DAILY_SUMMARY.join(','), 'CSV 表头与封闭 Schema 一致');
    assert.equal(lines.length - 1, list.data.length, '过滤结果和 CSV 行数一致');

    // 详情返回短期 URL + 审计
    const detail = await h.exportDetail(req(tenant.customerAdmin, { params: { exportId: job.exportId } }));
    const detailData = (detail.body as DataBody).data;
    assert.ok(detailData.downloadUrl.includes(`expires=${new Date(NOW.getTime() + URL_TTL * 1000).toISOString()}`));
    assert.equal(detailData.urlExpired, false);

    const creates = await prisma.auditLog.count({ where: { objectType: 'esg_export', action: 'esg.export.create' } });
    const downloads = await prisma.auditLog.count({ where: { objectId: job.exportId, action: 'esg.export.download' } });
    assert.ok(creates >= 1, '导出创建有审计');
    assert.ok(downloads >= 1, '下载 URL 签发有审计');
  });

  test('下载 URL 过期后不可用；跨 Customer 详情 404', async () => {
    const tenant = await plantTenant('ESG-EXP2');
    const other = await plantTenant('ESG-EXP2B');
    const version = await plantCalcVersion();
    await plantSummary(tenant, 40, version.id, 5);

    const { h, deps } = handlers();
    const created = await h.createExport(req(tenant.customerAdmin, { body: { dataset: 'DAILY_SUMMARY' } }));
    const exportId = (created.body as DataBody).data.exportId;
    await processEsgExportJob(deps, exportId);

    // 时间前进到过期后：新 handler 的 now 晚于 urlExpiresAt
    const expiredAt = new Date(NOW.getTime() + (URL_TTL + 60) * 1000);
    const { h: hLater } = handlers(expiredAt);
    const expired = await hLater.exportDetail(req(tenant.customerAdmin, { params: { exportId } }));
    const data = (expired.body as DataBody).data;
    assert.equal(data.downloadUrl, null, '过期后不返回 URL');
    assert.equal(data.urlExpired, true);

    // 过期读取不产生下载审计
    const downloads = await prisma.auditLog.count({ where: { objectId: exportId, action: 'esg.export.download' } });
    assert.equal(downloads, 0);

    // 跨 Customer → 404
    const cross = await h.exportDetail(req(other.customerAdmin, { params: { exportId } }));
    assert.equal(cross.status, 404);

    // Auditor（平台角色）可读
    const byAuditor = await h.exportDetail(req(auditor, { params: { exportId } }));
    assert.equal(byAuditor.status, 200);
  });

  test('平台角色按 customerId 导出；Operator 无 export:create → 403', async () => {
    const tenant = await plantTenant('ESG-EXP3');
    const version = await plantCalcVersion();
    await plantSummary(tenant, 50, version.id, 7);

    const { h, deps, ports } = handlers();
    const denied = await h.createExport(req(operator, { body: { dataset: 'DAILY_SUMMARY' } }));
    assert.equal(denied.status, 403, 'PlatformOperator 无 export:create');

    const created = await h.createExport(
      req(auditor, { body: { dataset: 'DAILY_SUMMARY', customerId: tenant.customerId } }),
    );
    assert.equal(created.status, 202);
    const exportId = (created.body as DataBody).data.exportId;
    const done = await processEsgExportJob(deps, exportId);
    assert.equal(done.rowCount, 1);
    const csv = ports.stored.get(`esg-exports/${exportId}.csv`) as string;
    assert.ok(csv.includes(tenant.customerId));
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminEsgError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_ESG_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('响应字段与 OpenAPI 契约一致（summary/report/overview/export）', async () => {
    const api = loadJson('admin-esg-api.json');
    const tenant = await plantTenant('ESG-CT');
    const version = await plantCalcVersion();
    await plantSummary(tenant, 60, version.id, 3);
    await plantReport(tenant, 'DAILY', version.id);

    const { h, deps } = handlers();
    const summary = (await h.listDailySummary(req(superAdmin, { query: { customerId: tenant.customerId } })))
      .body as ListBody;
    assert.deepEqual(Object.keys(summary.data[0]).sort(), [...api.components.schemas.EsgDailySummary.required].sort());

    const reports = (await h.listReports(req(superAdmin, { query: { customerId: tenant.customerId } })))
      .body as ListBody;
    assert.deepEqual(Object.keys(reports.data[0]).sort(), [...api.components.schemas.EsgReport.required].sort());

    const overview = (await h.overview(req(superAdmin, {}))).body as DataBody;
    assert.deepEqual(Object.keys(overview.data).sort(), [...api.components.schemas.EsgOverview.required].sort());

    const created = await h.createExport(
      req(superAdmin, { body: { dataset: 'DAILY_SUMMARY', customerId: tenant.customerId } }),
    );
    const exportId = (created.body as DataBody).data.exportId;
    await processEsgExportJob(deps, exportId);
    const detail = (await h.exportDetail(req(superAdmin, { params: { exportId } }))).body as DataBody;
    assert.deepEqual(Object.keys(detail.data).sort(), [...api.components.schemas.EsgExportJob.required].sort());
  });

  test('esg 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/esg/', import.meta.url));
    for (const file of ['errors.ts', 'csv.ts', 'service.ts', 'export-service.ts', 'handler.ts', 'index.ts']) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
