import { createS3ArchiveObjectStore } from '@fdp/aws-clients';
import type { ArchiveEventMessage } from '@fdp/aws-clients';
import { createRedactingLogger } from '@fdp/observability';
import { createArchiveWorker } from '../archive/worker.js';

export interface ArchiveSqsEventLike {
  readonly Records?: ReadonlyArray<{
    readonly messageId?: string;
    readonly body?: string;
    readonly eventSource?: string;
    readonly eventSourceARN?: string;
  }>;
}

export interface ArchiveSqsBatchResponse {
  readonly batchItemFailures: Array<{ readonly itemIdentifier: string }>;
}

interface ArchiveBatchProcessor {
  archiveBatch(messages: ArchiveEventMessage[]): Promise<{
    readonly rejectedEventIds: readonly string[];
    readonly objects?: ReadonlyArray<{
      readonly eventIds?: readonly string[];
      readonly key: string;
      readonly manifestKey: string;
      readonly sha256: string;
    }>;
    readonly rejected?: ReadonlyArray<{
      readonly eventId: string;
      readonly errorPath: string;
      readonly reason: string;
    }>;
  }>;
}

const logger = createRedactingLogger(console);

function parseMessage(body: string): ArchiveEventMessage {
  const value = JSON.parse(body) as Partial<ArchiveEventMessage>;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.eventId !== 'string' ||
    value.eventId.length === 0 ||
    value.eventType !== 'ARCHIVE' ||
    typeof value.aggregateType !== 'string' ||
    typeof value.aggregateId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !value.payload ||
    typeof value.payload !== 'object' ||
    Array.isArray(value.payload)
  ) {
    throw new Error('invalid ArchiveEventMessage');
  }
  return value as ArchiveEventMessage;
}

export function createArchiveSqsHandler(
  processor: ArchiveBatchProcessor,
  observe: (row: Record<string, unknown>) => void = (row) => logger.info(JSON.stringify(row)),
) {
  return async (
    event: ArchiveSqsEventLike,
    context?: { readonly awsRequestId?: string },
  ): Promise<ArchiveSqsBatchResponse> => {
    const failures = new Set<string>();
    const messages: ArchiveEventMessage[] = [];
    const messageIdsByEventId = new Map<string, string[]>();

    for (const [index, record] of (event.Records ?? []).entries()) {
      const messageId = record.messageId ?? `record-${index}`;
      try {
        const message = parseMessage(record.body ?? '');
        messages.push(message);
        const ids = messageIdsByEventId.get(message.eventId) ?? [];
        ids.push(messageId);
        messageIdsByEventId.set(message.eventId, ids);
      } catch (error) {
        logger.error('archive validation rejected', {
          kind: 'archive.validation_rejected',
          messageId,
          eventId: null,
          errorPath: '$',
          reason: error instanceof Error ? error.message : String(error),
          rawBody: record.body ?? '',
        });
        failures.add(messageId);
      }
    }

    if (messages.length > 0) {
      try {
        const result = await processor.archiveBatch(messages);
        for (const rejection of result.rejected ?? []) {
          for (const messageId of messageIdsByEventId.get(rejection.eventId) ?? []) {
            const rawBody = (event.Records ?? []).find((record) => record.messageId === messageId)?.body ?? '';
            logger.error('archive validation rejected', {
              kind: 'archive.validation_rejected',
              messageId,
              ...rejection,
              rawBody,
            });
          }
        }
        for (const eventId of result.rejectedEventIds) {
          for (const messageId of messageIdsByEventId.get(eventId) ?? []) failures.add(messageId);
        }
        for (const [eventId, messageIds] of messageIdsByEventId) {
          if (result.rejectedEventIds.includes(eventId)) continue;
          const object = result.objects?.find((row) => row.eventIds?.includes(eventId));
          for (const messageId of messageIds) {
            const record = event.Records?.find((row) => row.messageId === messageId);
            observe({
              event: 'archive.record.completed',
              schemaVersion: 1,
              lambdaRequestId: context?.awsRequestId ?? null,
              source: record?.eventSource === 'aws:sqs' ? 'aws:sqs' : 'DIRECT_FIXTURE_OR_UNKNOWN',
              queueName: record?.eventSource === 'aws:sqs' ? (record.eventSourceARN?.split(':').at(-1) ?? null) : null,
              messageId,
              eventId,
              outcome: object ? 'ARCHIVED' : 'SKIPPED_NO_ARCHIVE',
              ...(object
                ? { objectKey: object.key, manifestKey: object.manifestKey, compressedSha256: object.sha256 }
                : {}),
            });
          }
        }
      } catch {
        for (const ids of messageIdsByEventId.values()) for (const messageId of ids) failures.add(messageId);
      }
    }

    return { batchItemFailures: [...failures].sort().map((itemIdentifier) => ({ itemIdentifier })) };
  };
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let runtimeHandler: ReturnType<typeof createArchiveSqsHandler> | undefined;

function initialize() {
  const bucket = required('RAW_BUCKET_NAME');
  const region = required('AWS_REGION');
  return createArchiveSqsHandler(
    createArchiveWorker({ bucket, store: createS3ArchiveObjectStore({ bucket, region }) }),
  );
}

export async function handler(
  event: ArchiveSqsEventLike,
  context?: { readonly awsRequestId?: string },
): Promise<ArchiveSqsBatchResponse> {
  runtimeHandler ??= initialize();
  return runtimeHandler(event, context);
}
