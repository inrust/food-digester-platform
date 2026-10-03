import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { closedCommandLedger, classifyDlqBody } from './qa09-command-dlq-scope.mjs';
const [businessPath, devicesPath, output] = process.argv.slice(2);
if (!output) throw Error('CLOSED_RECEIPTS_AND_OUTPUT_REQUIRED');
const business = JSON.parse(readFileSync(businessPath)),
  devices = JSON.parse(readFileSync(devicesPath));
const result = {
  scope: 'EXACT_RETIRED_OWN_COMMAND_DLQ_POINTERS',
  prefix: devices.prefix,
  startedAt: new Date().toISOString(),
  gate: 'RUNNING',
  messages: [],
  credentialsExported: false,
  receiptHandlesExported: false,
  purgeExecuted: false,
  writesToDatabase: 0,
  receiptHashes: [businessPath, devicesPath].map((p) => ({
    path: p,
    sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
  })),
};
const save = () => writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
const sdk = await import('@aws-sdk/client-sqs');
const exported = spawnSync(
  'aws',
  ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
  { encoding: 'utf8', timeout: 30000 },
);
if (exported.status !== 0) throw Error('SSO_CREDENTIALS_UNAVAILABLE');
const c = JSON.parse(exported.stdout);
const sqs = new sdk.SQSClient({
  region: 'ap-southeast-1',
  maxAttempts: 1,
  credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
});
const QueueUrl = 'https://sqs.ap-southeast-1.amazonaws.com/065986019555/fdp-test-command-publish-dlq';
const call = (command) => sqs.send(command, { abortSignal: AbortSignal.timeout(30000) });
save();
try {
  const proof = await runFixture(
    { prefix: devices.prefix, devices: devices.devices, customers: devices.customers, action: 'command-dlq-readonly' },
    output + '.database-proof.json',
    (s) => console.log(s),
  );
  const ledger = closedCommandLedger(business, devices, proof.result);
  const counts = () =>
    call(
      new sdk.GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
  result.before = await counts();
  for (let page = 0; page < 4; page++) {
    const received = await call(
      new sdk.ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, VisibilityTimeout: 30 }),
    );
    if (!received.Messages?.length) break;
    let unknown = false;
    for (const message of received.Messages) {
      const row = {
        sqsMessageId: message.MessageId,
        ...classifyDlqBody(message.Body ?? '', ledger),
        status: 'PENDING',
      };
      result.messages.push(row);
      save();
      if (row.disposition === 'DELETE_EXACT_RETIRED_OWN_POINTER') {
        await call(new sdk.DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
        row.status = 'DELETED';
      } else {
        unknown = true;
        await call(
          new sdk.ChangeMessageVisibilityCommand({
            QueueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
        row.status = 'PRESERVED';
      }
      save();
    }
    if (unknown) break;
  }
  result.after = await counts();
  result.gate =
    result.messages.some((m) => m.status !== 'DELETED') ||
    Number(result.after.Attributes.ApproximateNumberOfMessages) ||
    Number(result.after.Attributes.ApproximateNumberOfMessagesNotVisible)
      ? 'PARTIAL'
      : 'PASS';
} catch (error) {
  result.gate = 'BLOCKED';
  result.errorCode = /^[A-Z_]+$/.test(error.message ?? '')
    ? error.message
    : /^[A-Za-z0-9_]+$/.test(error.name)
      ? error.name
      : 'DLQ_OPERATION_FAILED';
} finally {
  result.finishedAt = new Date().toISOString();
  sqs.destroy();
  save();
}
console.log(
  JSON.stringify({ gate: result.gate, deleted: result.messages.filter((r) => r.status === 'DELETED').length }),
);
if (result.gate !== 'PASS') process.exitCode = 1;
