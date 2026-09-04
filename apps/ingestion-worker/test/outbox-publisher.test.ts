/**
 * BE-ARC-01 Transactional Outbox Publisher 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 进程在发送前中断不丢事件（PENDING 保留，下轮补发）；
 * - 进程在发送后中断不丢事件（重复投递由下游按稳定 eventId 去重，不产生重复归档对象记录）；
 * - 发布失败原子记录重试信息（retryCount/lastError），达到上限标记 FAILED 不再领取；
 * - 发布失败不影响已提交业务记录；单条失败不阻塞批次内其他事件。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ArchiveEventMessage, ArchiveEventSender } from '@fdp/aws-clients';
import { createOutboxPublisher } from '../src/index.js';
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

let seqCounter = 0;
/** 模拟"已提交业务记录 + 同事务 outbox 事件"（BE-IOT-03 receipt 事务的提交结果）。 */
async function plantCommittedBusinessWithOutbox(count: number) {
  seqCounter += 1;
  const deviceId = `dev-pub-${seqCounter}`;
  const customer = await prisma.customer.create({ data: { name: `Customer PUB ${seqCounter}` } });
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-PUB-${seqCounter}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
    },
  });
  const eventIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const event = await prisma.deviceEvent.create({
      data: {
        deviceId,
        customerId: customer.id,
        eventType: 'MANUAL_FEEDING',
        occurredAt: new Date('2026-08-28T10:00:00Z'),
        sourceMessageId: `EVT-PUB-${seqCounter}-${i}`,
      },
    });
    const outbox = await prisma.outboxEvent.create({
      data: {
        eventType: 'ARCHIVE',
        aggregateType: 'device',
        aggregateId: deviceId,
        payload: { topicType: 'event', messageId: `EVT-PUB-${seqCounter}-${i}`, deviceEventId: event.id },
      },
    });
    eventIds.push(outbox.id);
  }
  return { deviceId, customerId: customer.id, eventIds };
}

class RecordingSender implements ArchiveEventSender {
  readonly sent: ArchiveEventMessage[] = [];
  /** 下游归档对象去重表（按 eventId）。 */
  readonly archiveObjects = new Set<string>();
  private failOn: ((message: ArchiveEventMessage, callIndex: number) => boolean) | null = null;

  setFailure(pred: ((message: ArchiveEventMessage, callIndex: number) => boolean) | null): void {
    this.failOn = pred;
  }

  async send(message: ArchiveEventMessage): Promise<void> {
    if (this.failOn?.(message, this.sent.length)) {
      throw new Error(`SQS send failed for ${message.eventId}`);
    }
    this.sent.push(message);
    this.archiveObjects.add(message.eventId); // 下游按稳定 eventId 去重
  }
}

function publisher(sender: ArchiveEventSender, options: { maxAttempts?: number } = {}) {
  return createOutboxPublisher({ client: prisma, sender, maxAttempts: options.maxAttempts });
}

