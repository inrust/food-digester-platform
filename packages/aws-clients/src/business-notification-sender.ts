import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

export interface SesEmailSenderConfig {
  readonly fromAddress: string;
  readonly region?: string;
  readonly client?: SESv2Client;
}

/** BE-ALM-02：SES v2 纯文本邮件生产发送端。 */
export function createSesEmailSender(config: SesEmailSenderConfig) {
  const client = config.client ?? new SESv2Client(config.region ? { region: config.region } : {});
  return {
    async send(input: {
      readonly to: string;
      readonly subject: string;
      readonly body: string;
      readonly idempotencyKey: string;
    }): Promise<string | void> {
      const response = await client.send(
        new SendEmailCommand({
          FromEmailAddress: config.fromAddress,
          Destination: { ToAddresses: [input.to] },
          Content: {
            Simple: {
              Subject: { Data: input.subject, Charset: 'UTF-8' },
              Body: { Text: { Data: input.body, Charset: 'UTF-8' } },
            },
          },
        }),
      );
      return response.MessageId;
    },
  };
}

export interface HttpsWebhookSenderConfig {
  /** 生产允许的精确主机名白名单，防止任意 URL/SSRF。 */
  readonly allowedHosts: readonly string[];
  readonly fetchImpl?: typeof fetch;
}

/** 仅允许 HTTPS、无凭据、白名单主机、禁止重定向的 Webhook 发送端。 */
export function createHttpsWebhookSender(config: HttpsWebhookSenderConfig) {
  const allowedHosts = new Set(config.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (allowedHosts.size === 0) throw new Error('Webhook 主机白名单不能为空');
  const send = config.fetchImpl ?? fetch;
  return {
    async send(input: {
      readonly url: string;
      readonly payload: Record<string, unknown>;
      readonly idempotencyKey: string;
    }): Promise<string | void> {
      const url = new URL(input.url);
      if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.has(url.hostname.toLowerCase())) {
        throw new Error('Webhook URL 不满足 HTTPS 主机白名单策略');
      }
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
        body: JSON.stringify(input.payload),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`);
      return response.headers.get('x-request-id') ?? undefined;
    },
  };
}
