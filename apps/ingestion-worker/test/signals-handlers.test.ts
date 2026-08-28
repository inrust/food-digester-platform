/**
 * BE-IOT-07 Alarm/Event/Tamper Handler 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - Alarm 状态正确闭合（ACTIVE 建行 → CLEARED 关闭 + clearedAt；重复 CLEAR 幂等）；
 * - Event 不误创建 Alarm（仅 device_events 一行）；
 * - 符合策略的 Tamper 只挂起一次（CRITICAL → Active→Suspended 一次，含策略原因与审计；
 *   重复/第二个 Tamper 不再迁移）；audit.hash 随归档保留。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { createAlarmHandler, createEventHandler, createTamperHandler } from '../src/index.js';
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

const TS = '2026-08-28T09:00:00.000Z';
const AUDIT_HASH = 'a1'.repeat(32);

let seqCounter = 0;
async function plantDevice(lifecycleStatus = 'Active') {
  seqCounter += 1;
  const deviceId = `dev-sig-${seqCounter}`;
  const customer = await prisma.customer.create({ data: { name: `Customer SIG ${seqCounter}` } });
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-SIG-${seqCounter}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus,
      customerId: customer.id,
    },
  });
  return { deviceId, customerId: customer.id, certificateId: `cert-sig-${seqCounter}` };
}

type IotType = 'alarm' | 'event' | 'tamper';

function signalMessage(
  ctx: { deviceId: string; customerId: string; certificateId: string },
  iotType: IotType,
  options: { seq: number; data: Record<string, unknown>; withAudit?: boolean; ts?: string },
): ValidatedMessage {
  const ts = options.ts ?? TS;
  const payload: Record<string, unknown> = {
    meta: {
      id: `${iotType.toUpperCase()}-${ctx.deviceId.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${options.seq}`,
      ts,
      seq: options.seq,
      schemaVer: '1.0',
    },
    data: options.data,
  };
  if (options.withAudit) payload.audit = { hash: AUDIT_HASH };
  return {
    envelope: {
      iotTopic: `bnx/device/${ctx.deviceId}/${iotType}`,
      iotDeviceId: ctx.deviceId,
      iotType,
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
    messageId: (payload.meta as Record<string, unknown>).id as string,
    occurredAt: ts,
    data: options.data,
    audit: options.withAudit ? { hash: AUDIT_HASH } : null,
  };
}

describe('createAlarmHandler（BE-IOT-07 Alarm）', () => {
  test('ACTIVE 建行（字段映射）→ CLEARED 正确闭合；重复 CLEAR 幂等；各生成归档事件', async () => {
    const ctx = await plantDevice();
    const handle = createAlarmHandler({ client: prisma });

    const activated = await handle(
      signalMessage(ctx, 'alarm', {
        seq: 1,
        data: {
          code: 'TEMP_HIGH',
          category: 'SENSOR',
          severity: 'HIGH',
          status: 'ACTIVE',
          detectedTime: '2026-08-28T08:59:00.000Z',
          component: 'chamber',
          currentValue: 85.5,
          threshold: 80,
          unit: '°C',
          message: 'Chamber temperature above threshold',
          recommendedAction: 'Check cooling',
        },
      }),
    );
    assert.equal(activated.action, 'activated');
    assert.isTrue(activated.archived);

    let alarm = await prisma.alarm.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.ok(alarm);
    assert.equal(alarm.status, 'ACTIVE');
    assert.equal(alarm.code, 'TEMP_HIGH');
    assert.equal(alarm.severity, 'HIGH');
    assert.equal(alarm.currentValue, '85.5', '数值落 String 列');
    assert.equal(alarm.threshold, '80');
    assert.equal(alarm.unit, '°C');
    assert.equal(alarm.detectedTime.toISOString(), '2026-08-28T08:59:00.000Z');
    assert.equal(alarm.customerId, ctx.customerId);

    const cleared = await handle(
      signalMessage(ctx, 'alarm', {
        seq: 2,
        data: { code: 'TEMP_HIGH', category: 'SENSOR', severity: 'HIGH', status: 'CLEARED', detectedTime: TS },
      }),
    );
    assert.equal(cleared.action, 'cleared');
    alarm = await prisma.alarm.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.equal(alarm?.status, 'CLEARED', 'Alarm 状态正确闭合');
    assert.equal(alarm?.clearedAt?.toISOString(), TS);

    // 重复 CLEAR（新 seq）→ 幂等 no-op，仍生成归档但不再改动状态
    const reclear = await handle(
      signalMessage(ctx, 'alarm', {
        seq: 3,
        data: { code: 'TEMP_HIGH', category: 'SENSOR', severity: 'HIGH', status: 'CLEARED' },
      }),
    );
    assert.equal(reclear.action, 'clear-noop');
    assert.equal(await prisma.alarm.count({ where: { deviceId: ctx.deviceId } }), 1);
    assert.equal(
      await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }),
      3,
      '每次合法信号一个归档事件',
    );

    // 同 seq 重放 → receipt 幂等
    const replay = await handle(
      signalMessage(ctx, 'alarm', {
        seq: 3,
        data: { code: 'TEMP_HIGH', category: 'SENSOR', severity: 'HIGH', status: 'CLEARED' },
      }),
    );
    assert.equal(replay.outcome, 'DUPLICATE_SKIPPED');
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }), 3);
  });
});

describe('createEventHandler（BE-IOT-07 Event）', () => {
  test('操作事件仅写 device_events + 归档：不误创建 Alarm', async () => {
    const ctx = await plantDevice();
    const result = await createEventHandler({ client: prisma })(
      signalMessage(ctx, 'event', {
        seq: 1,
        data: {
          eventType: 'MANUAL_FEEDING',
          userId: 'u-1',
          username: 'operator1',
          source: 'LOCAL',
          remarks: '手动投料',
        },
      }),
    );
    assert.isTrue(result.handled);
    assert.isTrue(result.archived);

    const event = await prisma.deviceEvent.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.ok(event);
    assert.equal(event.eventType, 'MANUAL_FEEDING');
    assert.equal(event.username, 'operator1');
    assert.equal(event.source, 'LOCAL');
    assert.equal(event.occurredAt.toISOString(), TS);
    assert.equal(await prisma.alarm.count({ where: { deviceId: ctx.deviceId } }), 0, 'Event 不得创建 Alarm');
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: ctx.deviceId } }), 1);
  });
});

describe('createTamperHandler（BE-IOT-07 Tamper）', () => {
  test('CRITICAL Tamper：事件保存 + 归档含 audit.hash + 策略挂起一次（原因/审计/状态史）', async () => {
    const ctx = await plantDevice();
    const handle = createTamperHandler({ client: prisma });

    const first = await handle(
      signalMessage(ctx, 'tamper', {
        seq: 1,
        withAudit: true,
        data: {
          eventType: 'ROOT_DETECTED',
          severity: 'CRITICAL',
          component: 'os',
          details: 'root shell detected',
          actionTaken: 'DEVICE_SUSPENDED',
        },
      }),
    );
    assert.isTrue(first.suspended, '符合策略的 Tamper 必须挂起');
    assert.isTrue(first.archived);

    const tamper = await prisma.tamperEvent.findFirst({ where: { deviceId: ctx.deviceId } });
    assert.ok(tamper);
    assert.equal(tamper.eventType, 'ROOT_DETECTED');
    assert.equal(tamper.severity, 'CRITICAL');
    assert.equal(tamper.actionTaken, 'DEVICE_SUSPENDED');

    const device = await prisma.device.findFirst({ where: { id: ctx.deviceId } });
    assert.equal(device?.lifecycleStatus, 'Suspended');

    const history = await prisma.deviceStateHistory.findMany({ where: { deviceId: ctx.deviceId } });
    assert.ok(history.some((h) => h.toStatus === 'Suspended' && h.actorId === 'system:tamper-policy'));
    const audits = await prisma.auditLog.findMany({
      where: { objectId: ctx.deviceId, action: 'device.lifecycle.Active_to_Suspended' },
    });
    assert.equal(audits.length, 1, '自动挂起必须恰好一条审计');
    assert.include(audits[0]?.reason, 'TAMPER_AUTO_SUSPEND', '挂起必须有策略原因');
    assert.equal(audits[0]?.result, 'SUCCESS');

    const archive = await prisma.outboxEvent.findFirst({ where: { aggregateId: ctx.deviceId } });
    assert.equal((archive?.payload as Record<string, unknown>).auditHash, AUDIT_HASH, 'Tamper 归档必须保留 audit.hash');

    // 第二个 CRITICAL Tamper（设备已 Suspended）→ 事件照存，但不再挂起（只挂起一次）
    const second = await handle(
      signalMessage(ctx, 'tamper', {
        seq: 2,
        withAudit: true,
        data: { eventType: 'ROOT_DETECTED', severity: 'CRITICAL', component: 'os', actionTaken: 'DEVICE_SUSPENDED' },
      }),
    );
    assert.isFalse(second.suspended, '已挂起设备不得重复迁移');
    assert.equal(await prisma.tamperEvent.count({ where: { deviceId: ctx.deviceId } }), 2);
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: ctx.deviceId, action: 'device.lifecycle.Active_to_Suspended' },
      }),
      1,
      '不产生第二次挂起审计',
    );
    assert.equal(
      await prisma.deviceStateHistory.count({ where: { deviceId: ctx.deviceId, toStatus: 'Suspended' } }),
      2,
      '状态史仅首次迁移的两轴条目',
    );
  });

  test('非策略严重度（WARNING）Tamper：事件保存但不挂起', async () => {
    const ctx = await plantDevice();
    const result = await createTamperHandler({ client: prisma })(
      signalMessage(ctx, 'tamper', {
        seq: 1,
        withAudit: true,
        data: { eventType: 'CASE_OPENED', severity: 'WARNING', component: 'case', actionTaken: 'NONE' },
      }),
    );
    assert.isFalse(result.suspended);
    const device = await prisma.device.findFirst({ where: { id: ctx.deviceId } });
    assert.equal(device?.lifecycleStatus, 'Active');
    assert.equal(await prisma.tamperEvent.count({ where: { deviceId: ctx.deviceId } }), 1);
  });

  test('非 Active 生命周期设备的 CRITICAL Tamper：不挂起（只挂起一次语义）', async () => {
    const ctx = await plantDevice('Onboarded');
    const result = await createTamperHandler({ client: prisma })(
      signalMessage(ctx, 'tamper', {
        seq: 1,
        withAudit: true,
        data: { eventType: 'ROOT_DETECTED', severity: 'CRITICAL', component: 'os', actionTaken: 'DEVICE_SUSPENDED' },
      }),
    );
    assert.isFalse(result.suspended);
    const device = await prisma.device.findFirst({ where: { id: ctx.deviceId } });
    assert.equal(device?.lifecycleStatus, 'Onboarded');
  });
});

describe('分发保护', () => {
  test('三个 Handler 对非本类型消息均不处理', async () => {
    const ctx = await plantDevice();
    const alarmMsg = signalMessage(ctx, 'alarm', {
      seq: 1,
      data: { code: 'X', category: 'C', severity: 'INFO', status: 'ACTIVE' },
    });
    assert.isFalse((await createEventHandler({ client: prisma })(alarmMsg)).handled);
    assert.isFalse((await createTamperHandler({ client: prisma })(alarmMsg)).handled);
    assert.isFalse(
      (
        await createAlarmHandler({ client: prisma })({
          ...alarmMsg,
          envelope: { ...alarmMsg.envelope, iotType: 'event' },
        })
      ).handled,
    );
    assert.equal(await prisma.alarm.count({ where: { deviceId: ctx.deviceId } }), 0);
    assert.equal(await prisma.deviceEvent.count({ where: { deviceId: ctx.deviceId } }), 0);
    assert.equal(await prisma.tamperEvent.count({ where: { deviceId: ctx.deviceId } }), 0);
  });
});
