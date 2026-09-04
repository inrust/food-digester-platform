/**
 * BE-IOT-05 Telemetry Handler 验收（PGlite 真实 PostgreSQL + 真实 CT-03 Schema）。
 *
 * 验收基准覆盖：
 * - 字段单位/范围错误被隔离（端到端：humidityPct>100 → Quarantine，无聚合/归档写入）；
 * - RDS 无原始明细表写入（仅有 hourly 聚合行；原始 Payload 仅存在于归档 outbox 载荷）；
 * - 合法记录恰好生成一个归档事件（重复消息不追加）；
 * - 增量摘要合并（avg/min/max/count + sampleCount）；
 * - 耗材边界：Schema 未定义耗材字段 → 不更新耗材投影、不推算百分比。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { computeAuditHash } from '@fdp/contracts/mqtt/payload-normalization.js';
import { createIngestionHandler, createTelemetryHandler, hourlyBucketStart } from '../src/index.js';
import type { QuarantineRecord, ValidatedMessage } from '../src/index.js';
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

const RECEIVED_AT = Date.parse('2026-08-28T07:55:00.000Z');
const TS = '2026-08-28T07:55:00.000Z';

let seqCounter = 0;
async function plantDevice() {
  seqCounter += 1;
  const deviceId = `dev-tel-${seqCounter}`;
  const customer = await prisma.customer.create({ data: { name: `Customer TEL ${seqCounter}` } });
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-TEL-${seqCounter}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
    },
  });
  const certificateId = `cert-tel-${seqCounter}`;
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: `${'c'.repeat(60)}${String(seqCounter).padStart(4, '0')}`,
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    },
  });
  return { deviceId, customerId: customer.id, certificateId };
}

function messageIdOf(deviceId: string, seq: number): string {
  // CT-03 meta.id 仅允许 A-Z0-9-：设备 ID 规范化（测试用 dev-tel-* 含小写）
  return `TEL-${deviceId.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${seq}`;
}

function telemetryPayload(
  deviceId: string,
  seq: number,
  data: Record<string, unknown>,
  ts: string = TS,
): Record<string, unknown> {
  const payload = {
    meta: { id: messageIdOf(deviceId, seq), ts, seq, schemaVer: '1.0' },
    audit: { hash: '' },
    data,
  };
  payload.audit.hash = computeAuditHash(payload);
  return payload;
}

function telemetryMessage(
  ctx: { deviceId: string; customerId: string; certificateId: string },
  seq: number,
  data: Record<string, unknown>,
  ts: string = TS,
): ValidatedMessage {
  const payload = telemetryPayload(ctx.deviceId, seq, data, ts);
  return {
    envelope: {
      iotTopic: `bnx/device/${ctx.deviceId}/telemetry`,
      iotDeviceId: ctx.deviceId,
      iotType: 'telemetry',
      iotReceivedAt: Date.parse(ts),
      iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${ctx.certificateId}`,
      payload,
    },
    device: {
      deviceId: ctx.deviceId,
      customerId: ctx.customerId,
      lifecycleStatus: 'Active',
      certificateId: ctx.certificateId,
      certificateFingerprint: 'f'.repeat(64),
    },
    messageId: messageIdOf(ctx.deviceId, seq),
    occurredAt: ts,
    data: payload.data as Record<string, unknown>,
    audit: payload.audit as Record<string, unknown>,
  };
}

function envelopeBody(payload: Record<string, unknown>, ctx: { deviceId: string; certificateId: string }): string {
  return JSON.stringify({
    ...payload,
    iotTopic: `bnx/device/${ctx.deviceId}/telemetry`,
    iotDeviceId: ctx.deviceId,
    iotType: 'telemetry',
    iotReceivedAt: RECEIVED_AT,
    iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${ctx.certificateId}`,
  });
}

const FULL_DATA = {
  feedingWeightKg: 12.5,
  chamberWeightKg: 40,
  dischargeWeightKg: 9.8,
  humidityPct: 65,
  ambientTempC: 26.5,
  heatTemperatureC: 75,
  siloTemperatureC: 30,
  powerConsumptionKw: 1.8,
  o2Pct: 20.5,
  co2Ppm: 900,
  ch4Ppm: 12,
  n2oPpm: 0.4,
  currentAmp: 8.2,
};

describe('createTelemetryHandler（BE-IOT-05）', () => {
  test('合法记录：hourly 聚合一行 + 恰好一个归档事件（含原始 Payload/audit.hash），耗材投影不更新', async () => {
    const ctx = await plantDevice();
    const result = await createTelemetryHandler({ client: prisma })(telemetryMessage(ctx, 1, FULL_DATA));
    assert.isTrue(result.handled);
    assert.equal(result.outcome, 'PROCESSED');
    assert.isTrue(result.archived);
    assert.equal(result.sampleCount, 1);
    assert.equal(result.bucketStart?.toISOString(), '2026-08-28T07:00:00.000Z');
    assert.equal(hourlyBucketStart(new Date(TS)).toISOString(), '2026-08-28T07:00:00.000Z');

    const hourlyRows = await prisma.telemetryHourly.findMany({ where: { deviceId: ctx.deviceId } });
    assert.equal(hourlyRows.length, 1, 'RDS 仅有聚合一行，无原始明细');
    const hourly = hourlyRows[0];
    assert.ok(hourly);
    assert.equal(hourly.customerId, ctx.customerId);
    assert.equal(hourly.sampleCount, 1);
    const metrics = hourly.metrics as Record<string, { avg: number; min: number; max: number; count: number }>;
    assert.deepEqual(metrics.feedingWeightKg, { avg: 12.5, min: 12.5, max: 12.5, count: 1 });
    assert.deepEqual(metrics.humidityPct, { avg: 65, min: 65, max: 65, count: 1 });
    assert.equal(Object.keys(metrics).length, 13, '13 项指标全量入聚合');

    // 恰好一个归档事件，载荷含原始 Payload 与 audit.hash（S3 归档链路输入）
    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: ctx.deviceId } });
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.eventType, 'ARCHIVE');
    const archivePayload = event.payload as Record<string, unknown>;
    assert.equal(archivePayload.topicType, 'telemetry');
    assert.equal(archivePayload.messageId, messageIdOf(ctx.deviceId, 1));
    assert.equal(archivePayload.auditHash, computeAuditHash(telemetryPayload(ctx.deviceId, 1, FULL_DATA)));
    assert.equal(archivePayload.customerId, ctx.customerId);
    assert.deepEqual(
      (archivePayload.payload as Record<string, unknown>).data,
      FULL_DATA,
      '归档载荷必须携带原始 Payload',
    );

    // 耗材边界：Telemetry Schema 无耗材字段 → 不更新耗材投影、不推算百分比
    assert.equal(await prisma.consumableProjection.count({ where: { deviceId: ctx.deviceId } }), 0);
  });

  test('增量摘要：同窗口合并 avg/min/max/count 与 sampleCount；跨窗口各自成行', async () => {
    const ctx = await plantDevice();
    const handle = createTelemetryHandler({ client: prisma });
    await handle(telemetryMessage(ctx, 1, { feedingWeightKg: 10, humidityPct: 60 }));
    await handle(telemetryMessage(ctx, 2, { feedingWeightKg: 20, humidityPct: 80 }, '2026-08-28T07:56:00.000Z'));
    const third = await handle(telemetryMessage(ctx, 3, { feedingWeightKg: 30 }, '2026-08-28T08:05:00.000Z'));
    assert.equal(third.bucketStart?.toISOString(), '2026-08-28T08:00:00.000Z');

    const firstBucket = await prisma.telemetryHourly.findFirst({
      where: { deviceId: ctx.deviceId, bucketStart: new Date('2026-08-28T07:00:00.000Z') },
    });
    assert.ok(firstBucket);
    assert.equal(firstBucket.sampleCount, 2);
    const metrics = firstBucket.metrics as Record<string, { avg: number; min: number; max: number; count: number }>;
    assert.deepEqual(metrics.feedingWeightKg, { avg: 15, min: 10, max: 20, count: 2 });
    assert.deepEqual(metrics.humidityPct, { avg: 70, min: 60, max: 80, count: 2 });

    const secondBucket = await prisma.telemetryHourly.findFirst({
      where: { deviceId: ctx.deviceId, bucketStart: new Date('2026-08-28T08:00:00.000Z') },
    });
    assert.equal(secondBucket?.sampleCount, 1);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }), 3);
  });

  test('重复消息幂等跳过：归档事件仍恰好一个，聚合不重复累计', async () => {
    const ctx = await plantDevice();
    const handle = createTelemetryHandler({ client: prisma });
    const first = await handle(telemetryMessage(ctx, 1, FULL_DATA));
    const duplicate = await handle(telemetryMessage(ctx, 1, FULL_DATA));
    assert.equal(first.outcome, 'PROCESSED');
    assert.equal(duplicate.outcome, 'DUPLICATE_SKIPPED');
    assert.isFalse(duplicate.archived);

    assert.equal(
      await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }),
      1,
      '合法记录恰好一个归档事件',
    );
    const hourly = await prisma.telemetryHourly.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.equal(hourly?.sampleCount, 1, '重复消息不重复累计聚合');
  });

  test('字段范围错误被隔离（端到端）：humidityPct>100 进 Quarantine，无聚合/归档；同批合法消息照常处理', async () => {
    const ctx = await plantDevice();
    const quarantined: QuarantineRecord[] = [];
    const handle = createIngestionHandler({
      client: prisma,
      quarantine: {
        async send(record) {
          quarantined.push(record);
        },
      },
      onValidated: async (message) => {
        await createTelemetryHandler({ client: prisma })(message);
      },
    });
    const response = await handle({
      Records: [
        { messageId: 'sqs-bad', body: envelopeBody(telemetryPayload(ctx.deviceId, 1, { humidityPct: 150 }), ctx) },
        { messageId: 'sqs-good', body: envelopeBody(telemetryPayload(ctx.deviceId, 2, FULL_DATA), ctx) },
      ],
    });
    assert.deepEqual(response.batchItemFailures, []);
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0]?.errorType, 'SCHEMA_VIOLATION');
    assert.include(quarantined[0]?.errorPath, 'humidityPct');

    // 坏消息无聚合/归档；合法消息照常聚合 + 恰好一个归档
    const hourlyRows = await prisma.telemetryHourly.findMany({ where: { deviceId: ctx.deviceId } });
    assert.equal(hourlyRows.length, 1);
    assert.equal(hourlyRows[0]?.sampleCount, 1);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }), 1);
  });

  test('非 telemetry 消息不处理（分发保护）', async () => {
    const ctx = await plantDevice();
    const message = telemetryMessage(ctx, 1, FULL_DATA);
    const heartbeat = {
      ...message,
      envelope: { ...message.envelope, iotType: 'heartbeat', iotTopic: `bnx/device/${ctx.deviceId}/heartbeat` },
    };
    const result = await createTelemetryHandler({ client: prisma })(heartbeat);
    assert.isFalse(result.handled);
    assert.equal(await prisma.telemetryHourly.count({ where: { deviceId: ctx.deviceId } }), 0);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }), 0);
  });
});
