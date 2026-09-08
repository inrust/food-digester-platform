/** BE-ARC-01：只领取 ARCHIVE Outbox，并以可恢复租约保证多实例不会同时发送同一行。 */
import type { ArchiveEventMessage, ArchiveEventSender } from '@fdp/aws-clients';
import type { DbClient } from '@fdp/database';
import { createLeasedOutboxPublisher } from './leased-publisher.js';
import type { PublishBatchResult } from './leased-publisher.js';

export interface OutboxPublisherDeps {
  readonly client: DbClient;
  readonly sender: ArchiveEventSender;
  readonly batchSize?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly leaseMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly leaseToken?: (() => string) | undefined;
}

export function createOutboxPublisher(deps: OutboxPublisherDeps): {
  publishPendingBatch(): Promise<PublishBatchResult>;
} {
  return createLeasedOutboxPublisher({
    ...deps,
    eventTypes: ['ARCHIVE'],
    send: async (row) => {
      const message: ArchiveEventMessage = {
        eventId: row.id,
        eventType: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      };
      await deps.sender.send(message);
    },
  });
}

export type { PublishBatchResult } from './leased-publisher.js';
