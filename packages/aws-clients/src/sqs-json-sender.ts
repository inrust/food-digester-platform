import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface JsonMessageSender {
  send(message: unknown): Promise<void>;
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
  return {
    async send(message) {
      await client.send(
        new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: JSON.stringify(message) }),
        config.timeoutMs ? { abortSignal: AbortSignal.timeout(config.timeoutMs) } : {},
      );
    },
  };
}
