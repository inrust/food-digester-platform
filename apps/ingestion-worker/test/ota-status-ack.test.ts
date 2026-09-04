/** DEC-015 OTA Target 状态经既有 ACK 通道回传验收。 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { createAckHandler, IngestError } from '../src/index.js';
import type { ValidatedMessage } from '../src/index.js';
import { createTestDb } from '../../cloud-api/test/helpers.js';

const TS = '2026-09-04T10:20:00.000Z';
let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;
let seq = 0;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

async function plantTarget(status = 'NOTIFIED'): Promise<{ deviceId: string; customerId: string; targetId: string }> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `OTA ACK ${seq}` } });
  const deviceId = `dev-ota-ack-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-OTA-ACK-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
    },
  });
  const firmware = await prisma.firmwarePackage.create({
    data: {
      version: `1.0.${seq}`,
      model: 'BNX-100',
      packageType: 'FIRMWARE',
      sha256: `${seq}`.padStart(64, 'a'),
      sizeBytes: 1024n,
      s3Key: `ota/${seq}.bin`,
      status: 'VERIFIED',
      uploadedBy: 'admin',
    },
  });
  const campaign = await prisma.otaCampaign.create({
    data: {
      name: `Campaign ${seq}`,
      packageId: firmware.id,
      targetModel: 'BNX-100',
      status: 'RUNNING',
      createdBy: 'admin',
    },
  });
  const target = await prisma.otaTarget.create({
    data: { campaignId: campaign.id, deviceId, batchNo: 1, status },
  });
  return { deviceId, customerId: customer.id, targetId: target.id };
}

function otaAck(
  ctx: { deviceId: string; customerId: string; targetId: string },
  messageSeq: number,
  status: string,
  extra: Record<string, unknown> = {},
): ValidatedMessage {
  const data = { objectType: 'OTA_TARGET', otaTargetId: ctx.targetId, status, ...extra };
  const payload = { meta: { id: `ACK-OTA-${seq}-${messageSeq}`, ts: TS, seq: messageSeq }, data };
  return {
    envelope: {
      iotTopic: `bnx/device/${ctx.deviceId}/ack`,
      iotDeviceId: ctx.deviceId,
      iotType: 'ack',
      iotReceivedAt: Date.parse(TS),
      iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/cert-${ctx.deviceId}`,
      payload,
    },
    device: {
      deviceId: ctx.deviceId,
      customerId: ctx.customerId,
      lifecycleStatus: 'Active',
      certificateId: `cert-${ctx.deviceId}`,
      certificateFingerprint: 'f'.repeat(64),
    },
    messageId: payload.meta.id,
    occurredAt: TS,
    data,
    audit: null,
  };
}

async function expectQuarantine(run: () => Promise<unknown>, type: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof IngestError);
    assert.equal(error.errorType, type);
    return;
  }
  assert.fail(`应隔离 ${type}`);
}

describe('DEC-015 OTA ACK', () => {
  test('按冻结状态机完成下载、安装、成功；历史和审计同事务落库', async () => {
    const ctx = await plantTarget();
    const handle = createAckHandler({ client: prisma });
    assert.equal((await handle(otaAck(ctx, 1, 'DOWNLOADING'))).action, 'ota-applied');
    assert.equal((await handle(otaAck(ctx, 2, 'INSTALLING'))).toStatus, 'INSTALLING');
    const done = await handle(otaAck(ctx, 3, 'SUCCEEDED'));
    assert.equal(done.toStatus, 'SUCCEEDED');
    assert.isTrue(done.archived, 'OTA 结果应写入 DEC-016 独立操作记录归档');

    const target = await prisma.otaTarget.findUniqueOrThrow({ where: { id: ctx.targetId } });
    assert.equal(target.status, 'SUCCEEDED');
    assert.equal(target.completedAt?.toISOString(), TS);
    assert.equal(await prisma.otaStatusHistory.count({ where: { targetId: ctx.targetId } }), 3);
    assert.equal(
      await prisma.auditLog.count({
        where: { objectType: 'ota_target', objectId: ctx.targetId, action: 'ota.status.ack' },
      }),
      3,
    );
    const archived = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'ota_target', aggregateId: ctx.targetId, eventType: 'ARCHIVE' },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(archived.length, 3);
    for (const event of archived) {
      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.archiveClass, 'OPERATION_RECORD');
      assert.equal(payload.operationType, 'ota');
      assert.equal(payload.recordType, 'RESULT');
      assert.notEqual(payload.archiveClass, 'MQTT_RAW');
    }
  });

  test('相同状态新事件为 event-only；同 seq 同载荷完全幂等', async () => {
    const ctx = await plantTarget('DOWNLOADING');
    const handle = createAckHandler({ client: prisma });
    const message = otaAck(ctx, 10, 'DOWNLOADING');
    assert.equal((await handle(message)).action, 'ota-event-only');
    assert.equal((await handle(message)).outcome, 'DUPLICATE_SKIPPED');
    assert.equal(await prisma.otaStatusHistory.count({ where: { targetId: ctx.targetId } }), 1);
  });

  test('越级、未知 Target、跨设备和 COMMAND 字段混入均隔离', async () => {
    const ctx = await plantTarget();
    const other = await plantTarget();
    const handle = createAckHandler({ client: prisma });
    await expectQuarantine(() => handle(otaAck(ctx, 20, 'SUCCEEDED')), 'INVALID_OTA_STATE');
    await expectQuarantine(
      () => handle(otaAck({ ...ctx, targetId: 'missing-target' }, 21, 'DOWNLOADING')),
      'UNKNOWN_OTA_TARGET',
    );
    await expectQuarantine(
      () => handle(otaAck({ ...ctx, targetId: other.targetId }, 22, 'DOWNLOADING')),
      'OTA_TARGET_MISMATCH',
    );
    await expectQuarantine(() => handle(otaAck(ctx, 23, 'DOWNLOADING', { commandId: 'CMD-X' })), 'INVALID_ENVELOPE');
  });
});
