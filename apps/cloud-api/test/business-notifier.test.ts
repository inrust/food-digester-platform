/**
 * BE-ALM-02 业务通知适配器验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - Critical 领域事件（Alarm 激活/Tamper/管理端状态迁移）→ 按 Customer 配置生成通知记录
 *   并发送成功（适配器随调随处理，1 分钟时限由部署层调度保证）；
 * - 非 Critical 不发送（防御性 severity 校验；无投递记录、发送端口零调用）；
 * - 重复事件只有一次有效通知（幂等键唯一；重复派发 P2002 跳过不重发）；
 * - 重试不重复通知：FAILED 重试、SENT 终态不再触达发送端口；
 * - 通知内容白名单渲染且不含敏感凭据（敏感模式 fail-closed）；
 * - Customer 配置隔离（无配置/停用配置不产生投递；按事件 customerId 找配置）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import {
  DEFAULT_MAX_ATTEMPTS,
  NotificationError,
  dispatchPendingNotifications,
  renderNotification,
  retryFailedDeliveries,
} from '../src/index.js';
import type { BusinessNotifierDeps } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-30T12:00:00Z');
const now = () => NOW;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

// ---------- 发送端口夹具 ----------

interface SentMail {
  to: string;
  subject: string;
  body: string;
}
interface SentWebhook {
  url: string;
  payload: Record<string, unknown>;
}

function fakeSenders(options: { failEmails?: string[]; failWebhooks?: string[] } = {}) {
  const mails: SentMail[] = [];
  const webhooks: SentWebhook[] = [];
  return {
    mails,
    webhooks,
    emailSender: {
      async send(input: SentMail) {
        if (options.failEmails?.includes(input.to)) throw new Error('SMTP rejected');
        mails.push(input);
      },
    },
    webhookSender: {
      async send(input: SentWebhook) {
        if (options.failWebhooks?.includes(input.url)) throw new Error('webhook 5xx');
        webhooks.push(input);
      },
    },
  };
}

function notifierDeps(senders: ReturnType<typeof fakeSenders>): BusinessNotifierDeps {
  return { client: prisma, now, emailSender: senders.emailSender, webhookSender: senders.webhookSender };
}

// ---------- 数据夹具 ----------

let seq = 0;

async function plantConfig(options: {
  emails?: string[];
  webhookUrl?: string | null;
  enabled?: boolean;
  customerId?: string;
}) {
  seq += 1;
  const customerId = options.customerId ?? `cus-ntf-${seq}`;
  await prisma.customer.upsert({
    where: { id: customerId },
    create: { id: customerId, name: `Notification Customer ${seq}` },
    update: {},
  });
  await prisma.customerNotificationConfig.create({
    data: {
      customerId,
      enabled: options.enabled ?? true,
      emailRecipients: options.emails ?? [],
      webhookUrl: options.webhookUrl ?? null,
    },
  });
  return customerId;
}

async function plantEvent(options: {
  eventType: string;
  customerId: string;
  severity?: string;
  kind?: string;
  code?: string;
  eventTypeField?: string;
  fromStatus?: string;
  toStatus?: string;
}) {
  seq += 1;
  const aggregateId = `agg-${seq}`;
  const payload: Record<string, unknown> = {
    type: options.eventType,
    kind: options.kind ?? 'alarm',
    deviceId: `dev-ntf-${seq}`,
    customerId: options.customerId,
    severity: options.severity ?? 'CRITICAL',
    occurredAt: NOW.toISOString(),
    ...(options.code ? { code: options.code, category: 'HEATING', message: '温度过高' } : {}),
    ...(options.eventTypeField ? { eventType: options.eventTypeField, component: 'lid' } : {}),
    ...(options.fromStatus ? { fromStatus: options.fromStatus, toStatus: options.toStatus } : {}),
    ...(options.kind === 'tamper' ? { tamperEventId: `tmp-${seq}` } : { alarmId: `alm-${seq}` }),
  };
  return prisma.outboxEvent.create({
    data: {
      eventType: options.eventType,
      aggregateType: options.kind ?? 'alarm',
      aggregateId,
      payload: JSON.parse(JSON.stringify(payload)) as never,
    },
  });
}

async function deliveriesOf(eventId: string) {
  return prisma.notificationDelivery.findMany({ where: { eventId }, orderBy: { idempotencyKey: 'asc' } });
}

describe('Critical → 通知记录与发送', () => {
  test('CRITICAL Alarm 激活：邮件 + Webhook 各一条 SENT 投递；内容白名单字段', async () => {
    const customerId = await plantConfig({
      emails: ['ops@a.com', 'duty@a.com'],
      webhookUrl: 'https://hook-a.example.com',
    });
    const event = await plantEvent({ eventType: 'CRITICAL_ALERT_RAISED', customerId, code: 'TEMP_HIGH' });
    const senders = fakeSenders();

    const summary = await dispatchPendingNotifications(notifierDeps(senders));
    assert.equal(summary.created, 3);
    assert.equal(summary.sent, 3);
    assert.equal(summary.failed, 0);

    const rows = await deliveriesOf(event.id);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === 'SENT' && r.sentAt !== null));
    assert.deepEqual(
      rows.map((r) => r.idempotencyKey).sort(),
      [
        `${event.id}:EMAIL:duty@a.com`,
        `${event.id}:EMAIL:ops@a.com`,
        `${event.id}:WEBHOOK:https://hook-a.example.com`,
      ].sort(),
    );

    assert.equal(senders.mails.length, 2);
    assert.ok(senders.mails[0].subject.includes('TEMP_HIGH'));
    assert.ok(senders.mails[0].body.includes(`deviceId: dev-ntf-`));
    assert.equal(senders.webhooks.length, 1);
    assert.equal((senders.webhooks[0].payload as Record<string, unknown>).code, 'TEMP_HIGH');
  });

  test('CRITICAL Tamper 与 ALARM_STATE_CHANGED 均产生通知', async () => {
    const customerId = await plantConfig({ emails: ['ops@b.com'] });
    const tamper = await plantEvent({
      eventType: 'CRITICAL_ALERT_RAISED',
      customerId,
      kind: 'tamper',
      eventTypeField: 'COVER_OPEN',
    });
    const stateChange = await plantEvent({
      eventType: 'ALARM_STATE_CHANGED',
      customerId,
      code: 'MOTOR_OL',
      fromStatus: 'ACTIVE',
      toStatus: 'ACKNOWLEDGED',
    });
    const senders = fakeSenders();

    const summary = await dispatchPendingNotifications(notifierDeps(senders));
    assert.equal(summary.sent, 2);
    assert.ok(senders.mails[0].subject.includes('Tamper COVER_OPEN'));
    assert.ok(senders.mails[1].subject.includes('ACTIVE→ACKNOWLEDGED'));
    assert.equal((await deliveriesOf(tamper.id)).length, 1);
    assert.equal((await deliveriesOf(stateChange.id)).length, 1);
  });

  test('非 Critical 不发送；无配置/停用配置不产生投递', async () => {
    const withConfig = await plantConfig({ emails: ['ops@c.com'] });
    const noConfig = `cus-ntf-none-${seq + 1}`;
    const disabled = await plantConfig({ emails: ['ops@d.com'], enabled: false });

    const nonCritical = await plantEvent({
      eventType: 'CRITICAL_ALERT_RAISED',
      customerId: withConfig,
      severity: 'MAJOR',
      code: 'T1',
    });
    const orphan = await plantEvent({ eventType: 'CRITICAL_ALERT_RAISED', customerId: noConfig, code: 'T2' });
    const disabledEv = await plantEvent({ eventType: 'CRITICAL_ALERT_RAISED', customerId: disabled, code: 'T3' });
    const senders = fakeSenders();

    const summary = await dispatchPendingNotifications(notifierDeps(senders));
    assert.equal(summary.sent, 0);
    assert.equal(senders.mails.length, 0, '非 Critical / 无配置 / 停用配置均不触达发送端口');
    assert.equal((await deliveriesOf(nonCritical.id)).length, 0);
    assert.equal((await deliveriesOf(orphan.id)).length, 0);
    assert.equal((await deliveriesOf(disabledEv.id)).length, 0);
    assert.ok(summary.suppressed >= 3);
  });
});

describe('幂等与重试', () => {
  test('两个并发 Worker 只有一个能领取同一 FAILED 投递', async () => {
    const customerId = await plantConfig({ emails: ['claim@f.com'] });
    await plantEvent({ eventType: 'CRITICAL_ALERT_RAISED', customerId, code: 'CLAIM' });
    await dispatchPendingNotifications(notifierDeps(fakeSenders({ failEmails: ['claim@f.com'] })));
    const recovered = fakeSenders();

    const [left, right] = await Promise.all([
      retryFailedDeliveries(notifierDeps(recovered)),
      retryFailedDeliveries(notifierDeps(recovered)),
    ]);

    assert.equal(left.retried + right.retried, 1);
    assert.equal(recovered.mails.length, 1);
    assert.equal((await prisma.notificationDelivery.findFirstOrThrow({ where: { customerId } })).status, 'SENT');
  });

  test('重复事件只有一次有效通知：重复派发 P2002 跳过，发送端口不重复调用', async () => {
    const customerId = await plantConfig({ emails: ['ops@e.com'] });
    const event = await plantEvent({ eventType: 'CRITICAL_ALERT_RAISED', customerId, code: 'DUP' });
    const senders = fakeSenders();

    const first = await dispatchPendingNotifications(notifierDeps(senders));
    assert.equal(first.sent, 1);
    const second = await dispatchPendingNotifications(notifierDeps(senders));
    assert.equal(second.created, 0, '投递记录已存在（幂等键）→ 不新建');
    assert.ok(second.skipped >= 1, '重复派发命中幂等键 P2002 跳过（含本事件）');
    // 直接模拟重复事件：同事件再次手工派发路径由幂等键保护
    assert.equal(senders.mails.length, 1, '重复事件只有一次有效通知');
    assert.equal((await deliveriesOf(event.id)).length, 1);
  });

  test('FAILED 重试成功转 SENT；SENT 终态不再触达发送端口；超过 maxAttempts 不再重试', async () => {
    const customerId = await plantConfig({ emails: ['flaky@f.com'], webhookUrl: 'https://hook-f.example.com' });
    await plantEvent({ eventType: 'CRITICAL_ALERT_RAISED', customerId, code: 'RETRY' });
    const senders = fakeSenders({ failEmails: ['flaky@f.com'], failWebhooks: ['https://hook-f.example.com'] });
    const deps = notifierDeps(senders);

    const first = await dispatchPendingNotifications(deps);
    assert.equal(first.created, 2);
    assert.equal(first.failed, 2);
    let rows = await prisma.notificationDelivery.findMany({ where: { customerId } });
    assert.ok(rows.every((r) => r.status === 'FAILED' && r.retryCount === 1 && r.lastError));

    // 恢复成功 → 重试转 SENT
    const recovered = fakeSenders();
    const retry1 = await retryFailedDeliveries(notifierDeps(recovered));
    assert.equal(retry1.retried, 2);
    assert.equal(retry1.sent, 2);
    rows = await prisma.notificationDelivery.findMany({ where: { customerId } });
    assert.ok(rows.every((r) => r.status === 'SENT'));

    // SENT 终态：再次重试/派发均不触达发送端口
    const retry2 = await retryFailedDeliveries(notifierDeps(recovered));
    assert.equal(retry2.retried, 0);
    assert.equal(recovered.mails.length, 1, '邮件仅成功发送一次');
    assert.equal(recovered.webhooks.length, 1);
  });

  test('持续失败：retryCount 递增，达到 maxAttempts 后不再重试', async () => {
    const customerId = await plantConfig({ emails: ['down@g.com'] });
    await plantEvent({ eventType: 'CRITICAL_ALERT_RAISED', customerId, code: 'DOWN' });
    const senders = fakeSenders({ failEmails: ['down@g.com'] });
    const deps = notifierDeps(senders);

    await dispatchPendingNotifications(deps);
    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i += 1) {
      await retryFailedDeliveries(deps);
    }
    const row = await prisma.notificationDelivery.findFirstOrThrow({ where: { customerId } });
    assert.equal(row.status, 'FAILED');
    assert.equal(row.retryCount, DEFAULT_MAX_ATTEMPTS, '达到上限');
    const after = await retryFailedDeliveries(deps);
    assert.equal(after.retried, 0, '超过 maxAttempts 不再重试');
  });
});

describe('内容安全', () => {
  test('渲染内容仅含白名单字段；敏感模式 fail-closed', () => {
    const rendered = renderNotification('CRITICAL_ALERT_RAISED', {
      kind: 'alarm',
      deviceId: 'dev-1',
      customerId: 'cus-1',
      severity: 'CRITICAL',
      occurredAt: NOW.toISOString(),
      code: 'TEMP_HIGH',
      category: 'HEATING',
      message: '温度过高',
      // 非白名单字段（即使上游带敏感内容也不进入通知）
      privateKey: 'SHOULD-NOT-RENDER',
      verifier: 'SHOULD-NOT-RENDER',
    });
    const serialized = `${rendered.subject}\n${rendered.body}\n${JSON.stringify(rendered.webhookPayload)}`;
    assert.ok(!serialized.includes('SHOULD-NOT-RENDER'), '非白名单字段不进入通知内容');

    // 白名单字段本身命中敏感模式 → fail-closed 抛错（防御上游数据污染）
    let leaked: unknown;
    try {
      renderNotification('CRITICAL_ALERT_RAISED', {
        deviceId: 'd',
        customerId: 'c',
        severity: 'CRITICAL',
        message: 'password leak',
      });
    } catch (err) {
      leaked = err;
    }
    assert.ok(leaked instanceof NotificationError && leaked.code === 'SENSITIVE_CONTENT', '敏感模式 fail-closed');
  });

  test('通知模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/notification/', import.meta.url));
    const source = readFileSync(`${dir}/business-notifier.ts`, 'utf8');
    assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), '通知适配器不得引用 AWS 客户端');
  });
});
