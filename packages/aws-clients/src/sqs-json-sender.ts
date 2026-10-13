import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface JsonMessageSender {
  send(message: unknown): Promise<void>;
  sendWithReceipt?(message: unknown): Promise<void | { readonly sqsMessageId: string; readonly requestId?: string }>;
}

export interface SqsJsonSenderConfig {
  readonly queueUrl: string;
  readonly client?: SQSClient;
  readonly region?: string;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
}

/** 通用 JSON SQS 发送适配器；调用方负责定义消息结构，发送端只做确定性序列化。 */
export function createSqsJsonSender(config: SqsJsonSenderConfig): JsonMessageSender {
  const client =
    config.client ??
    new SQSClient({
      ...(config.region ? { region: config.region } : {}),
      ...(config.maxAttempts ? { maxAttempts: config.maxAttempts } : {}),
    });
  const sendWithReceipt = async (message: unknown) => {
    const result = await client.send(
      new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: JSON.stringify(message) }),
      config.timeoutMs ? { abortSignal: AbortSignal.timeout(config.timeoutMs) } : {},
    );
    if (result?.MessageId)
      return {
        sqsMessageId: result.MessageId,
        ...(result.$metadata?.requestId ? { requestId: result.$metadata.requestId } : {}),
      };
  };
  return {
    async send(message) {
      await sendWithReceipt(message);
    },
    sendWithReceipt,
  };
}
