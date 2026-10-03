import { drainArchiveBatches } from '../outbox/drain.js';
import { createRedactingLogger } from '@fdp/observability';
import { createSqsArchiveSender, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { createOutboxPublisher } from '../outbox/publisher.js';
import type { PublishBatchResult } from '../outbox/publisher.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let shouldContinue = () => true;
let publishPendingBatch: (() => Promise<PublishBatchResult>) | undefined;

async function initialize(): Promise<() => Promise<PublishBatchResult>> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  return createOutboxPublisher({
    client,
    sender: createSqsArchiveSender({
      queueUrl: required('ARCHIVE_QUEUE_URL'),
      region,
      maxAttempts: 1,
      sendTimeoutMs: 5000,
    }),
    shouldContinue: () => shouldContinue(),
  }).publishPendingBatch;
}

/** EventBridge 生产入口：仅把 ARCHIVE 事件发送至 Archive SQS。 */
export async function handler(
  _event?: unknown,
  context?: { getRemainingTimeInMillis(): number },
): Promise<PublishBatchResult> {
  const started = performance.now();
  shouldContinue = () =>
    performance.now() - started < 45000 && (context?.getRemainingTimeInMillis() ?? Infinity) > 10000;
  publishPendingBatch ??= await initialize();
  const result = await drainArchiveBatches(publishPendingBatch, {
    ...(context ? { remainingMs: () => context.getRemainingTimeInMillis() } : {}),
  });
  createRedactingLogger(console).info(JSON.stringify({ event: 'archive.drain.completed', ...result }));
  return result;
}
