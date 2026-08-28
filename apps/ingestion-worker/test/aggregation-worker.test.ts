/**
 * BE-ESG-01 小时/日聚合 Worker 验收（PGlite 真实 PostgreSQL + 按序应用全部 migration）。
 *
 * 验收基准覆盖：
 * - 固定输入产生确定输出：telemetry_hourly 完整率补齐、telemetry_daily 加权 rollup、
 *   esg_daily_summary 求和/均值 + 计算方法版本，逐字段断言；
 * - 重复执行结果不变：同一窗口二次运行后三张表快照完全一致（upsert 幂等）；
 * - 缺失序号正确反映完整率：完整率 = 已收 / (max(seq)-min(seq)+1)，乱序 receipt 归桶；
 * - 乱序迟到记录在允许窗口内重算后收敛（迟到 receipt/report 纳入同窗口重算）。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { AGGREGATION_CALCULATION_VERSION, createAggregationWorker } from '../src/index.js';
import { createTestDb } from '../../cloud-api/test/helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

const WINDOW = {
  from: new Date('2026-08-27T00:00:00.000Z'),
  to: new Date('2026-08-27T23:59:59.999Z'),
};

let receiptSeq = 0;
async function plantReceipt(deviceId: string, seq: number, receivedAt: string): Promise<void> {
  receiptSeq += 1;
  await prisma.ingestionReceipt.create({
    data: {
      idempotencyKey: `agg|${deviceId}|telemetry|${seq}`,
      deviceId,
      topicType: 'telemetry',
      seq,
      payloadHash: receiptSeq.toString(16).padStart(64, '0'),
      result: 'PROCESSED',
      receivedAt: new Date(receivedAt),
    },
  });
}

async function plantHourly(
  deviceId: string,
  bucketStart: string,
  sampleCount: number,
  metrics: Record<string, { avg: number; min: number; max: number; count: number }>,
): Promise<void> {
  await prisma.telemetryHourly.create({
    data: {
      deviceId,
      customerId: `cust-${deviceId}`,
      bucketStart: new Date(bucketStart),
      sampleCount,
      metrics,
    },
  });
}

async function plantReport(
  deviceId: string,
  periodStartTime: string,
  values: {
    feeding: number;
    discharge: number;
    reduction: number;
    power: number;
    carbon: number;
    completeness: number;
    missing: number;
  },
): Promise<void> {
  await prisma.esgReport.create({
    data: {
      deviceId,
      customerId: `cust-${deviceId}`,
      reportType: 'HOURLY',
      periodStartTime: new Date(periodStartTime),
      periodEndTime: new Date(Date.parse(periodStartTime) + 3_600_000),
      feedingWeightKg: values.feeding,
      dischargeWeightKg: values.discharge,
      reductionWeightKg: values.reduction,
      powerConsumptionKwh: values.power,
      carbonReductionKg: values.carbon,
      dataCompletenessPct: values.completeness,
      missingRecordCount: values.missing,
    },
  });
}

/** 表快照（Decimal/Date 序列化为可 deepEqual 的 plain 结构）。 */
async function snapshot(deviceId: string): Promise<unknown> {
  const [hourly, daily, esg] = await Promise.all([
    prisma.telemetryHourly.findMany({ where: { deviceId }, orderBy: { bucketStart: 'asc' } }),
    prisma.telemetryDaily.findMany({ where: { deviceId } }),
    prisma.esgDailySummary.findMany({ where: { deviceId } }),
  ]);
  return JSON.parse(JSON.stringify({ hourly, daily, esg }));
}

