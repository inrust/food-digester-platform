import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { classifyDlqBody } from './qa09-command-dlq-scope.mjs';

/** One-shot AWS worker. Deployment must pin these environment values to a fresh verified closed ledger. */
export async function handler(event, _context, injectedClient) {
  const prefix = process.env.QA09_DLQ_PREFIX,
    digest = process.env.QA09_DLQ_PROOF_SHA256;
  const expiry = Date.parse(process.env.QA09_DLQ_EXPIRES_AT ?? '');
  const expected = Array.from({ length: 20 }, (_, i) => `${prefix?.toUpperCase()}-CMD-${i}`);
  if (
    process.env.AWS_REGION !== 'ap-southeast-1' ||
    !/^qa09-[a-f0-9]{16}$/.test(prefix ?? '') ||
    !/^[a-f0-9]{64}$/.test(digest ?? '') ||
    event?.proofSha256 !== digest ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry - Date.now() > 300000
  )
    throw Error('FRESH_CLOSED_DLQ_PROOF_REQUIRED');
  const ledger = new Set(expected);
  const client = injectedClient ?? new SQSClient({ region: 'ap-southeast-1', maxAttempts: 1 });
  const QueueUrl = 'https://sqs.ap-southeast-1.amazonaws.com/065986019555/fdp-test-command-publish-dlq';
  const call = (command) => client.send(command, { abortSignal: AbortSignal.timeout(10000) });
  const result = { scope: 'EXACT_RETIRED_OWN_COMMAND_DLQ_POINTERS', prefix, messages: [], gate: 'PARTIAL' };
  try {
    for (let page = 0; page < 4 && Date.now() < expiry; page++) {
      const batch = await call(
        new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }),
      );
      if (!batch.Messages?.length) break;
      let unknown = false;
      for (const message of batch.Messages) {
        const row = {
          sqsMessageId: message.MessageId,
          ...classifyDlqBody(message.Body ?? '', ledger),
          status: 'PENDING',
        };
        result.messages.push(row);
        if (row.disposition === 'DELETE_EXACT_RETIRED_OWN_POINTER' && Date.now() < expiry) {
          await call(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
          row.status = 'DELETED';
        } else {
          await call(
            new ChangeMessageVisibilityCommand({
              QueueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
          row.status = 'PRESERVED';
          unknown = true;
        }
      }
      if (unknown) break;
    }
    result.counts = (
      await call(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      )
    ).Attributes;
    result.gate =
      result.messages.every((r) => r.status === 'DELETED') &&
      result.counts?.ApproximateNumberOfMessages === '0' &&
      result.counts?.ApproximateNumberOfMessagesNotVisible === '0'
        ? 'PASS'
        : 'PARTIAL';
  } catch (error) {
    result.gate = 'BLOCKED';
    result.errorCode = /^[A-Za-z0-9_]+$/.test(error.name) ? error.name : 'DLQ_OPERATION_FAILED';
  } finally {
    if (!injectedClient) client.destroy();
  }
  return result;
}
