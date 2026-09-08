import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { assert, describe, expect, test, vi } from 'vitest';
import { createHttpsWebhookSender, createSesEmailSender } from '../src/business-notification-sender.js';

describe('BE-ALM-02 业务通知生产发送端', () => {
  test('SES v2 只发送指定收件人和纯文本内容', async () => {
    const sent: unknown[] = [];
    const client = {
      async send(command: unknown) {
        sent.push(command);
        return {};
      },
    } as unknown as SESv2Client;
    const sender = createSesEmailSender({ fromAddress: 'alerts@example.com', client });

    await sender.send({ to: 'ops@example.com', subject: 'Critical alarm', body: 'deviceId: dev-1' });

    assert.instanceOf(sent[0], SendEmailCommand);
    assert.deepInclude((sent[0] as SendEmailCommand).input, {
      FromEmailAddress: 'alerts@example.com',
      Destination: { ToAddresses: ['ops@example.com'] },
    });
  });

  test('Webhook 仅允许 HTTPS 精确白名单主机并禁止重定向', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const sender = createHttpsWebhookSender({ allowedHosts: ['hooks.example.com'], fetchImpl });

    await sender.send({ url: 'https://hooks.example.com/critical', payload: { alarmId: 'alm-1' } });
    assert.equal(fetchImpl.mock.calls[0]?.[1]?.redirect, 'error');
    await expect(sender.send({ url: 'http://hooks.example.com/a', payload: {} })).rejects.toThrow(/白名单/u);
    await expect(sender.send({ url: 'https://evil.example/a', payload: {} })).rejects.toThrow(/白名单/u);
    await expect(sender.send({ url: 'https://user:pass@hooks.example.com/a', payload: {} })).rejects.toThrow(/白名单/u);
  });
});
