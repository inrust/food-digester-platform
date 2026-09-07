import { createSqsJsonSender, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { createReplayTriggerPublisher } from '../replay/trigger-publisher.js';
import type { ReplayTriggerPublishResult } from '../replay/trigger-publisher.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let publishPendingBatch: (() => Promise<ReplayTriggerPublishResult>) | undefined;

async function initialize(): Promise<() => Promise<ReplayTriggerPublishResult>> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  return createReplayTriggerPublisher({
    client,
    sender: createSqsJsonSender({ queueUrl: required('REPLAY_QUEUE_URL'), region }),
  }).publishPendingBatch;
}

/** EventBridge 入口：发布事务 Outbox 中的 replay job 触发消息。 */
export async function handler(): Promise<ReplayTriggerPublishResult> {
  publishPendingBatch ??= await initialize();
  return publishPendingBatch();
}
