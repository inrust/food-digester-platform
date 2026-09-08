import { createAwsIotProvisioningClient, createIotDataPublisher, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { createNotificationPublisher } from '../outbox/notification-publisher.js';
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
  return createNotificationPublisher({
    client,
    sender: createIotDataPublisher({ endpoint, region }),
  }).publishPendingBatch;
}

/** EventBridge 生产入口：仅发布 CT-04 设备 Notification；不会读取 ARCHIVE。 */
export async function handler(): Promise<PublishBatchResult> {
  publishPendingBatch ??= await initialize();
  return publishPendingBatch();
}
