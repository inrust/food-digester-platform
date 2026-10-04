import { rejects } from 'node:assert/strict';
/**
 * BE-IOT-03 幂等、序号缺口与收据模块验收（PGlite 真实 PostgreSQL + DB-01 表结构）。
 *
 * 验收基准覆盖：
 * - 相同键相同 Hash 只处理一次（顺序重复 + 并发重复）；
 * - 相同键不同 Hash 标为安全异常（PAYLOAD_CONFLICT 隔离，原 receipt 不覆盖）；
 * - 业务写入、receipt、outbox 同一事务（business 失败全回滚）；
 * - 缺口检测/解除/状态查询；缺口不阻塞后续消息；
 * - 5% 重复 + 2% 乱序下无重复业务记录。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import { withTransaction, type DbClient, type PrismaClient } from '@fdp/database';
import { withDataPathTrace, observeRecordResult } from '@fdp/observability';
import { IngestError, gapStatus, hashPayload, idempotencyKeyOf, processWithReceipt } from '../src/index.js';
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

const RECEIVED_AT_MS = Date.parse('2026-08-28T02:00:00.000Z');

let seqCounter = 0;
function nextDeviceId(): string {
  seqCounter += 1;
  return `dev-rcpt-${seqCounter}`;
}

function telemetryPayload(deviceId: string, seq: number): Record<string, unknown> {
  return {
    meta: { id: `TEL-${deviceId}-${seq}`, ts: '2026-08-28T02:00:00.000Z', seq, schemaVer: '1.0' },
    data: { temperatureC: 42.5, seqEcho: seq },
  };
}

/** 业务写入：以 outbox_events 作为可计数的业务记录槽（每 seq 一条）。 */
async function businessWrite(tx: DbClient, deviceId: string, seq: number): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      eventType: 'TELEMETRY_ARCHIVED',
      aggregateType: 'device',
      aggregateId: deviceId,
      payload: { seq },
    },
  });
}

async function businessCount(deviceId: string): Promise<number> {
  return prisma.outboxEvent.count({ where: { eventType: 'TELEMETRY_ARCHIVED', aggregateId: deviceId } });
}

