import { createCommandPhaseObserver, type CommandPhaseObserver } from '../admin/command/phase-observer.js';
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

async function initialize(observe: CommandPhaseObserver): Promise<CommandPublisherDeps> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(
    await observe('db-secret', () => resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region })),
  );
  const endpoint = await observe('iot-endpoint', () => createAwsIotProvisioningClient({ region }).getDataEndpoint());
  const mqtt = createIotDataPublisher({ endpoint, region });
  return { client, mqtt };
}

/** EventBridge 生产入口：AUTHORIZED/PUBLISH_FAILED → IoT cmd Topic。 */
export async function handler(
  event: CommandQueueEvent = {},
  context?: { readonly awsRequestId?: string },
): Promise<CommandPublishBatchResult | { batchItemFailures: { itemIdentifier: string }[] }> {
  const workerStartedAt = Date.now();
  const coldStart = runtimeDeps === undefined;
  const observe = createCommandPhaseObserver(
    (row) => logger.info(JSON.stringify(row)),
    context?.awsRequestId ?? 'unknown',
    coldStart,
  );
  runtimeDeps ??= await initialize(observe);
  const deps = { ...runtimeDeps, observePhase: observe };
  for (const record of event.Records ?? []) {
    const sent = record.attributes?.SentTimestamp;
    logger.info(
      JSON.stringify({
        event: 'command.notification.received',
        lambdaRequestId: /^[a-f0-9-]{36}$/.test(context?.awsRequestId ?? '') ? context?.awsRequestId : 'unknown',
        sqsMessageId: /^[a-f0-9-]{36}$/.test(record.messageId) ? record.messageId : 'unknown',
        ageAtWorkerStartMs: sent && /^\d{13}$/.test(sent) ? Math.max(0, workerStartedAt - Number(sent)) : null,
        clock: 'SQS_SENT_TIMESTAMP_TO_WORKER_WALL_CLOCK_APPROXIMATE',
        coldStart,
      }),
    );
  }
  logger.info(
    JSON.stringify({ event: 'command.invocation.started', source: event.Records ? 'SQS' : 'SCHEDULE', coldStart }),
  );
  if (event.Records)
    return observe('sqs-consumption', () =>
      consumeCommandNotifications(deps, event, (row) =>
        logger.info(
          JSON.stringify({
            ...row,
            lambdaRequestId: /^[a-f0-9-]{36}$/.test(context?.awsRequestId ?? '') ? context?.awsRequestId : 'unknown',
          }),
        ),
      ),
    );
  return observe('scheduled-scan', () => publishPendingCommands(deps));
}
