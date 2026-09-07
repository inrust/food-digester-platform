import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { assert, describe, test } from 'vitest';
import { createSqsJsonSender } from '../src/sqs-json-sender.js';

describe('SQS JSON 生产适配器', () => {
  test('向指定隔离队列发送确定性 JSON 消息', async () => {
    const calls: unknown[] = [];
    const client = { send: async (command: unknown) => void calls.push(command) } as unknown as SQSClient;
    const sender = createSqsJsonSender({ queueUrl: 'https://sqs.example/quarantine', client });

    await sender.send({ errorType: 'INVALID_ENVELOPE', sourceMessageId: 'sqs-1' });

    assert.equal(calls.length, 1);
    assert.instanceOf(calls[0], SendMessageCommand);
    assert.deepEqual((calls[0] as SendMessageCommand).input, {
      QueueUrl: 'https://sqs.example/quarantine',
      MessageBody: '{"errorType":"INVALID_ENVELOPE","sourceMessageId":"sqs-1"}',
    });
  });
});
