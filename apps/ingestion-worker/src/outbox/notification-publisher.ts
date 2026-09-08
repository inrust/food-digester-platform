/** CT-04：设备 Notification Outbox 的独立 Publisher；不会读取 ARCHIVE。 */
import type { MqttMessageSender } from '@fdp/aws-clients';
import { isKnownNotification, NOTIFICATION_CATALOG } from '@fdp/contracts/mqtt/catalogs.js';
import { parseTopic } from '@fdp/contracts/mqtt/topics.js';
import type { DbClient } from '@fdp/database';
import { createLeasedOutboxPublisher } from './leased-publisher.js';
import type { OutboxRow, PublishBatchResult } from './leased-publisher.js';

export interface NotificationPublisherDeps {
  readonly client: DbClient;
  readonly sender: MqttMessageSender;
  readonly batchSize?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly leaseMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly leaseToken?: (() => string) | undefined;
}

function notificationPayloadOf(row: OutboxRow): { topic: string; data: Readonly<Record<string, unknown>> } {
  if (!isKnownNotification(row.eventType)) throw new Error(`Unsupported notification event: ${row.eventType}`);
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
    throw new Error('Notification payload must be an object');
  }
  const payload = row.payload as Record<string, unknown>;
  if (typeof payload.topic !== 'string') throw new Error('Notification topic must be a string');
  const topic = parseTopic(payload.topic);
  if (topic.type !== 'notification' || topic.direction !== 'downlink') {
    throw new Error('Notification must target a downlink notification topic');
  }
  if (row.aggregateType === 'device' && topic.deviceId !== row.aggregateId) {
    throw new Error('Notification topic does not match aggregate device');
  }
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new Error('Notification data must be an object');
  }
  const data = payload.data as Record<string, unknown>;
  if (data.type !== row.eventType) throw new Error('Notification data.type does not match eventType');
  return { topic: payload.topic, data };
}

export function createNotificationPublisher(deps: NotificationPublisherDeps): {
  publishPendingBatch(): Promise<PublishBatchResult>;
} {
  return createLeasedOutboxPublisher({
    ...deps,
    eventTypes: Object.keys(NOTIFICATION_CATALOG),
    send: async (row) => {
      const notification = notificationPayloadOf(row);
      await deps.sender.publish({
        topic: notification.topic,
        qos: 1,
        payload: JSON.stringify({
          meta: { id: `NTF-${row.id.toUpperCase()}`, ts: row.createdAt.toISOString(), schemaVer: '1.0' },
          data: notification.data,
        }),
      });
    },
  });
}
