import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from './qa09-command-dlq-worker.mjs';
test('one-shot worker deletes only exact retired pointers, restores unknown visibility, and exports no bodies or handles', async () => {
  const prior = { ...process.env },
    calls = [];
  try {
    Object.assign(process.env, {
      AWS_REGION: 'ap-southeast-1',
      QA09_DLQ_PREFIX: 'qa09-1111111111111111',
      QA09_DLQ_PROOF_SHA256: 'a'.repeat(64),
      QA09_DLQ_EXPIRES_AT: new Date(Date.now() + 60000).toISOString(),
    });
    const client = {
      async send(command) {
        calls.push(command);
        if (command.constructor.name === 'ReceiveMessageCommand')
          return {
            Messages: [
              {
                MessageId: 'own',
                ReceiptHandle: 'secret-handle-own',
                Body: JSON.stringify({ commandId: 'QA09-1111111111111111-CMD-0' }),
              },
              { MessageId: 'other', ReceiptHandle: 'secret-handle-other', Body: 'private-unknown-body' },
            ],
          };
        if (command.constructor.name === 'GetQueueAttributesCommand')
          return { Attributes: { ApproximateNumberOfMessages: '1', ApproximateNumberOfMessagesNotVisible: '0' } };
        return {};
      },
    };
    const result = await handler({ proofSha256: 'a'.repeat(64) }, {}, client);
    assert.equal(result.gate, 'PARTIAL');
    assert.equal(calls.filter((c) => c.constructor.name === 'DeleteMessageCommand').length, 1);
    assert.equal(calls.find((c) => c.constructor.name === 'ChangeMessageVisibilityCommand').input.VisibilityTimeout, 0);
    assert.doesNotMatch(JSON.stringify(result), /secret-handle|private-unknown-body/);
    process.env.QA09_DLQ_EXPIRES_AT = new Date(Date.now() - 1).toISOString();
    await assert.rejects(handler({ proofSha256: 'a'.repeat(64) }, {}, client), /FRESH_CLOSED_DLQ_PROOF_REQUIRED/);
  } finally {
    for (const key of ['AWS_REGION', 'QA09_DLQ_PREFIX', 'QA09_DLQ_PROOF_SHA256', 'QA09_DLQ_EXPIRES_AT']) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});
