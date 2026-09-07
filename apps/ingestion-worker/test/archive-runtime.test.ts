import { assert, describe, test, vi } from 'vitest';
import type { ArchiveEventMessage } from '@fdp/aws-clients';
import { createArchiveSqsHandler } from '../src/runtime/archive-entry.js';

const validMessage = (eventId: string) => ({
  eventId,
  eventType: 'ARCHIVE',
  aggregateType: 'device',
  aggregateId: 'dev-1',
  payload: { topicType: 'telemetry' },
  createdAt: '2026-09-07T00:00:00.000Z',
});

describe('Archive SQS runtime', () => {
  test('非法记录与业务拒绝记录进入 partial batch failure，合法记录仍处理', async () => {
    const archiveBatch = vi.fn(async (_messages: ArchiveEventMessage[]) => ({ rejectedEventIds: ['evt-rejected'] }));
    const handler = createArchiveSqsHandler({ archiveBatch });
    const response = await handler({
      Records: [
        { messageId: 'sqs-good', body: JSON.stringify(validMessage('evt-good')) },
        { messageId: 'sqs-rejected', body: JSON.stringify(validMessage('evt-rejected')) },
        { messageId: 'sqs-invalid', body: '{bad-json' },
      ],
    });

    assert.deepEqual(response.batchItemFailures, [
      { itemIdentifier: 'sqs-invalid' },
      { itemIdentifier: 'sqs-rejected' },
    ]);
    assert.deepEqual(
      archiveBatch.mock.calls[0]?.[0].map((message: ArchiveEventMessage) => message.eventId),
      ['evt-good', 'evt-rejected'],
    );
  });

  test('S3 批处理失败时只重试本批全部结构合法记录', async () => {
    const handler = createArchiveSqsHandler({
      archiveBatch: vi.fn(async (_messages: ArchiveEventMessage[]) => {
        throw new Error('S3 down');
      }),
    });
    const response = await handler({
      Records: [
        { messageId: 'sqs-1', body: JSON.stringify(validMessage('evt-1')) },
        { messageId: 'sqs-2', body: JSON.stringify(validMessage('evt-2')) },
      ],
    });
    assert.deepEqual(response.batchItemFailures, [{ itemIdentifier: 'sqs-1' }, { itemIdentifier: 'sqs-2' }]);
  });
});
