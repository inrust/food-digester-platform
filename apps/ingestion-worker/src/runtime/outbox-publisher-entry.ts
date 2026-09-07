import {
  createAwsIotProvisioningClient,
  createIotDataPublisher,
  createSqsArchiveSender,
  resolveDatabaseUrl,
} from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { createOutboxPublisher } from '../outbox/publisher.js';
import type { PublishBatchResult } from '../outbox/publisher.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let publishPendingBatch: (() => Promise<PublishBatchResult>) | undefined;

async function initialize(): Promise<() => Promise<PublishBatchResult>> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const endpoint = await createAwsIotProvisioningClient({ region }).getDataEndpoint();
  return createOutboxPublisher({
    client,
    sender: createSqsArchiveSender({ queueUrl: required('ARCHIVE_QUEUE_URL'), region }),
    notificationSender: createIotDataPublisher({ endpoint, region }),
  }).publishPendingBatch;
}

/** EventBridge 生产入口：归档事件发 SQS，CT-04 Notification 发设备 MQTT Topic。 */
export async function handler(): Promise<PublishBatchResult> {
  publishPendingBatch ??= await initialize();
  return publishPendingBatch();
}
