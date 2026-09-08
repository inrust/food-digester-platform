import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { assert, describe, expect, test, vi } from 'vitest';
import { createHttpsWebhookSender, createSesEmailSender } from '../src/business-notification-sender.js';

describe('BE-ALM-02 业务通知生产发送端', () => {
  test('SES v2 只发送指定收件人和纯文本内容', async () => {
    const sent: unknown[] = [];
    const client = {
      async send(command: unknown) {
        sent.push(command);
        return { MessageId: 'ses-message-1' };
      },
    } as unknown as SESv2Client;
    const sender = createSesEmailSender({ fromAddress: 'alerts@example.com', client });

    const providerRequestId = await sender.send({
      to: 'ops@example.com',
      subject: 'Critical alarm',
      body: 'deviceId: dev-1',
      idempotencyKey: 'event-1:EMAIL:ops@example.com',
    });

    assert.instanceOf(sent[0], SendEmailCommand);
    assert.deepInclude((sent[0] as SendEmailCommand).input, {
      FromEmailAddress: 'alerts@example.com',
      Destination: { ToAddresses: ['ops@example.com'] },
    });
    assert.equal(providerRequestId, 'ses-message-1');
  });

  test('Webhook 仅允许 HTTPS 精确白名单主机并禁止重定向', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204, headers: { 'x-request-id': 'hook-request-1' } }),
    );
    const sender = createHttpsWebhookSender({ allowedHosts: ['hooks.example.com'], fetchImpl });

    const providerRequestId = await sender.send({
      url: 'https://hooks.example.com/critical',
      payload: { alarmId: 'alm-1' },
      idempotencyKey: 'event-1:WEBHOOK:https://hooks.example.com/critical',
    });
    assert.equal(fetchImpl.mock.calls[0]?.[1]?.redirect, 'error');
    assert.equal(
      (fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>)['idempotency-key'],
      'event-1:WEBHOOK:https://hooks.example.com/critical',
    );
    assert.equal(providerRequestId, 'hook-request-1');
    const invalid = (url: string) => sender.send({ url, payload: {}, idempotencyKey: 'event-2:WEBHOOK:target' });
    await expect(invalid('http://hooks.example.com/a')).rejects.toThrow(/白名单/u);
    await expect(invalid('https://evil.example/a')).rejects.toThrow(/白名单/u);
    await expect(invalid('https://user:pass@hooks.example.com/a')).rejects.toThrow(/白名单/u);
  });
});
