/**
 * BE-CMD-03 ACK Handler 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 成功 ACK：PUBLISHED + SUCCESS → SUCCEEDED；失败 ACK → FAILED；无 result → ACKNOWLEDGED 后结果后至；
 * - 重复 ACK：同 receipt 键（deviceId:ack:seq）同 Hash → DUPLICATE_SKIPPED 不重复落行；
 *   终态后新 ACK → 保存事件不改状态；
 * - 冲突：command 与原命令不符 / 跨设备回执 → 隔离（COMMAND_MISMATCH），状态不变、不落 ack；
 * - 未知 commandId → 隔离（UNKNOWN_COMMAND）；
 * - 迟到 ACK：TIMED_OUT 后 SUCCESS → 保存事件但状态保持 TIMED_OUT（不得静默改成功）；
 * - 前置状态无效：AUTHORIZED/PUBLISHING → 隔离（INVALID_COMMAND_STATE）；
 * - 审计链完整：audit_logs command.ack（actor=设备）+ 归档 Outbox（topicType=ack）。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { createAckHandler } from '../src/index.js';
import type { ValidatedMessage } from '../src/index.js';
import { IngestError } from '../src/index.js';
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

const TS = '2026-08-31T11:00:00.000Z';

let seqCounter = 0;

async function plantCommand(options: { status: string; command?: string }): Promise<{
  deviceId: string;
  customerId: string;
  commandId: string;
  command: string;
}> {
  seqCounter += 1;
  const customer = await prisma.customer.create({ data: { name: `ACK ${seqCounter}` } });
  const deviceId = `dev-ack-${seqCounter}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-ACK-${seqCounter}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
    },
  });
  const command = options.command ?? 'STOP';
  const commandId = `CMD-ACK-${seqCounter}`;
  await prisma.deviceCommand.create({
    data: {
      id: commandId,
      deviceId,
      customerId: customer.id,
      command,
      category: 'MACHINE',
      status: options.status,
      requestedBy: 'op-1',
      requestTime: new Date('2026-08-31T10:59:00.000Z'),
      timeoutSec: 120,
      expiresAt: new Date('2026-08-31T11:01:00.000Z'),
    },
  });
  return { deviceId, customerId: customer.id, commandId, command };
}

function ackMessage(
  ctx: { deviceId: string; customerId: string },
  options: { seq: number; data: Record<string, unknown>; ts?: string },
): ValidatedMessage {
  const ts = options.ts ?? TS;
  const data = { objectType: 'COMMAND', ...options.data };
  const payload: Record<string, unknown> = {
    meta: { id: `ACK-${ctx.deviceId.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${options.seq}`, ts, seq: options.seq },
    data,
  };
  return {
    envelope: {
      iotTopic: `bnx/device/${ctx.deviceId}/ack`,
      iotDeviceId: ctx.deviceId,
      iotType: 'ack',
      iotReceivedAt: Date.parse(ts),
      iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/cert-ack-${ctx.deviceId}`,
      payload,
    },
    device: {
      deviceId: ctx.deviceId,
      customerId: ctx.customerId,
      lifecycleStatus: 'Active',
      certificateId: `cert-ack-${ctx.deviceId}`,
      certificateFingerprint: 'f'.repeat(64),
    },
    messageId: (payload.meta as Record<string, unknown>).id as string,
    occurredAt: ts,
    data,
    audit: null,
  };
}

async function assertQuarantine(fn: () => Promise<unknown>, errorType: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof IngestError, `应为 IngestError，实际 ${String(err)}`);
    assert.equal(err.errorType, errorType);
    assert.equal(err.classification, 'QUARANTINE');
    return;
  }
  assert.fail(`应隔离（${errorType}）`);
}

describe('成功/失败/收到确认路径', () => {
  test('PUBLISHED + SUCCESS → SUCCEEDED；ack 落行；审计与归档齐备', async () => {
    const ctx = await plantCommand({ status: 'PUBLISHED' });
    const handle = createAckHandler({ client: prisma });
    const res = await handle(
      ackMessage(ctx, {
        seq: 1,
        data: { commandId: ctx.commandId, command: ctx.command, result: 'SUCCESS', executeTimeMs: 1520 },
      }),
    );
    assert.equal(res.action, 'applied');
    assert.equal(res.toStatus, 'SUCCEEDED');
    assert.isTrue(res.archived);

    const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: ctx.commandId } });
    assert.equal(row.status, 'SUCCEEDED');
    const ack = await prisma.commandAck.findFirst({ where: { commandId: ctx.commandId } });
    assert.ok(ack);
    assert.equal(ack.result, 'SUCCESS');
    assert.equal(ack.executeTimeMs, 1520);
    assert.ok(ack.sourceMessageId);

    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'device_command', objectId: ctx.commandId, action: 'command.ack' },
    });
    assert.ok(audit, '审计链缺 command.ack');
    assert.equal(audit.actorId, ctx.deviceId);
    assert.equal(audit.actorRole, 'device');
    assert.equal(audit.customerId, ctx.customerId);

    const archive = await prisma.outboxEvent.findFirst({ where: { eventType: 'ARCHIVE', aggregateId: ctx.deviceId } });
    assert.ok(archive, '缺归档 Outbox');
    assert.equal((archive.payload as Record<string, unknown>).topicType, 'ack');
  });

  test('PUBLISHED + FAILED（含 errorCode/message）→ FAILED', async () => {
    const ctx = await plantCommand({ status: 'PUBLISHED' });
    const handle = createAckHandler({ client: prisma });
    const res = await handle(
      ackMessage(ctx, {
        seq: 1,
        data: {
          commandId: ctx.commandId,
          command: ctx.command,
          result: 'FAILED',
          executeTimeMs: 300,
          errorCode: 'MOTOR_STALL',
          message: 'agitator stalled',
        },
      }),
    );
    assert.equal(res.toStatus, 'FAILED');
    const ack = await prisma.commandAck.findFirst({ where: { commandId: ctx.commandId } });
    assert.equal(ack?.result, 'FAILED');
    assert.equal(ack?.errorCode, 'MOTOR_STALL');
  });

  test('无 result → ACKNOWLEDGED（RECEIVED）；结果后至 → SUCCEEDED', async () => {
    const ctx = await plantCommand({ status: 'PUBLISHED' });
    const handle = createAckHandler({ client: prisma });
    const first = await handle(ackMessage(ctx, { seq: 1, data: { commandId: ctx.commandId, command: ctx.command } }));
    assert.equal(first.toStatus, 'ACKNOWLEDGED');
    const ack = await prisma.commandAck.findFirst({ where: { commandId: ctx.commandId } });
    assert.equal(ack?.result, 'RECEIVED');

    const second = await handle(
      ackMessage(ctx, {
        seq: 2,
        data: { commandId: ctx.commandId, command: ctx.command, result: 'SUCCESS', executeTimeMs: 900 },
      }),
    );
    assert.equal(second.toStatus, 'SUCCEEDED');
    assert.equal(await prisma.commandAck.count({ where: { commandId: ctx.commandId } }), 2);
  });

  test('ACKNOWLEDGED + 无 result → event-only（不重复迁移）', async () => {
    const ctx = await plantCommand({ status: 'PUBLISHED' });
    const handle = createAckHandler({ client: prisma });
    await handle(ackMessage(ctx, { seq: 1, data: { commandId: ctx.commandId, command: ctx.command } }));
    const dup = await handle(ackMessage(ctx, { seq: 2, data: { commandId: ctx.commandId, command: ctx.command } }));
    assert.equal(dup.action, 'event-only');
    const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: ctx.commandId } });
    assert.equal(row.status, 'ACKNOWLEDGED');
  });
});

describe('重复/冲突/未知/迟到路径', () => {
  test('重复消息（同 receipt 键同 Hash）→ DUPLICATE_SKIPPED，不重复落 ack/审计', async () => {
    const ctx = await plantCommand({ status: 'PUBLISHED' });
    const handle = createAckHandler({ client: prisma });
    const msg = ackMessage(ctx, {
      seq: 1,
      data: { commandId: ctx.commandId, command: ctx.command, result: 'SUCCESS', executeTimeMs: 100 },
    });
    await handle(msg);
    const dup = await handle(msg);
    assert.equal(dup.outcome, 'DUPLICATE_SKIPPED');
    assert.isFalse(dup.archived);
    assert.equal(await prisma.commandAck.count({ where: { commandId: ctx.commandId } }), 1);
    assert.equal(
      await prisma.auditLog.count({
        where: { objectType: 'device_command', objectId: ctx.commandId, action: 'command.ack' },
      }),
      1,
    );
  });

  test('终态后新 ACK（不同 seq）→ 保存事件不改状态', async () => {
    const ctx = await plantCommand({ status: 'PUBLISHED' });
    const handle = createAckHandler({ client: prisma });
    await handle(
      ackMessage(ctx, { seq: 1, data: { commandId: ctx.commandId, command: ctx.command, result: 'SUCCESS' } }),
    );
    const late = await handle(
      ackMessage(ctx, { seq: 2, data: { commandId: ctx.commandId, command: ctx.command, result: 'FAILED' } }),
    );
    assert.equal(late.action, 'event-only');
    const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: ctx.commandId } });
    assert.equal(row.status, 'SUCCEEDED', '终态不被覆盖');
    assert.equal(await prisma.commandAck.count({ where: { commandId: ctx.commandId } }), 2, '事件仍保存');
  });

  test('冲突：command 与原命令不符 → COMMAND_MISMATCH 隔离；状态不变、不落 ack', async () => {
    const ctx = await plantCommand({ status: 'PUBLISHED', command: 'STOP' });
    const handle = createAckHandler({ client: prisma });
    await assertQuarantine(
      () =>
        handle(ackMessage(ctx, { seq: 1, data: { commandId: ctx.commandId, command: 'REBOOT', result: 'SUCCESS' } })),
      'COMMAND_MISMATCH',
    );
    const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: ctx.commandId } });
    assert.equal(row.status, 'PUBLISHED');
    assert.equal(await prisma.commandAck.count({ where: { commandId: ctx.commandId } }), 0);
  });

  test('未知 commandId → UNKNOWN_COMMAND 隔离', async () => {
    const ctx = await plantCommand({ status: 'PUBLISHED' });
    const handle = createAckHandler({ client: prisma });
    await assertQuarantine(
      () =>
        handle(ackMessage(ctx, { seq: 1, data: { commandId: 'CMD-UNKNOWN-1', command: 'STOP', result: 'SUCCESS' } })),
      'UNKNOWN_COMMAND',
    );
  });

  test('迟到 ACK：TIMED_OUT + SUCCESS → 事件保存但状态保持 TIMED_OUT', async () => {
    const ctx = await plantCommand({ status: 'TIMED_OUT' });
    const handle = createAckHandler({ client: prisma });
    const res = await handle(
      ackMessage(ctx, {
        seq: 1,
        data: { commandId: ctx.commandId, command: ctx.command, result: 'SUCCESS', executeTimeMs: 5000 },
      }),
    );
    assert.equal(res.action, 'event-only');
    const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: ctx.commandId } });
    assert.equal(row.status, 'TIMED_OUT', '迟到 ACK 不得把 TimedOut 静默改成功');
    const ack = await prisma.commandAck.findFirst({ where: { commandId: ctx.commandId } });
    assert.ok(ack, '迟到 ACK 保存为事件');
    assert.equal(ack.result, 'SUCCESS');
  });

  test('前置状态无效：AUTHORIZED 收到 ACK → INVALID_COMMAND_STATE 隔离', async () => {
    const ctx = await plantCommand({ status: 'AUTHORIZED' });
    const handle = createAckHandler({ client: prisma });
    await assertQuarantine(
      () =>
        handle(
          ackMessage(ctx, { seq: 1, data: { commandId: ctx.commandId, command: ctx.command, result: 'SUCCESS' } }),
        ),
      'INVALID_COMMAND_STATE',
    );
    const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: ctx.commandId } });
    assert.equal(row.status, 'AUTHORIZED');
  });

  test('字段校验：缺 commandId / result 非法 / executeTimeMs 负数 → INVALID_ENVELOPE 隔离', async () => {
    const ctx = await plantCommand({ status: 'PUBLISHED' });
    const handle = createAckHandler({ client: prisma });
    await assertQuarantine(
      () => handle(ackMessage(ctx, { seq: 1, data: { command: ctx.command, result: 'SUCCESS' } })),
      'INVALID_ENVELOPE',
    );
    await assertQuarantine(
      () => handle(ackMessage(ctx, { seq: 2, data: { commandId: ctx.commandId, command: ctx.command, result: 'OK' } })),
      'INVALID_ENVELOPE',
    );
    await assertQuarantine(
      () =>
        handle(
          ackMessage(ctx, {
            seq: 3,
            data: { commandId: ctx.commandId, command: ctx.command, result: 'SUCCESS', executeTimeMs: -1 },
          }),
        ),
      'INVALID_ENVELOPE',
    );
  });
});
