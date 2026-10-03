import { createRedactingLogger } from '@fdp/observability';
import { consumeCommandNotifications, type CommandQueueEvent } from '../admin/command/queue-consumer.js';
import type { CommandPublisherDeps } from '../admin/command/publisher.js';
import { createAwsIotProvisioningClient, createIotDataPublisher, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { publishPendingCommands } from '../admin/command/publisher.js';
import type { CommandPublishBatchResult } from '../admin/command/publisher.js';

const logger = createRedactingLogger(console);

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let runtimeDeps: CommandPublisherDeps | undefined;

async function initialize(): Promise<CommandPublisherDeps> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const endpoint = await createAwsIotProvisioningClient({ region }).getDataEndpoint();
  const mqtt = createIotDataPublisher({ endpoint, region });
  return { client, mqtt };
}

/** EventBridge 生产入口：AUTHORIZED/PUBLISH_FAILED → IoT cmd Topic。 */
export async function handler(
  event: CommandQueueEvent = {},
  context?: { readonly awsRequestId?: string },
): Promise<CommandPublishBatchResult | { batchItemFailures: { itemIdentifier: string }[] }> {
  runtimeDeps ??= await initialize();
  if (event.Records)
    return consumeCommandNotifications(runtimeDeps, event, (row) =>
      logger.info(
        JSON.stringify({
          ...row,
          lambdaRequestId: /^[a-f0-9-]{36}$/.test(context?.awsRequestId ?? '') ? context?.awsRequestId : 'unknown',
        }),
      ),
    );
  return publishPendingCommands(runtimeDeps);
}
