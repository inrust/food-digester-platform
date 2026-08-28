/**
 * BE-RPL-01 Replay Worker 验收（PGlite 真实 PostgreSQL + 内存 Reader/Sink）。
 *
 * 验收基准覆盖：
 * - 从归档读取原始记录重投 Ingress：范围内进入队列，范围外（设备/时间/序号/Customer）不进入；
 * - 重放沿用原幂等键：已处理消息经 BE-IOT-03 receipt 去重，不复制业务记录；
 * - 任务状态机 PENDING→RUNNING→COMPLETED/FAILED + 成功/跳过/失败统计 + 执行审计；
 * - 非 PENDING 重复执行幂等 no-op。
 */
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { createReplayWorker, createTelemetryHandler } from '../src/index.js';
import type { ReplayArchiveReader, ReplayIngressRecord, ReplayIngressSink, ReplayScopeInput } from '../src/index.js';
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

class MemoryReader implements ReplayArchiveReader {
  readonly objects = new Map<string, Uint8Array>();
  putLines(prefix: string, partName: string, lines: Record<string, unknown>[]): string {
    const key = `${prefix}${partName}.json.gz`;
    this.objects.set(key, gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')));
    return key;
  }
  async listKeys(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
  async getObject(key: string): Promise<Uint8Array> {
    const body = this.objects.get(key);
    if (!body) throw new Error(`object not found: ${key}`);
    return body;
  }
}

class MemorySink implements ReplayIngressSink {
  readonly sent: ReplayIngressRecord[] = [];
  failOnSeq: number | null = null;
  async send(record: ReplayIngressRecord): Promise<void> {
    const meta = (record.payload as Record<string, unknown>).meta as Record<string, unknown>;
    if (this.failOnSeq !== null && meta.seq === this.failOnSeq) throw new Error('ingress unavailable');
    this.sent.push(record);
  }
}

const PREFIX_10H = 'raw/topic_type=telemetry/customer_id=cust-rpl/year=2026/month=08/day=28/hour=10/';

function archiveLine(options: {
  deviceId?: string;
  customerId?: string;
  seq: number;
  occurredAt?: string;
  messageId?: string;
}): Record<string, unknown> {
  const occurredAt = options.occurredAt ?? '2026-08-28T10:30:00.000Z';
  const deviceId = options.deviceId ?? 'dev-rpl-a';
  return {
    eventId: `evt-${options.seq}`,
    topicType: 'telemetry',
    messageId: options.messageId ?? `TEL-DEV-RPL-${options.seq}`,
    deviceId,
    customerId: options.customerId ?? 'cust-rpl',
    occurredAt,
    receivedAtMs: Date.parse(occurredAt),
    payloadHash: 'e'.repeat(64),
    auditHash: null,
    payload: {
      meta: {
        id: options.messageId ?? `TEL-DEV-RPL-${options.seq}`,
        ts: occurredAt,
        seq: options.seq,
        schemaVer: '1.0',
      },
      data: { chamberTempC: 55 },
    },
  };
}

const SCOPE: ReplayScopeInput = {
  customerId: 'cust-rpl',
  from: '2026-08-28T10:00:00.000Z',
  to: '2026-08-28T10:59:59.999Z',
};

let seq = 0;
async function plantJob(scope: ReplayScopeInput): Promise<string> {
  seq += 1;
  const job = await prisma.replayJob.create({
    data: { requestedBy: `op-${seq}`, scope: JSON.parse(JSON.stringify(scope)), status: 'PENDING' },
  });
  return job.id;
}

describe('createReplayWorker（BE-RPL-01）', () => {
  test('范围内记录重投 Ingress（沿用原 meta.id/seq）；范围外（设备/时间/序号/Customer）不进入队列；COMPLETED + 统计 + 执行审计', async () => {
    const reader = new MemoryReader();
    reader.putLines(PREFIX_10H, 'part-aaaa1111bbbb2222', [
      archiveLine({ seq: 100 }),
      archiveLine({ seq: 101, deviceId: 'dev-rpl-b' }), // 范围外：非目标设备
      archiveLine({ seq: 102, occurredAt: '2026-08-28T09:30:00.000Z' }), // 范围外：时间
      archiveLine({ seq: 999 }), // 范围外：序号
      archiveLine({ seq: 103, customerId: 'cust-other' }), // 范围外：Customer（行内断言）
      archiveLine({ seq: 104, deviceId: 'dev-rpl-a' }),
    ]);
    const sink = new MemorySink();
    const worker = createReplayWorker({ client: prisma, reader, sink });
    const jobId = await plantJob({ ...SCOPE, deviceId: 'dev-rpl-a', seqFrom: 100, seqTo: 200 });

    const result = await worker.executeJob(jobId);
    assert.equal(result.status, 'COMPLETED');
    assert.deepEqual(result.summary, { scannedObjects: 1, scannedLines: 6, sent: 2, skipped: 4, failed: 0 });

    assert.equal(sink.sent.length, 2, '仅范围内记录进入队列');
    for (const record of sink.sent) {
      assert.equal(record.iotTopic, 'bnx/device/dev-rpl-a/telemetry');
      assert.equal(record.iotDeviceId, 'dev-rpl-a');
      assert.equal(record.iotType, 'telemetry');
      const meta = (record.payload as Record<string, unknown>).meta as Record<string, unknown>;
      assert.include([100, 104], meta.seq, '重放沿用原序号（幂等键）');
      assert.match(meta.id as string, /^TEL-DEV-RPL-/, '重放沿用原 meta.id（幂等键）');
    }

    const job = await prisma.replayJob.findFirst({ where: { id: jobId } });
    assert.equal(job?.status, 'COMPLETED');
    const summary = job?.resultSummary as Record<string, unknown>;
    assert.equal(summary.sent, 2);
    assert.equal(summary.skipped, 4);
    assert.ok(job?.completedAt);
    const audits = await prisma.auditLog.findMany({ where: { objectId: jobId, action: 'replay.job.execute' } });
    assert.equal(audits.length, 1, '每次执行写审计');
    assert.equal(audits[0]?.result, 'SUCCESS');
  });

  test('已处理消息重放不会复制业务记录（原幂等键经 receipt 去重）', async () => {
    // 设备/客户台账（BE-IOT-05 telemetry handler 需要 customerId）
    const customer = await prisma.customer.create({ data: { name: 'Customer RPL-E2E' } });
    await prisma.device.create({
      data: {
        id: 'dev-rpl-a',
        serialNumber: 'SN-RPL-E2E',
        model: 'BNX-100',
        hardwareVersion: 'HW1.0',
        manufacturer: 'Hiddenjoy',
        manufactureDate: new Date('2026-01-01T00:00:00Z'),
        lifecycleStatus: 'Active',
        customerId: customer.id,
      },
    });
    const handle = createTelemetryHandler({ client: prisma });
    const toValidated = (record: ReplayIngressRecord): ValidatedMessage => {
      const payload = record.payload as Record<string, unknown>;
      const meta = payload.meta as Record<string, unknown>;
      return {
        envelope: {
          iotTopic: record.iotTopic,
          iotDeviceId: record.iotDeviceId,
          iotType: 'telemetry',
          iotReceivedAt: record.iotReceivedAt,
          iotPrincipal: 'arn:aws:iot:ap-southeast-1:123456789012:cert/cert-rpl',
          payload,
        },
        device: {
          deviceId: record.iotDeviceId,
          customerId: customer.id,
          lifecycleStatus: 'Active',
          certificateId: 'cert-rpl',
          certificateFingerprint: 'f'.repeat(64),
        },
        messageId: meta.id as string,
        occurredAt: meta.ts as string,
        data: payload.data as Record<string, unknown>,
        audit: null,
      };
    };

    // 重放出 seq=100（已处理）与 seq=105（新）两条
    const reader = new MemoryReader();
    reader.putLines(PREFIX_10H, 'part-cccc3333dddd4444', [archiveLine({ seq: 100 }), archiveLine({ seq: 105 })]);
    const sink = new MemorySink();
    const worker = createReplayWorker({ client: prisma, reader, sink });

    // 首轮：两条都未处理 → 全部落业务
    const jobId1 = await plantJob(SCOPE);
    await worker.executeJob(jobId1);
    assert.equal(sink.sent.length, 2);
    const firstRun = [
      await handle(toValidated(sink.sent[0] as ReplayIngressRecord)),
      await handle(toValidated(sink.sent[1] as ReplayIngressRecord)),
    ];
    assert.equal(firstRun[0].outcome, 'PROCESSED');
    assert.equal(firstRun[1].outcome, 'PROCESSED');
    const aggregatesAfterFirst = await prisma.telemetryHourly.findMany({ where: { deviceId: 'dev-rpl-a' } });
    assert.equal(aggregatesAfterFirst[0]?.sampleCount, 2);

    // 第二轮重放同范围：sink 收到相同原幂等键记录 → receipt 去重，无业务复制
    const jobId2 = await plantJob(SCOPE);
    await worker.executeJob(jobId2);
    assert.equal(sink.sent.length, 4, '重放重新投入 Ingress');
    const secondRun = [
      await handle(toValidated(sink.sent[2] as ReplayIngressRecord)),
      await handle(toValidated(sink.sent[3] as ReplayIngressRecord)),
    ];
    assert.equal(secondRun[0].outcome, 'DUPLICATE_SKIPPED', '已处理消息重放被原幂等键去重');
    assert.equal(secondRun[1].outcome, 'DUPLICATE_SKIPPED');
    const aggregatesAfterSecond = await prisma.telemetryHourly.findMany({ where: { deviceId: 'dev-rpl-a' } });
    assert.equal(aggregatesAfterSecond[0]?.sampleCount, 2, '重放不复制业务记录（聚合计数不变）');
    assert.equal(await prisma.telemetryHourly.count({ where: { deviceId: 'dev-rpl-a' } }), 1);
  });

  test('单条重投失败计入 failed 不中断；非 PENDING 重复执行幂等 no-op', async () => {
    const reader = new MemoryReader();
    reader.putLines(PREFIX_10H, 'part-eeee5555ffff6666', [archiveLine({ seq: 200 }), archiveLine({ seq: 201 })]);
    const sink = new MemorySink();
    sink.failOnSeq = 200;
    const worker = createReplayWorker({ client: prisma, reader, sink });
    const jobId = await plantJob(SCOPE);

    const result = await worker.executeJob(jobId);
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.summary?.sent, 1);
    assert.equal(result.summary?.failed, 1, '重投失败计入统计');

    // 重复执行：COMPLETED 任务不再执行（sink 计数不变）
    const again = await worker.executeJob(jobId);
    assert.equal(again.status, 'ALREADY_DONE');
    assert.equal(sink.sent.length, 1);
  });

  test('读取异常 → FAILED + 错误摘要 + FAILURE 审计', async () => {
    const reader = new MemoryReader();
    reader.listKeys = async () => {
      throw new Error('S3 ListObjects access denied');
    };
    const sink = new MemorySink();
    const worker = createReplayWorker({ client: prisma, reader, sink });
    const jobId = await plantJob(SCOPE);

    const result = await worker.executeJob(jobId);
    assert.equal(result.status, 'FAILED');
    const job = await prisma.replayJob.findFirst({ where: { id: jobId } });
    assert.equal(job?.status, 'FAILED');
    assert.include((job?.resultSummary as Record<string, unknown>).error as string, 'access denied');
    const audits = await prisma.auditLog.findMany({ where: { objectId: jobId, action: 'replay.job.execute' } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'FAILURE');
  });
});
