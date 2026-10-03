import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export async function redeliverOwnProcessedTelemetry(ctx, raw, output) {
  const payload = JSON.parse(raw),
    id = ctx.receipt.devices[0];
  const r = {
    scope: 'OWN_API_VISIBLE_TELEMETRY_SQS_REDELIVERY',
    prefix: ctx.receipt.prefix,
    gate: 'NOT_RUN',
    consumptionProven: false,
    sharedQueueConfigurationChanged: false,
    sharedQueueReadOrPurge: false,
    fullQa09Accepted: false,
  };
  try {
    if (
      !id.startsWith(ctx.receipt.prefix + '-') ||
      !ctx.receipt.published.some(
        (x) =>
          x.deviceId === id &&
          x.type === 'telemetry' &&
          x.messageId === payload.meta?.id &&
          x.bodySha256 === createHash('sha256').update(raw).digest('hex'),
      )
    )
      throw Error('OWN_TELEMETRY_SCOPE_REQUIRED');
    const observed = ctx.receipt.databaseBuilds.filter((x) => x.action === 'observe').at(-1);
    const frame = JSON.parse(readFileSync(observed.receipt)).result;
    const cert = frame.certificates.find((x) => x.device_id === id && x.status === 'ACTIVE');
    if (!/^[a-f0-9]{64}$/.test(cert?.id ?? '')) throw Error('OWN_ACTIVE_CERTIFICATE_REQUIRED');
    const envelope = {
      ...payload,
      iotTopic: `bnx/device/${id}/telemetry`,
      iotDeviceId: id,
      iotType: 'telemetry',
      iotReceivedAt: Date.now(),
      iotPrincipal: cert.id,
    };
    const sqs = new SQSClient({ region: 'ap-southeast-1', credentials: ctx.credentials, maxAttempts: 1 });
    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: 'https://sqs.ap-southeast-1.amazonaws.com/065986019555/fdp-test-ingress',
        MessageBody: JSON.stringify(envelope),
      }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
    Object.assign(r, {
      gate: 'SUBMITTED_CONSUMPTION_NOT_PROVEN',
      messageId: payload.meta.id,
      sqsMessageId: sent.MessageId,
      requestId: sent.$metadata.requestId,
      rawBodySha256: createHash('sha256').update(raw).digest('hex'),
      startedAt: new Date().toISOString(),
    });
  } catch (e) {
    r.gate = 'BLOCKED';
    r.errorName = e.name;
    r.errorCode = e.Code ?? e.code ?? (/^[A-Z_]+$/.test(e.message) ? e.message : 'QUEUE_REDELIVERY_FAILED');
  }
  writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  return r;
}
