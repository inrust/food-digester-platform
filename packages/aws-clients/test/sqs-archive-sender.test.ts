import { assert, test } from 'vitest';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsArchiveSender } from '../src/sqs-archive-sender.js';
test('bounded archive send supplies cancellation and keeps stable event IDs for retry deduplication', async () => {
  let command: SendMessageCommand | undefined, signal: AbortSignal | undefined;
  const client = {
    async send(c: SendMessageCommand, options?: { abortSignal?: AbortSignal }) {
      command = c;
      signal = options?.abortSignal;
    },
  } as unknown as SQSClient;
  const sender = createSqsArchiveSender({
    queueUrl: 'https://sqs.example/archive',
    client,
    sendTimeoutMs: 5000,
    maxAttempts: 1,
  });
  await sender.send({
    eventId: 'stable-event',
    eventType: 'ARCHIVE',
    aggregateType: 'device',
    aggregateId: 'd-1',
    payload: {},
    createdAt: '2026-10-03T00:00:00Z',
  });
  assert.equal(command?.input.MessageAttributes?.event_id.StringValue, 'stable-event');
  assert.isDefined(signal);
  assert.isFalse(signal!.aborted);
});
