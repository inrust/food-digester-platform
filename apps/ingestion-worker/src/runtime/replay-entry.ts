import { createS3ArchiveObjectReader, createSqsJsonSender, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { createReplayIngressSink } from '../replay/ingress-sink.js';
import { createReplayWorker } from '../replay/worker.js';

export interface ReplaySqsEvent {
  readonly Records?: readonly { readonly messageId?: string; readonly body?: string }[];
}

export interface ReplaySqsResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

export interface ReplayJobExecutor {
  executeJob(jobId: string): Promise<unknown>;
}

function jobIdOf(body: string | undefined): string {
  const parsed = JSON.parse(body ?? '') as Record<string, unknown>;
  if (typeof parsed.jobId !== 'string' || parsed.jobId.length === 0) throw new Error('jobId is required');
  return parsed.jobId;
}

export function createReplaySqsHandler(executor: ReplayJobExecutor) {
  return async (event: ReplaySqsEvent): Promise<ReplaySqsResponse> => {
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    for (const record of event.Records ?? []) {
      const itemIdentifier = record.messageId ?? 'unknown';
      try {
        await executor.executeJob(jobIdOf(record.body));
      } catch {
        batchItemFailures.push({ itemIdentifier });
      }
    }
    return { batchItemFailures };
  };
}

let runtimeHandler: ((event: ReplaySqsEvent) => Promise<ReplaySqsResponse>) | undefined;

async function initialize() {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const executor = createReplayWorker({
    client,
    reader: createS3ArchiveObjectReader({ bucket: required('RAW_BUCKET_NAME'), region }),
    sink: createReplayIngressSink({
      client,
      sender: createSqsJsonSender({ queueUrl: required('INGRESS_QUEUE_URL'), region }),
      partition: required('AWS_PARTITION'),
      region,
      accountId: required('FDP_AWS_ACCOUNT_ID'),
    }),
  });
  return createReplaySqsHandler(executor);
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

/** SQS 入口：逐条执行 replay job，使用 partial batch response 隔离失败任务。 */
export async function handler(event: ReplaySqsEvent): Promise<ReplaySqsResponse> {
  runtimeHandler ??= await initialize();
  return runtimeHandler(event);
}
