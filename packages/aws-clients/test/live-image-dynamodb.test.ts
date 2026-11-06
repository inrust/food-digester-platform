import { describe, expect, test, vi } from 'vitest';
import {
  GetItemCommand,
  PutItemCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoLiveImageStore, createLazyLiveImageStoreFromEnv } from '../src/live-image-dynamodb.js';
import type { LiveImageDynamoTransport } from '../src/live-image-dynamodb.js';
import type { LiveImageControl, LiveImageFrameCommit } from '@fdp/domain';
const now = Date.parse('2026-11-06T08:00:00Z');
const control: LiveImageControl = {
  deviceId: 'camera',
  customerId: 'a',
  revision: 2,
  authEpoch: 1,
  enabled: true,
  streamId: 'stream',
  viewers: [{ actorId: 'a', viewerId: 'v', expiresAtMs: now + 30000 }],
  latestCapturedAtMs: now,
  lastNewFrameAtMs: now,
};
function fixture(response: unknown = {}) {
  const send = vi
    .fn<LiveImageDynamoTransport['send']>()
    .mockResolvedValue(response as Awaited<ReturnType<LiveImageDynamoTransport['send']>>);
  return {
    send,
    store: new DynamoLiveImageStore({
      controlTable: 'control',
      payloadTable: 'payload',
      transport: { send },
      now: () => now,
    }),
  };
}
const item = (value: object) => ({ pk: { S: 'DEVICE#camera' }, payload: { S: JSON.stringify(value) } });
const commit = (): LiveImageFrameCommit => ({
  expected: { revision: 1, authEpoch: 1 },
  control: structuredClone(control),
  frame: {
    deviceId: 'camera',
    customerId: 'a',
    authEpoch: 1,
    streamId: 'stream',
    frameId: 'frame',
    capturedAt: new Date(now).toISOString(),
    receivedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10000).toISOString(),
    mimeType: 'image/jpeg',
    imageBase64: '/9j/test',
    ttl: Math.ceil((now + 10000) / 1000),
  },
  receipt: {
    deviceId: 'camera',
    customerId: 'a',
    authEpoch: 1,
    streamId: 'stream',
    frameId: 'frame',
    requestHash: '0'.repeat(64),
    receivedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10000).toISOString(),
    dedupUntilMs: now + 15000,
    ttl: Math.ceil((now + 15000) / 1000),
  },
});
describe('IMG-08 DynamoDB SDK command boundary (no AWS)', () => {
  test('strong CONTROL read and detached decode; no local cache', async () => {
    const f = fixture({ Item: item(control) });
    expect(await f.store.readControl('camera')).toEqual(control);
    expect(f.send.mock.calls[0]![0]).toBeInstanceOf(GetItemCommand);
    expect(f.send.mock.calls[0]![0].input).toMatchObject({ ConsistentRead: true, TableName: 'control' });
    await f.store.readControl('camera');
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  test('create-if-absent / epoch+revision conditional replacement, CONTROL has no TTL', async () => {
    const f = fixture();
    await f.store.compareAndSwap('camera', { revision: 1, authEpoch: 1 }, control);
    const cmd = f.send.mock.calls[0]![0] as PutItemCommand;
    expect(cmd.input.ConditionExpression).toContain('revision = :revision AND authEpoch = :epoch');
    expect(cmd.input.Item).not.toHaveProperty('ttl');
    expect(cmd.input.Item?.activeUntilMs).toEqual({ N: String(now + 30000) });
    await f.store.compareAndSwap('camera', null, { ...control, revision: 1 });
    expect((f.send.mock.calls[1]![0] as PutItemCommand).input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });
  test.each([
    { ...control, revision: 1 },
    { ...control, deviceId: 'other' },
    { ...control, authEpoch: 0 },
  ])('rejects non-monotonic or cross-device replacement', async (next) => {
    const f = fixture();
    await expect(f.store.compareAndSwap('camera', { revision: 1, authEpoch: 1 }, next)).rejects.toThrow(
      'INVALID_CONTROL_VERSION',
    );
    expect(f.send).not.toHaveBeenCalled();
  });
  test('CONTROL + DEDUP / FRAME each use one transaction across both tables', async () => {
    const batch = commit();
    const f = fixture({ Responses: [{ Item: item(control) }, { Item: item(batch.receipt) }] });
    expect(await f.store.readUploadSnapshot('camera', 'stream', 'frame')).toEqual({ control, receipt: batch.receipt });
    const first = f.send.mock.calls[0]![0] as TransactGetItemsCommand;
    expect(first).toBeInstanceOf(TransactGetItemsCommand);
    expect(first.input.TransactItems?.map((r) => r.Get?.TableName)).toEqual(['control', 'payload']);
    expect(first.input.TransactItems?.[1]?.Get?.Key?.sk?.S).toBe('DEDUP#stream#frame');
    f.send.mockResolvedValueOnce({ Responses: [{ Item: item(control) }, { Item: item(batch.frame) }] });
    expect(await f.store.readLatestSnapshot('camera')).toEqual({ control, frame: batch.frame });
    expect((f.send.mock.calls[1]![0] as TransactGetItemsCommand).input.TransactItems?.[1]?.Get?.Key?.sk?.S).toBe(
      'FRAME',
    );
  });
  test('three records publish in one atomic transaction, with scope, watermark, lease, throttle and dedup conditions', async () => {
    const f = fixture();
    expect(await f.store.commitFrame(commit())).toBe(true);
    const cmd = f.send.mock.calls[0]![0] as TransactWriteItemsCommand;
    expect(cmd).toBeInstanceOf(TransactWriteItemsCommand);
    expect(cmd.input.TransactItems).toHaveLength(3);
    const condition = cmd.input.TransactItems![0]!.Put!.ConditionExpression!;
    for (const term of [
      'revision',
      'authEpoch',
      'customerId',
      'streamId',
      'enabled',
      'activeUntilMs > :now',
      'latestCapturedAtMs < :capture',
      'lastNewFrameAtMs <= :limit',
    ])
      expect(condition).toContain(term);
    expect(cmd.input.TransactItems![1]!.Put!.Item!.ttl).toBeDefined();
    expect(cmd.input.TransactItems![2]!.Put!.ConditionExpression).toContain('dedupUntilMs <= :now');
  });
  test.each(['lease', 'frame'] as const)('expired %s stops publication before network', async (which) => {
    const f = fixture(),
      batch = commit();
    const old =
      which === 'lease'
        ? { ...batch, control: { ...batch.control, viewers: [{ actorId: 'a', viewerId: 'v', expiresAtMs: now }] } }
        : { ...batch, frame: { ...batch.frame, expiresAt: new Date(now).toISOString() } };
    expect(await f.store.commitFrame(old)).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });
  test('conditional conflicts return false, throttling/validation/transport never do', async () => {
    const f = fixture();
    for (const error of [
      { name: 'ConditionalCheckFailedException' },
      {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      },
    ]) {
      f.send.mockRejectedValueOnce(error);
      expect(await f.store.commitFrame(commit())).toBe(false);
    }
    for (const error of [
      { name: 'TransactionCanceledException' },
      {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ProvisionedThroughputExceeded' }],
      },
      { name: 'ValidationException' },
      { name: 'AccessDeniedException' },
      new Error('transport'),
    ]) {
      f.send.mockRejectedValueOnce(error);
      await expect(f.store.commitFrame(commit())).rejects.toEqual(error);
    }
  });
  test('malformed, cross-device or partial snapshots fail closed', async () => {
    const f = fixture({ Responses: [{}] });
    await expect(f.store.readLatestSnapshot('camera')).rejects.toThrow('SNAPSHOT');
    f.send.mockResolvedValueOnce({ Item: item({ ...control, deviceId: 'other' }) });
    await expect(f.store.readControl('camera')).rejects.toThrow('RECORD');
    f.send.mockResolvedValueOnce({ Item: item({ ...control, viewers: null }) });
    await expect(f.store.readControl('camera')).rejects.toThrow('CONTROL');
  });
  test('short lease/frame deadline reaches SDK abort signal', async () => {
    const f = fixture();
    const batch = commit();
    f.send.mockImplementation(async (_command, options) => {
      return new Promise((_resolve, reject) =>
        options.abortSignal.addEventListener('abort', () => reject(new Error('deadline')), { once: true }),
      );
    });
    await expect(
      f.store.commitFrame({ ...batch, frame: { ...batch.frame, expiresAt: new Date(now + 15).toISOString() } }),
    ).rejects.toThrow('deadline');
  });
  test('no configured tables does not break legacy initialization and never becomes in-memory storage', async () => {
    const lazy = createLazyLiveImageStoreFromEnv({});
    expect(lazy).toBeDefined();
    await expect(async () => lazy.readControl('camera')).rejects.toThrow('TABLES_REQUIRED');
  });
});
test('transaction lifetime aborts in-flight I/O, rejects late responses and prevents detached callbacks using stale authorization', async () => {
  const { withLiveImageIoLifetime } = await import('@fdp/database');
  const f = fixture({ Item: item(control) });
  f.send.mockImplementationOnce(
    async (_command, options) =>
      new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => reject(new Error('lock lifetime ended')), { once: true });
      }),
  );
  await expect(withLiveImageIoLifetime(() => f.store.readControl('camera'), 25)).rejects.toThrow('lock lifetime ended');
  // Even a broken transport that ignores abort may not deliver a late snapshot to the service.
  f.send.mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { Item: item(control) };
  });
  await expect(withLiveImageIoLifetime(() => f.store.readControl('camera'), 20)).rejects.toThrow(
    'AUTHORIZATION_LIFETIME_ENDED',
  );
  let later: (() => Promise<unknown>) | undefined;
  await withLiveImageIoLifetime(async () => {
    const { AsyncResource } = await import('node:async_hooks');
    later = AsyncResource.bind(() => f.store.compareAndSwap('camera', { revision: 1, authEpoch: 1 }, control));
  });
  const calls = f.send.mock.calls.length;
  await expect(later!()).rejects.toThrow('AUTHORIZATION_LIFETIME_ENDED');
  expect(f.send).toHaveBeenCalledTimes(calls);
});
