import { assert, describe, expect, test, vi } from 'vitest';
import type { DbClient } from '@fdp/database';
import { createReplayIngressSink } from '../src/replay/ingress-sink.js';
import { createReplayTriggerPublisher } from '../src/replay/trigger-publisher.js';
import { createReplaySqsHandler } from '../src/runtime/replay-entry.js';

describe('Replay production runtime', () => {
  test('Ingress sink 使用当前 ACTIVE 证书 ARN，并恢复 IoT Rule 扁平 envelope', async () => {
    const findFirst = vi.fn(async (_args: { where: Record<string, unknown>; orderBy: Record<string, unknown> }) => ({
      id: 'cert-active-1',
    }));
    const send = vi.fn(async (_message: unknown) => undefined);
    const sink = createReplayIngressSink({
      client: { deviceCertificate: { findFirst } } as unknown as DbClient,
      sender: { send },
      partition: 'aws',
      region: 'ap-southeast-1',
      accountId: '123456789012',
      now: () => new Date('2026-09-07T00:00:00.000Z'),
    });
    await sink.send({
      iotTopic: 'bnx/device/dev-1/telemetry',
      iotDeviceId: 'dev-1',
      iotType: 'telemetry',
      iotReceivedAt: 123,
      payload: { meta: { id: 'TEL-1', seq: 7 }, data: { value: 1 } },
    });

    assert.deepEqual(send.mock.calls[0]?.[0], {
      meta: { id: 'TEL-1', seq: 7 },
      data: { value: 1 },
      iotTopic: 'bnx/device/dev-1/telemetry',
      iotDeviceId: 'dev-1',
      iotType: 'telemetry',
      iotReceivedAt: 123,
      iotPrincipal: 'arn:aws:iot:ap-southeast-1:123456789012:cert/cert-active-1',
    });
    assert.deepEqual(findFirst.mock.calls[0]?.[0].where, {
      deviceId: 'dev-1',
      status: 'ACTIVE',
      revokedAt: null,
      notBefore: { lte: new Date('2026-09-07T00:00:00.000Z') },
      notAfter: { gt: new Date('2026-09-07T00:00:00.000Z') },
    });
  });

  test('缺少 ACTIVE 证书时失败关闭，不发送伪造 principal', async () => {
    const send = vi.fn(async (_message: unknown) => undefined);
    const sink = createReplayIngressSink({
      client: { deviceCertificate: { findFirst: vi.fn(async () => null) } } as unknown as DbClient,
      sender: { send },
      partition: 'aws',
      region: 'ap-southeast-1',
      accountId: '123456789012',
    });
    await expect(
      sink.send({
        iotTopic: 'bnx/device/dev-1/report',
        iotDeviceId: 'dev-1',
        iotType: 'report',
        iotReceivedAt: 123,
        payload: { meta: { id: 'RPT-1' }, data: {} },
      }),
    ).rejects.toThrow(/No ACTIVE certificate/u);
    assert.equal(send.mock.calls.length, 0);
  });

  test('触发发布器只领取 Replay Outbox，成功后原子标记 published', async () => {
    const findMany = vi.fn(async (_args: Record<string, unknown>) => [
      { id: 'outbox-1', aggregateId: 'job-1', retryCount: 0 },
    ]);
    const updateMany = vi.fn(async (_args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
      count: 1,
    }));
    const send = vi.fn(async (_message: unknown) => undefined);
    const publisher = createReplayTriggerPublisher({
      client: { outboxEvent: { findMany, updateMany } } as unknown as DbClient,
      sender: { send },
      now: () => new Date('2026-09-07T00:00:00.000Z'),
    });
    assert.deepEqual(await publisher.publishPendingBatch(), { claimed: 1, published: 1, retried: 0, failed: 0 });
    assert.deepEqual(findMany.mock.calls[0]?.[0].where, { status: 'PENDING', eventType: 'REPLAY_JOB_REQUESTED' });
    assert.deepEqual(send.mock.calls[0]?.[0], { jobId: 'job-1' });
    assert.deepEqual(updateMany.mock.calls[0]?.[0].where, { id: 'outbox-1', status: 'PENDING' });
  });

  test('Replay SQS 使用 partial batch response 隔离坏消息和执行失败', async () => {
    const executeJob = vi.fn(async (jobId: string) => {
      if (jobId === 'job-fail') throw new Error('failed');
    });
    const handler = createReplaySqsHandler({ executeJob });
    const response = await handler({
      Records: [
        { messageId: 'sqs-good', body: JSON.stringify({ jobId: 'job-good' }) },
        { messageId: 'sqs-fail', body: JSON.stringify({ jobId: 'job-fail' }) },
        { messageId: 'sqs-invalid', body: '{}' },
      ],
    });
    assert.deepEqual(response.batchItemFailures, [{ itemIdentifier: 'sqs-fail' }, { itemIdentifier: 'sqs-invalid' }]);
  });
});
