/**
 * BE-IOT-06 ESG Report Handler 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 期间结束早于开始被拒绝（INVALID_REPORT 隔离）；
 * - 期间重叠被拒绝（不同起点相交）；相同报告（同起点重放）幂等；
 * - RDS 与归档事件字段完整一致；
 * - 保留 audit.hash 与计算方法版本（carbonReductionMethod），不宣称第三方核证。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { createReportHandler, IngestError } from '../src/index.js';
import type { ValidatedMessage } from '../src/index.js';
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

const AUDIT_HASH = 'd'.repeat(64);

let seqCounter = 0;
async function plantDevice() {
  seqCounter += 1;
  const deviceId = `dev-rpt-${seqCounter}`;
  const customer = await prisma.customer.create({ data: { name: `Customer RPT ${seqCounter}` } });
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-RPT-${seqCounter}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
    },
  });
  return { deviceId, customerId: customer.id, certificateId: `cert-rpt-${seqCounter}` };
}

interface ReportCtx {
  deviceId: string;
  customerId: string;
  certificateId: string;
}

function reportMessage(
  ctx: ReportCtx,
  options: {
    seq: number;
    reportType?: string;
    periodStart?: string;
    periodEnd?: string;
    data?: Record<string, unknown>;
  },
): ValidatedMessage {
  const payload = {
    meta: {
      id: `RPT-${ctx.deviceId.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${options.seq}`,
      ts: '2026-08-28T08:00:00.000Z',
      seq: options.seq,
      schemaVer: '1.0',
    },
    audit: { hash: AUDIT_HASH },
    data: {
      reportType: options.reportType ?? 'CYCLE',
      periodStartTime: options.periodStart ?? '2026-08-28T07:00:00.000Z',
      periodEndTime: options.periodEnd ?? '2026-08-28T08:00:00.000Z',
      feedingWeightKg: 25.5,
      dischargeWeightKg: 3.2,
      reductionWeightKg: 22.3,
      cycleCount: 4,
      processingDurationMinutes: 180,
      energyConsumptionKwh: 7.2,
      averagePowerKw: 2.4,
      averageO2Pct: 20.8,
      averageCo2Ppm: 850,
      averageCh4Ppm: 10,
      averageN2oPpm: 0.3,
      carbonReductionKg: 15.6,
      carbonReductionMethod: 'DEFAULT_V1',
      dataCompletenessPct: 98.5,
      missingRecordCount: 2,
      ...(options.data ?? {}),
    },
  };
  return {
    envelope: {
      iotTopic: `bnx/device/${ctx.deviceId}/report`,
      iotDeviceId: ctx.deviceId,
      iotType: 'report',
      iotReceivedAt: Date.parse('2026-08-28T08:00:00.000Z'),
      iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${ctx.certificateId}`,
      payload,
    },
    device: {
      deviceId: ctx.deviceId,
      customerId: ctx.customerId,
      lifecycleStatus: 'Active',
      certificateId: ctx.certificateId,
      certificateFingerprint: 'e'.repeat(64),
    },
    messageId: payload.meta.id,
    occurredAt: '2026-08-28T08:00:00.000Z',
    data: payload.data,
    audit: payload.audit,
  };
}

async function expectQuarantine(promise: Promise<unknown>, errorPath: string): Promise<void> {
  let err: unknown;
  try {
    await promise;
  } catch (caught) {
    err = caught;
  }
  assert.ok(err instanceof IngestError, '必须抛 IngestError');
  assert.equal(err.classification, 'QUARANTINE');
  assert.equal(err.errorType, 'INVALID_REPORT');
  assert.equal(err.errorPath, errorPath);
}

describe('createReportHandler（BE-IOT-06）', () => {
  test('合法 CYCLE 报告：RDS 全字段映射 + 恰好一个归档事件（字段与 RDS 完整一致，保留方法版本与 audit.hash）', async () => {
    const ctx = await plantDevice();
    const result = await createReportHandler({ client: prisma })(reportMessage(ctx, { seq: 1 }));
    assert.isTrue(result.handled);
    assert.equal(result.reportStatus, 'created');
    assert.isTrue(result.archived);

    const report = await prisma.esgReport.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.ok(report);
    assert.equal(report.customerId, ctx.customerId);
    assert.equal(report.reportType, 'CYCLE');
    assert.equal(report.periodStartTime.toISOString(), '2026-08-28T07:00:00.000Z');
    assert.equal(report.periodEndTime.toISOString(), '2026-08-28T08:00:00.000Z');
    assert.equal(Number(report.feedingWeightKg), 25.5);
    assert.equal(Number(report.dischargeWeightKg), 3.2);
    assert.equal(Number(report.reductionWeightKg), 22.3);
    assert.equal(report.cycleCount, 4);
    assert.equal(report.processingMinutes, 180);
    assert.equal(Number(report.powerConsumptionKwh), 7.2);
    assert.equal(Number(report.avgPowerKw), 2.4);
    assert.equal(Number(report.avgO2Pct), 20.8);
    assert.equal(Number(report.avgCo2Ppm), 850);
    assert.equal(Number(report.avgCh4Ppm), 10);
    assert.equal(Number(report.avgN2oPpm), 0.3);
    assert.equal(Number(report.carbonReductionKg), 15.6);
    assert.equal(report.carbonReductionMethod, 'DEFAULT_V1', '计算方法版本必须保留');
    assert.equal(Number(report.dataCompletenessPct), 98.5);
    assert.equal(report.missingRecordCount, 2);
    assert.ok(report.sourceMessageId);

    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: ctx.deviceId } });
    assert.equal(events.length, 1);
    const archivePayload = events[0]?.payload as Record<string, unknown>;
    assert.equal(archivePayload.topicType, 'report');
    assert.equal(archivePayload.auditHash, AUDIT_HASH, 'audit.hash 必须保留');
    assert.equal(archivePayload.attestation, 'NONE', '不宣称第三方核证');
    const columns = archivePayload.columns as Record<string, unknown>;
    // RDS 与归档事件字段完整一致（同源映射逐键对齐）
    assert.equal(columns.reportType, report.reportType);
    assert.equal(new Date(columns.periodStartTime as string).toISOString(), report.periodStartTime.toISOString());
    assert.equal(new Date(columns.periodEndTime as string).toISOString(), report.periodEndTime.toISOString());
    assert.equal(columns.feedingWeightKg, Number(report.feedingWeightKg));
    assert.equal(columns.powerConsumptionKwh, Number(report.powerConsumptionKwh));
    assert.equal(columns.carbonReductionMethod, report.carbonReductionMethod);
    assert.equal(columns.missingRecordCount, report.missingRecordCount);
    assert.equal(columns.sourceMessageId, report.sourceMessageId);
  });

  test('期间结束早于开始 → INVALID_REPORT 隔离，无 RDS/归档写入', async () => {
    const ctx = await plantDevice();
    await expectQuarantine(
      createReportHandler({ client: prisma })(
        reportMessage(ctx, { seq: 1, periodStart: '2026-08-28T08:00:00.000Z', periodEnd: '2026-08-28T07:00:00.000Z' }),
      ),
      'data.periodEndTime',
    );
    assert.equal(await prisma.esgReport.count({ where: { deviceId: ctx.deviceId } }), 0);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }), 0);
  });

  test('期间重叠（不同起点相交）→ INVALID_REPORT 隔离；邻接期间不视为重叠', async () => {
    const ctx = await plantDevice();
    const handle = createReportHandler({ client: prisma });
    await handle(
      reportMessage(ctx, { seq: 1, periodStart: '2026-08-28T07:00:00.000Z', periodEnd: '2026-08-28T08:00:00.000Z' }),
    );

    // 重叠：起点不同但区间相交
    await expectQuarantine(
      handle(
        reportMessage(ctx, { seq: 2, periodStart: '2026-08-28T07:30:00.000Z', periodEnd: '2026-08-28T08:30:00.000Z' }),
      ),
      'data.periodStartTime',
    );
    assert.equal(await prisma.esgReport.count({ where: { deviceId: ctx.deviceId } }), 1);

    // 邻接（起点 = 既有终点）：合法
    const adjacent = await handle(
      reportMessage(ctx, { seq: 3, periodStart: '2026-08-28T08:00:00.000Z', periodEnd: '2026-08-28T09:00:00.000Z' }),
    );
    assert.equal(adjacent.reportStatus, 'created');
    assert.equal(await prisma.esgReport.count({ where: { deviceId: ctx.deviceId } }), 2);
  });

  test('相同报告幂等：同 seq 重复跳过；同期间起点新 seq 重放也跳过（仍一行一个归档）', async () => {
    const ctx = await plantDevice();
    const handle = createReportHandler({ client: prisma });
    await handle(reportMessage(ctx, { seq: 1 }));

    const sameMessage = await handle(reportMessage(ctx, { seq: 1 }));
    assert.equal(sameMessage.outcome, 'DUPLICATE_SKIPPED');

    // 设备重发同一报告（新 seq、同期间起点、相同内容）
    const replay = await handle(reportMessage(ctx, { seq: 2 }));
    assert.equal(replay.outcome, 'PROCESSED', 'receipt 键不同正常入账');
    assert.equal(replay.reportStatus, 'duplicate', '相同报告幂等跳过');
    assert.isFalse(replay.archived);

    assert.equal(await prisma.esgReport.count({ where: { deviceId: ctx.deviceId } }), 1);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }), 1, '归档事件仍恰好一个');
  });

  test('HOURLY/DAILY 类型各自入库；可选缺省列不落', async () => {
    const ctx = await plantDevice();
    const handle = createReportHandler({ client: prisma });
    const hourly = await handle(reportMessage(ctx, { seq: 1, reportType: 'HOURLY' }));
    const daily = await handle(
      reportMessage(ctx, {
        seq: 2,
        reportType: 'DAILY',
        periodStart: '2026-08-27T00:00:00.000Z',
        periodEnd: '2026-08-28T00:00:00.000Z',
        data: { averageN2oPpm: undefined, carbonReductionKg: undefined },
      }),
    );
    assert.equal(hourly.reportStatus, 'created');
    assert.equal(daily.reportStatus, 'created');

    const dailyRow = await prisma.esgReport.findFirst({ where: { deviceId: ctx.deviceId, reportType: 'DAILY' } });
    assert.ok(dailyRow);
    assert.equal(dailyRow.avgN2oPpm, null);
    assert.equal(dailyRow.carbonReductionKg, null);
    assert.equal(await prisma.esgReport.count({ where: { deviceId: ctx.deviceId } }), 2);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }), 2);
  });

  test('非 report 消息不处理（分发保护）', async () => {
    const ctx = await plantDevice();
    const message = reportMessage(ctx, { seq: 1 });
    const telemetry = {
      ...message,
      envelope: { ...message.envelope, iotType: 'telemetry', iotTopic: `bnx/device/${ctx.deviceId}/telemetry` },
    };
    const result = await createReportHandler({ client: prisma })(telemetry);
    assert.isFalse(result.handled);
    assert.equal(await prisma.esgReport.count({ where: { deviceId: ctx.deviceId } }), 0);
  });
});
