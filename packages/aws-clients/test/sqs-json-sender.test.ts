import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { assert, describe, test } from 'vitest';
import { createSqsJsonSender } from '../src/sqs-json-sender.js';

describe('SQS JSON 生产适配器', () => {
  test('保留真实SQS MessageId和请求ID，单次发送不伪造投递回执', async () => {
    let calls = 0;
    const client = {
      send: async () => {
        calls += 1;
        return { MessageId: 'sqs-produced-1', $metadata: { requestId: 'aws-request-1' } };
      },
    } as unknown as SQSClient;
    const sender = createSqsJsonSender({ queueUrl: 'https://sqs.example/ingress', client });
    assert.deepEqual(await sender.sendWithReceipt?.({ meta: { id: 'original-1' } }), {
      sqsMessageId: 'sqs-produced-1',
      requestId: 'aws-request-1',
    });
    assert.equal(calls, 1);
  });
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