describe('processWithReceipt（BE-IOT-03 幂等收据）', () => {
  test('首次处理：receipt + business + outbox 同事务落库，outcome=PROCESSED', async () => {
    const deviceId = nextDeviceId();
    const payload = telemetryPayload(deviceId, 1);
    const outcome = await processWithReceipt(prisma, {
      key: { deviceId, topicType: 'telemetry', seq: 1 },
      payloadHash: hashPayload(payload),
      receivedAtMs: RECEIVED_AT_MS,
      business: (tx) => businessWrite(tx, deviceId, 1),
    });
    assert.equal(outcome.outcome, 'PROCESSED');

    const receipt = await prisma.ingestionReceipt.findFirst({
      where: { idempotencyKey: idempotencyKeyOf({ deviceId, topicType: 'telemetry', seq: 1 }) },
    });
    assert.ok(receipt);
    assert.equal(receipt.result, 'PROCESSED');
    assert.equal(receipt.payloadHash, hashPayload(payload));
    assert.equal(receipt.receivedAt.toISOString(), '2026-08-28T02:00:00.000Z');
    assert.ok(receipt.processedAt);
    assert.equal(await businessCount(deviceId), 1);
  });

  test('相同键相同 Hash 只处理一次：顺序重复跳过；并发重复恰好一个 PROCESSED', async () => {
    const deviceId = nextDeviceId();
    const payload = telemetryPayload(deviceId, 7);
    const hash = hashPayload(payload);
    const key = { deviceId, topicType: 'telemetry', seq: 7 } as const;
    let businessCalls = 0;
    const params = () => ({
      key,
      payloadHash: hash,
      business: async (tx: DbClient) => {
        businessCalls += 1;
        await businessWrite(tx, deviceId, 7);
      },
    });

    const first = await processWithReceipt(prisma, params());
    const second = await processWithReceipt(prisma, params());
    assert.equal(first.outcome, 'PROCESSED');
    assert.equal(second.outcome, 'DUPLICATE_SKIPPED');
    assert.equal(businessCalls, 1, '重复消息不得再次执行业务写入');

    const concurrent = await Promise.all(Array.from({ length: 8 }, () => processWithReceipt(prisma, params())));
    assert.equal(concurrent.filter((r) => r.outcome === 'PROCESSED').length, 0, '键已存在，全部为重复');
    assert.equal(concurrent.filter((r) => r.outcome === 'DUPLICATE_SKIPPED').length, 8);
    assert.equal(businessCalls, 1);
    assert.equal(await businessCount(deviceId), 1, '无重复业务记录');
    assert.equal(await prisma.ingestionReceipt.count({ where: { idempotencyKey: idempotencyKeyOf(key) } }), 1);
  });

  test('相同键不同 Hash 标为安全异常：PAYLOAD_CONFLICT 隔离，原 receipt 不覆盖', async () => {
    const deviceId = nextDeviceId();
    const key = { deviceId, topicType: 'telemetry', seq: 3 } as const;
    const originalHash = hashPayload(telemetryPayload(deviceId, 3));
    await processWithReceipt(prisma, {
      key,
      payloadHash: originalHash,
      business: (tx) => businessWrite(tx, deviceId, 3),
    });

    let conflictError: unknown;
    try {
      await processWithReceipt(prisma, {
        key,
        payloadHash: hashPayload({ meta: { seq: 3 }, data: { tampered: true } }),
        business: (tx) => businessWrite(tx, deviceId, 3),
      });
    } catch (err) {
      conflictError = err;
    }
    assert.ok(conflictError instanceof IngestError);
    assert.equal(conflictError.classification, 'QUARANTINE');
    assert.equal(conflictError.errorType, 'PAYLOAD_CONFLICT');

    const receipt = await prisma.ingestionReceipt.findFirst({
      where: { idempotencyKey: idempotencyKeyOf(key) },
    });
    assert.equal(receipt?.payloadHash, originalHash, '原 receipt 不得被覆盖');
    assert.equal(await businessCount(deviceId), 1, '冲突消息不得产生业务记录');
  });

  test('事务原子性：business 失败时 receipt 与 outbox 全部回滚', async () => {
    const deviceId = nextDeviceId();
    let thrown: unknown;
    try {
      await processWithReceipt(prisma, {
        key: { deviceId, topicType: 'telemetry', seq: 1 },
        payloadHash: hashPayload(telemetryPayload(deviceId, 1)),
        business: async () => {
          throw new Error('simulated business failure');
        },
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error);
    assert.equal(await prisma.ingestionReceipt.count({ where: { deviceId } }), 0);
    assert.equal(await businessCount(deviceId), 0);
  });

  test('缺口检测/解除/状态查询：乱序到达不阻塞后续消息，补齐后缺口解除', async () => {
    const deviceId = nextDeviceId();
    const ingest = async (seq: number) =>
      processWithReceipt(prisma, {
        key: { deviceId, topicType: 'telemetry', seq },
        payloadHash: hashPayload(telemetryPayload(deviceId, seq)),
        business: (tx) => businessWrite(tx, deviceId, seq),
      });

    await ingest(1);
    await ingest(2);
    assert.deepEqual(await gapStatus(prisma, { deviceId, topicType: 'telemetry' }), []);

    // seq 5 跳序到达：缺口 [3,4]，但本条正常处理（缺口不阻塞）
    const jumped = await ingest(5);
    assert.equal(jumped.outcome, 'PROCESSED');
    const open = await gapStatus(prisma, { deviceId, topicType: 'telemetry' });
    assert.equal(open.length, 1);
    assert.equal(open[0]?.missingFromSeq, 3);
    assert.equal(open[0]?.missingToSeq, 4);

    // 缺口期间后续消息照常处理
    await ingest(6);
    assert.equal(await businessCount(deviceId), 4);

    // 迟到补齐：先 4（部分填充，缺口仍在）后 3（全覆盖，解除）
    await ingest(4);
    assert.equal((await gapStatus(prisma, { deviceId, topicType: 'telemetry' })).length, 1);
    await ingest(3);
    assert.deepEqual(await gapStatus(prisma, { deviceId, topicType: 'telemetry' }), []);
    const resolved = await prisma.ingestionGap.findFirst({ where: { deviceId } });
    assert.ok(resolved?.resolvedAt);
    assert.equal(await businessCount(deviceId), 6);
  });

  test('不同 seq 并发首处理：无论锁顺序均补建完整缺口', async () => {
    const deviceId = nextDeviceId();
    const ingest = (seq: number) =>
      processWithReceipt(prisma, {
        key: { deviceId, topicType: 'telemetry', seq },
        payloadHash: hashPayload(telemetryPayload(deviceId, seq)),
        business: (tx) => businessWrite(tx, deviceId, seq),
      });
    await Promise.all([ingest(1), ingest(5)]);
    const gaps = await gapStatus(prisma, { deviceId, topicType: 'telemetry' });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.missingFromSeq, 2);
    assert.equal(gaps[0]?.missingToSeq, 4);
  });

  test('5% 重复 + 2% 乱序模拟：无重复业务记录，全部到达后无未解除缺口', async () => {
    const deviceId = nextDeviceId();
    const TOTAL = 200;
    // 确定性 PRNG（mulberry32）
    let state = 0x2f6e2b1;
    const random = () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // 2% 乱序：交换 4 对相邻位置
    const order = Array.from({ length: TOTAL }, (_, i) => i + 1);
    for (let i = 0; i < Math.floor(TOTAL * 0.02); i += 1) {
      const idx = Math.floor(random() * (TOTAL - 1));
      const a = order[idx];
      const b = order[idx + 1];
      if (a !== undefined && b !== undefined) {
        order[idx] = b;
        order[idx + 1] = a;
      }
    }
    // 5% 重复：随机复制 10 条插入随机位置
    const stream = [...order];
    for (let i = 0; i < Math.floor(TOTAL * 0.05); i += 1) {
      const dup = order[Math.floor(random() * TOTAL)];
      if (dup !== undefined) stream.splice(Math.floor(random() * stream.length), 0, dup);
    }

    const callsPerSeq = new Map<number, number>();
    let processed = 0;
    let skipped = 0;
    for (const seq of stream) {
      const outcome = await processWithReceipt(prisma, {
        key: { deviceId, topicType: 'telemetry', seq },
        payloadHash: hashPayload(telemetryPayload(deviceId, seq)),
        business: (tx) => businessWrite(tx, deviceId, seq),
      });
      if (outcome.outcome === 'PROCESSED') {
        processed += 1;
        callsPerSeq.set(seq, (callsPerSeq.get(seq) ?? 0) + 1);
      } else {
        skipped += 1;
      }
    }

    assert.equal(processed, TOTAL, '每个唯一 seq 恰好处理一次');
    assert.equal(skipped, stream.length - TOTAL, '重复投递全部被跳过');
    for (const [seq, count] of callsPerSeq) {
      assert.equal(count, 1, `seq ${seq} 业务写入重复`);
    }
    assert.equal(await businessCount(deviceId), TOTAL, '无重复业务记录');
    assert.equal(await prisma.ingestionReceipt.count({ where: { deviceId } }), TOTAL, '每个唯一键恰好一条 receipt');
    assert.deepEqual(await gapStatus(prisma, { deviceId, topicType: 'telemetry' }), [], '乱序缺口全部解除');
  });
});

test('phase evidence closes after root COMMIT; redelivery correlates to original receipt and rollback never reports completion', async () => {
  const deviceId = nextDeviceId();
  const rows: Record<string, unknown>[] = [];
  const params = {
    key: { deviceId, topicType: 'telemetry', seq: 1 },
    payloadHash: 'a'.repeat(64),
    business: (tx: DbClient) => businessWrite(tx, deviceId, 1),
  };
  const run = (sqsMessageId: string) =>
    withDataPathTrace(
      { sqsMessageId, deviceId },
      async () => {
        const result = await processWithReceipt(prisma, params);
        // Independent root-client read after processWithReceipt returns establishes durability.
        assert.equal(await businessCount(deviceId), 1);
        observeRecordResult('PROCESSED');
        return result;
      },
      (row) => rows.push(row),
    );
  assert.equal((await run('sqs-first')).outcome, 'PROCESSED');
  assert.equal((await run('sqs-redelivery')).outcome, 'DUPLICATE_SKIPPED');
  const receipt = await prisma.ingestionReceipt.findFirstOrThrow({ where: { deviceId } });
  const completions = rows.filter((r) => r.event === 'ingestion.receipt.completed');
  assert.equal(completions.length, 2);
  assert.isTrue(completions.every((r) => r.receiptId === receipt.id && r.commitScope === 'ROOT_TRANSACTION_COMPLETED'));
  assert.deepEqual(
    completions.map((r) => r.sqsMessageId),
    ['sqs-first', 'sqs-redelivery'],
  );
  const firstCommit = rows.findIndex((r) => r.event === 'ingestion.receipt.completed');
  const transactionPhase = rows.findIndex((r) => r.phase === 'db-transaction' && r.outcome === 'PASS');
  assert.isAbove(firstCommit, transactionPhase);
  const failingId = nextDeviceId();
  const failed: Record<string, unknown>[] = [];
  await rejects(
    withDataPathTrace(
      { sqsMessageId: 'sqs-failure' },
      () =>
        processWithReceipt(prisma, {
          ...params,
          key: { ...params.key, deviceId: failingId },
          business: async (tx) => {
            await businessWrite(tx, failingId, 1);
            throw Error('private payload');
          },
        }),
      (row) => failed.push(row),
    ),
  );
  assert.equal(await businessCount(failingId), 0);
  assert.equal(await prisma.ingestionReceipt.count({ where: { deviceId: failingId } }), 0);
  assert.isFalse(failed.some((r) => r.event === 'ingestion.receipt.completed'));
  assert.isTrue(failed.some((r) => r.phase === 'db-transaction' && r.outcome === 'FAIL'));
  assert.notInclude(JSON.stringify(failed), 'private payload');
});

test('nested transaction phase is callback-only and later outer rollback invalidates its writes', async () => {
  const deviceId = nextDeviceId();
  const rows: Record<string, unknown>[] = [];
  await rejects(
    withDataPathTrace(
      { deviceId },
      () =>
        withTransaction(prisma, async (tx) => {
          await processWithReceipt(tx, {
            key: { deviceId, topicType: 'telemetry', seq: 1 },
            payloadHash: 'b'.repeat(64),
            business: (inner) => businessWrite(inner, deviceId, 1),
          });
          throw Error('outer rollback');
        }),
      (row) => rows.push(row),
    ),
  );
  assert.equal(
    rows.find((r) => r.event === 'ingestion.receipt.completed')!.commitScope,
    'ENCLOSING_TRANSACTION_CALLBACK_ONLY',
  );
  assert.equal(await businessCount(deviceId), 0);
  assert.equal(await prisma.ingestionReceipt.count({ where: { deviceId } }), 0);
});