describe('createAggregationWorker（BE-ESG-01）', () => {
  test('固定输入产生确定输出：hourly 完整率（缺失序号）、daily 加权 rollup、ESG 日汇总 + 计算版本', async () => {
    const deviceId = 'dev-agg-a';
    // hour10 桶：seq {1,2,3,5,6,9,10} → 期望 10，已收 7 → 70.00%（缺失 4,7,8 共 3 条）
    for (const [i, seq] of [1, 2, 3, 5, 6, 9, 10].entries()) {
      await plantReceipt(deviceId, seq, `2026-08-27T10:0${i}:00.000Z`);
    }
    // hour11 桶：seq {11,12} → 期望 2，已收 2 → 100.00%
    await plantReceipt(deviceId, 11, '2026-08-27T11:00:00.000Z');
    await plantReceipt(deviceId, 12, '2026-08-27T11:01:00.000Z');

    await plantHourly(deviceId, '2026-08-27T10:00:00.000Z', 4, {
      chamberTempC: { avg: 50, min: 45, max: 55, count: 4 },
      powerKw: { avg: 2, min: 1, max: 3, count: 4 },
    });
    await plantHourly(deviceId, '2026-08-27T11:00:00.000Z', 6, {
      chamberTempC: { avg: 60, min: 55, max: 65, count: 6 },
      powerKw: { avg: 3, min: 2, max: 4, count: 6 },
    });

    await plantReport(deviceId, '2026-08-27T08:00:00.000Z', {
      feeding: 10.5,
      discharge: 8,
      reduction: 2.5,
      power: 12.5,
      carbon: 5.25,
      completeness: 90,
      missing: 2,
    });
    await plantReport(deviceId, '2026-08-27T20:00:00.000Z', {
      feeding: 20.5,
      discharge: 16,
      reduction: 4.5,
      power: 17.5,
      carbon: 8.75,
      completeness: 80,
      missing: 1,
    });

    const worker = createAggregationWorker({ client: prisma });
    const result = await worker.recomputeWindow(WINDOW);
    assert.deepEqual(
      { hourlyEnriched: result.hourlyEnriched, dailyUpserted: result.dailyUpserted, esgUpserted: result.esgUpserted },
      { hourlyEnriched: 2, dailyUpserted: 1, esgUpserted: 1 },
    );

    // hourly 完整率补齐（缺失序号正确反映完整率）
    const hourly = await prisma.telemetryHourly.findMany({ where: { deviceId }, orderBy: { bucketStart: 'asc' } });
    assert.equal(Number(hourly[0]?.completenessPct), 70, 'seq {1,2,3,5,6,9,10}/期望10 → 70%');
    assert.equal(Number(hourly[1]?.completenessPct), 100, 'seq {11,12}/期望2 → 100%');

    // telemetry_daily：sampleCount 求和 + 当日 receipt 完整率 + 按 count 加权 metrics
    const daily = await prisma.telemetryDaily.findFirst({ where: { deviceId } });
    assert.ok(daily);
    assert.equal(daily.bucketDate.toISOString(), '2026-08-27T00:00:00.000Z');
    assert.equal(daily.sampleCount, 10);
    // 当日 receipt seq {1,2,3,5,6,9,10,11,12}：期望 12，已收 9 → 75.00%
    assert.equal(Number(daily.completenessPct), 75);
    assert.deepEqual(daily.metrics, {
      chamberTempC: { avg: 56, min: 45, max: 65, count: 10 }, // (50*4 + 60*6) / 10
      powerKw: { avg: 2.6, min: 1, max: 4, count: 10 }, // (2*4 + 3*6) / 10
    });

    // esg_daily_summary：求和/均值 + 计算方法版本
    const summary = await prisma.esgDailySummary.findFirst({ where: { deviceId } });
    assert.ok(summary);
    assert.equal(summary.summaryDate.toISOString(), '2026-08-27T00:00:00.000Z');
    assert.equal(Number(summary.feedingWeightKg), 31);
    assert.equal(Number(summary.dischargeWeightKg), 24);
    assert.equal(Number(summary.reductionWeightKg), 7);
    assert.equal(Number(summary.powerConsumptionKwh), 30);
    assert.equal(Number(summary.carbonReductionKg), 14);
    assert.equal(Number(summary.dataCompletenessPct), 85, '(90 + 80) / 2');
    assert.equal(summary.missingRecordCount, 3);
    assert.equal(summary.calculationVersionId, result.calculationVersionId);
    const version = await prisma.esgCalculationVersion.findFirst({ where: { id: result.calculationVersionId } });
    assert.equal(version?.version, AGGREGATION_CALCULATION_VERSION);
    assert.equal(version?.status, 'ACTIVE');
  });

  test('重复执行结果不变（upsert 幂等）', async () => {
    const deviceId = 'dev-agg-b';
    await plantReceipt(deviceId, 1, '2026-08-27T10:00:00.000Z');
    await plantReceipt(deviceId, 3, '2026-08-27T10:01:00.000Z');
    await plantHourly(deviceId, '2026-08-27T10:00:00.000Z', 2, {
      chamberTempC: { avg: 50, min: 45, max: 55, count: 2 },
    });
    await plantReport(deviceId, '2026-08-27T08:00:00.000Z', {
      feeding: 10,
      discharge: 8,
      reduction: 2,
      power: 12,
      carbon: 5,
      completeness: 90,
      missing: 2,
    });

    const worker = createAggregationWorker({ client: prisma });
    await worker.recomputeWindow(WINDOW);
    const first = await snapshot(deviceId);
    await worker.recomputeWindow(WINDOW);
    const second = await snapshot(deviceId);

    assert.deepEqual(second, first, '同一窗口二次运行三张表快照完全一致');
    // 注：窗口内可能包含其他测试设备的行，upsert 幂等以本设备行数断言
    assert.equal(await prisma.telemetryDaily.count({ where: { deviceId } }), 1, '二次运行覆盖同键，不新增行');
    assert.equal(await prisma.esgDailySummary.count({ where: { deviceId } }), 1);
  });

  test('乱序迟到记录在允许窗口内重算后收敛', async () => {
    const deviceId = 'dev-agg-c';
    await plantReceipt(deviceId, 1, '2026-08-27T10:00:00.000Z');
    await plantReceipt(deviceId, 2, '2026-08-27T10:01:00.000Z');
    await plantReceipt(deviceId, 4, '2026-08-27T10:02:00.000Z'); // seq 3 缺口
    await plantHourly(deviceId, '2026-08-27T10:00:00.000Z', 3, {
      chamberTempC: { avg: 50, min: 45, max: 55, count: 3 },
    });
    await plantReport(deviceId, '2026-08-27T08:00:00.000Z', {
      feeding: 10,
      discharge: 8,
      reduction: 2,
      power: 12,
      carbon: 5,
      completeness: 90,
      missing: 1,
    });

    const worker = createAggregationWorker({ client: prisma });
    await worker.recomputeWindow(WINDOW);
    const before = await prisma.telemetryHourly.findFirst({ where: { deviceId } });
    assert.equal(Number(before?.completenessPct), 75, 'seq {1,2,4}/期望4 → 75%（缺 seq 3）');
    const esgBefore = await prisma.esgDailySummary.findFirst({ where: { deviceId } });
    assert.equal(Number(esgBefore?.feedingWeightKg), 10);

    // 迟到 receipt（seq 3）与迟到 report 进入同窗口后重算
    await plantReceipt(deviceId, 3, '2026-08-27T10:45:00.000Z');
    await plantReport(deviceId, '2026-08-27T12:00:00.000Z', {
      feeding: 5.5,
      discharge: 4,
      reduction: 1.5,
      power: 6,
      carbon: 2.5,
      completeness: 70,
      missing: 0,
    });
    await worker.recomputeWindow(WINDOW);

    const after = await prisma.telemetryHourly.findFirst({ where: { deviceId } });
    assert.equal(Number(after?.completenessPct), 100, '缺口 seq 3 补到后完整率收敛为 100%');
    const daily = await prisma.telemetryDaily.findFirst({ where: { deviceId } });
    assert.equal(Number(daily?.completenessPct), 100);
    const esgAfter = await prisma.esgDailySummary.findFirst({ where: { deviceId } });
    assert.equal(Number(esgAfter?.feedingWeightKg), 15.5);
    assert.equal(Number(esgAfter?.dataCompletenessPct), 80, '(90 + 70) / 2');
    assert.equal(esgAfter?.missingRecordCount, 1);
  });

  test('计算方法版本 ensure 幂等：重复运行不产生重复版本行', async () => {
    const worker = createAggregationWorker({ client: prisma });
    const run1 = await worker.recomputeWindow(WINDOW);
    const run2 = await worker.recomputeWindow(WINDOW);
    assert.equal(run1.calculationVersionId, run2.calculationVersionId);

    const versions = await prisma.esgCalculationVersion.findMany({
      where: { version: AGGREGATION_CALCULATION_VERSION },
    });
    assert.equal(versions.length, 1, '同一计算方法版本全局仅一行');
    const formula = versions[0]?.formula as Record<string, unknown>;
    assert.equal(formula.dailyRollup, 'weighted-avg by sample count; min-of-min; max-of-max');
    assert.equal(formula.completeness, 'received / (max(seq) - min(seq) + 1), missing clamped >= 0');
  });
});