describe('createOutboxPublisher（BE-ARC-01）', () => {
  test('DEC-016：只领取 ARCHIVE，License 通知等其它待发布事件保持原队列', async () => {
    const notification = await prisma.outboxEvent.create({
      data: {
        eventType: 'LICENSE_CHANGED',
        aggregateType: 'license',
        aggregateId: 'license-notification-only',
        payload: { data: { type: 'LICENSE_CHANGED', action: 'SYNC' } },
      },
    });
    const sender = new RecordingSender();
    const result = await publisher(sender).publishPendingBatch();
    assert.equal(result.claimed, 0);
    assert.equal(sender.sent.length, 0);
    assert.equal((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: notification.id } })).status, 'PENDING');
  });

  test('批量发布：稳定事件 ID + 原子记录 publishedAt；已发布不再领取', async () => {
    const { deviceId, eventIds } = await plantCommittedBusinessWithOutbox(3);
    const sender = new RecordingSender();

    const first = await publisher(sender).publishPendingBatch();
    assert.deepEqual(
      { claimed: first.claimed, published: first.published, retried: first.retried, failed: first.failed },
      { claimed: 3, published: 3, retried: 0, failed: 0 },
    );
    assert.equal(sender.sent.length, 3);
    for (const message of sender.sent) {
      assert.include(eventIds, message.eventId, '事件 ID 稳定（= outbox 行 id）');
      assert.equal(message.eventType, 'ARCHIVE');
      assert.equal(message.aggregateId, deviceId);
    }
    const rows = await prisma.outboxEvent.findMany({ where: { id: { in: eventIds } } });
    for (const row of rows) {
      assert.equal(row.status, 'PUBLISHED');
      assert.ok(row.publishedAt, '发布时间必须原子记录');
      assert.equal(row.retryCount, 0);
    }

    const second = await publisher(sender).publishPendingBatch();
    assert.equal(second.claimed, 0, '已发布事件不再领取');
    assert.equal(sender.sent.length, 3);
  });

  test('发送前中断：事件保持 PENDING，下轮补发不丢', async () => {
    const { eventIds } = await plantCommittedBusinessWithOutbox(2);
    const sender = new RecordingSender();
    sender.setFailure(() => true); // 进程在发送前崩溃（无任何投递）

    const crashed = await publisher(sender).publishPendingBatch();
    assert.equal(crashed.published, 0);
    assert.equal(sender.sent.length, 0, '崩溃前无投递');
    for (const row of await prisma.outboxEvent.findMany({ where: { id: { in: eventIds } } })) {
      assert.equal(row.status, 'PENDING', '中断后事件不得丢失（保持待发布）');
    }

    sender.setFailure(null); // 进程重启
    const recovered = await publisher(sender).publishPendingBatch();
    assert.equal(recovered.published, 2, '重启后补发全部未发布事件');
    assert.equal(sender.sent.length, 2);
  });

  test('发送后中断：重复投递由下游按 eventId 去重，不产生重复归档对象记录', async () => {
    const { eventIds } = await plantCommittedBusinessWithOutbox(1);
    const sender = new RecordingSender();

    // 第一次：send 成功但随后进程"中断"——模拟为 send 记录投递后抛错（Publisher 视为失败，不标记 PUBLISHED）
    sender.setFailure((message) => {
      sender.sent.push(message);
      sender.archiveObjects.add(message.eventId);
      return true; // 再抛错：发送已发生、标记未发生
    });
    const crashed = await publisher(sender).publishPendingBatch();
    assert.equal(crashed.published, 0);
    assert.equal(sender.sent.length, 1, '发送后中断：投递已发生但状态未标记');
    assert.equal((await prisma.outboxEvent.findFirst({ where: { id: eventIds[0] } }))?.status, 'PENDING');

    // 重启后补发 → 重复投递；下游去重
    sender.setFailure(null);
    const recovered = await publisher(sender).publishPendingBatch();
    assert.equal(recovered.published, 1);
    assert.equal(sender.sent.length, 2, '同一事件被投递两次（at-least-once）');
    assert.equal(sender.archiveObjects.size, 1, '下游按稳定 eventId 去重：不产生重复归档对象记录');
    assert.equal((await prisma.outboxEvent.findFirst({ where: { id: eventIds[0] } }))?.status, 'PUBLISHED');
  });

  test('重试信息原子记录：retryCount 递增 + lastError；达到 maxAttempts 标记 FAILED 不再领取', async () => {
    const { eventIds } = await plantCommittedBusinessWithOutbox(1);
    const sender = new RecordingSender();
    sender.setFailure(() => true);

    const first = await publisher(sender, { maxAttempts: 2 }).publishPendingBatch();
    assert.equal(first.retried, 1);
    let row = await prisma.outboxEvent.findFirst({ where: { id: eventIds[0] } });
    assert.equal(row?.status, 'PENDING');
    assert.equal(row?.retryCount, 1, '重试计数原子记录');
    assert.include(row?.lastError ?? '', 'SQS send failed', '最近错误原子记录');

    const second = await publisher(sender, { maxAttempts: 2 }).publishPendingBatch();
    assert.equal(second.failed, 1);
    row = await prisma.outboxEvent.findFirst({ where: { id: eventIds[0] } });
    assert.equal(row?.status, 'FAILED', '达到上限标记 FAILED');
    assert.equal(row?.retryCount, 2);

    const third = await publisher(sender).publishPendingBatch();
    assert.equal(third.claimed, 0, 'FAILED 不再自动领取（人工处置归边界外）');
  });

  test('单条失败不阻塞批次内其他事件；发布失败不影响已提交业务记录', async () => {
    const { deviceId, eventIds } = await plantCommittedBusinessWithOutbox(3);
    const sender = new RecordingSender();
    // 按 createdAt 顺序中间一条失败
    sender.setFailure((message) => message.eventId === eventIds[1]);

    const result = await publisher(sender).publishPendingBatch();
    assert.deepEqual(
      { claimed: result.claimed, published: result.published, retried: result.retried, failed: result.failed },
      { claimed: 3, published: 2, retried: 1, failed: 0 },
      '单条失败不阻塞批次内其他事件',
    );
    const rows = await prisma.outboxEvent.findMany({ where: { id: { in: eventIds } } });
    const statusOf = new Map(rows.map((row) => [row.id, row.status]));
    assert.equal(statusOf.get(eventIds[0] ?? ''), 'PUBLISHED');
    assert.equal(statusOf.get(eventIds[1] ?? ''), 'PENDING');
    assert.equal(statusOf.get(eventIds[2] ?? ''), 'PUBLISHED');

    // 发布失败不影响已提交业务记录（receipt 事务早已提交）
    assert.equal(await prisma.deviceEvent.count({ where: { deviceId } }), 3, '已提交业务记录不受发布失败影响');

    // 失败事件下轮补发成功
    sender.setFailure(null);
    const recovered = await publisher(sender).publishPendingBatch();
    assert.equal(recovered.published, 1);
    assert.equal((await prisma.outboxEvent.findFirst({ where: { id: eventIds[1] } }))?.status, 'PUBLISHED');
  });
});
