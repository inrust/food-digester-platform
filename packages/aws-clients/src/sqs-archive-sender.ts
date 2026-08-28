/**
 * BE-ARC-01 Archive SQS 发送适配器（Transactional Outbox Publisher 的下游端口实现）。
 *
 * - 事件 ID 稳定：MessageBody.eventId = outbox_events.id（uuid，创建即固定）；
 *   MessageAttributes.event_id 同源，供下游去重键使用；
 * - FIFO 队列（queueUrl 以 .fifo 结尾）：MessageDeduplicationId=eventId（队列级去重）、
 *   MessageGroupId=aggregateId（同设备有序）；标准队列不设置（由下游按 eventId 去重）；
 * - 重复投递允许（at-least-once）：下游必须按 eventId 去重，不产生重复归档对象记录。
 */
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

/** Publisher 发往归档队列的消息（事件 ID 稳定）。 */
export interface ArchiveEventMessage {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface ArchiveEventSender {
  send(message: ArchiveEventMessage): Promise<void>;
}

export interface SqsArchiveSenderConfig {
  /** Archive 队列 URL（IAC-01）；以 .fifo 结尾按 FIFO 语义发送。 */
  readonly queueUrl: string;
  /** 注入的 SQS 客户端（测试可 mock）；缺省按 region 创建。 */
  readonly client?: SQSClient;
  readonly region?: string;
}

export function createSqsArchiveSender(config: SqsArchiveSenderConfig): ArchiveEventSender {
  const client = config.client ?? new SQSClient(config.region ? { region: config.region } : {});
  const isFifo = config.queueUrl.endsWith('.fifo');
  return {
    async send(message) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            event_id: { DataType: 'String', StringValue: message.eventId },
            event_type: { DataType: 'String', StringValue: message.eventType },
          },
          ...(isFifo ? { MessageDeduplicationId: message.eventId, MessageGroupId: message.aggregateId } : {}),
        }),
      );
    },
  };
}
