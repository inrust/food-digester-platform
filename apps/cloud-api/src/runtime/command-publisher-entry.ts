import { createAwsIotProvisioningClient, createIotDataPublisher, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { publishPendingCommands } from '../admin/command/publisher.js';
import type { CommandPublishBatchResult } from '../admin/command/publisher.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let publishBatch: (() => Promise<CommandPublishBatchResult>) | undefined;

async function initialize(): Promise<() => Promise<CommandPublishBatchResult>> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const endpoint = await createAwsIotProvisioningClient({ region }).getDataEndpoint();
  const mqtt = createIotDataPublisher({ endpoint, region });
  return () => publishPendingCommands({ client, mqtt });
}

/** EventBridge 生产入口：AUTHORIZED/PUBLISH_FAILED → IoT cmd Topic。 */
export async function handler(): Promise<CommandPublishBatchResult> {
  publishBatch ??= await initialize();
  return publishBatch();
}
