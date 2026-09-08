/**
 * BE-ALM-02 业务通知适配器（框架无关，纯 DB + 注入式发送端口）。
 *
 * 定位：消费 Critical Alarm/Tamper 领域事件（Outbox），按 Customer 通知配置发送业务
 * 邮件/Webhook；保存发送状态与幂等键。
 *
 * 事件来源（封闭集合）：
 * - CRITICAL_ALERT_RAISED：BE-IOT-07 生产侧（CRITICAL Alarm 激活 / CRITICAL Tamper，同事务落库）；
 * - ALARM_STATE_CHANGED：BE-ALM-01（CRITICAL 告警确认/清除真实迁移）。
 *
 * 规则：
 * - 非 Critical 不发送：生产侧已仅对 CRITICAL 产出事件；适配器再做防御性 severity 校验
 *   （payload.severity !== 'CRITICAL' → 跳过，不产生投递记录）；
 * - 幂等键 eventId:channel:target 唯一索引：重复事件/重复派发只产生一条投递记录
 *   （P2002 → 跳过，不重发）；外部发送前原子领取为 PROCESSING，过期租约可恢复；SENT 为终态；
 * - 通知内容白名单渲染（仅 deviceId/customerId/code/severity/时间等业务字段），并做敏感
 *   模式 fail-closed 检查——通知内容不含敏感凭据；
 * - 发送端口（EmailSender/WebhookSender）为注入接口：本模块不含任何 AWS 依赖（SES/SNS 由
 *   IAC 与部署层接线）；调度节奏（1 分钟内）由部署层定时触发本模块 dispatch 保证。
 *
 * 功能边界：仅处理设备业务告警，不处理 SQS/RDS/Lambda 等运维告警。
 */
import type { DbClient } from '@fdp/database';
import { randomUUID } from 'node:crypto';

// ---------- 领域事件类型（封闭集合） ----------

export const NOTIFIABLE_EVENT_TYPES = ['CRITICAL_ALERT_RAISED', 'ALARM_STATE_CHANGED'] as const;
export type NotifiableEventType = (typeof NOTIFIABLE_EVENT_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['EMAIL', 'WEBHOOK'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const DEFAULT_MAX_ATTEMPTS = 5 as const;

// ---------- 错误 ----------

export class NotificationError extends Error {
  override readonly name = 'NotificationError';
  constructor(
    readonly code: 'SENSITIVE_CONTENT' | 'INVALID_CONFIG',
    message: string,
  ) {
    super(message);
  }
}

// ---------- 发送端口（注入；部署层接 SES/HTTPS 实现） ----------

export interface EmailSender {
  send(input: {
    readonly to: string;
    readonly subject: string;
    readonly body: string;
    readonly idempotencyKey: string;
  }): Promise<string | void>;
}

export interface WebhookSender {
  send(input: {
    readonly url: string;
    readonly payload: Record<string, unknown>;
    readonly idempotencyKey: string;
  }): Promise<string | void>;
}

export interface BusinessNotifierDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  readonly emailSender: EmailSender;
  readonly webhookSender: WebhookSender;
  /** 最大尝试次数（首次 + 重试）；默认 5。 */
  readonly maxAttempts?: number;
  /** 单批处理事件/投递上限；默认 50。 */
  readonly batchSize?: number;
  /** FAILED/过期 PROCESSING 重试领取租约；默认 60 秒。 */
  readonly leaseSeconds?: number;
}

// ---------- 行类型与数据访问 ----------

interface OutboxRow {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
}

interface ConfigRow {
  readonly customerId: string;
  readonly enabled: boolean;
  readonly emailRecipients: unknown;
  readonly webhookUrl: string | null;
}

interface DeliveryRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly channel: string;
  readonly target: string;
  readonly subject: string | null;
  readonly body: string;
  readonly status: string;
  readonly retryCount: number;
  readonly leaseUntil?: Date | null;
  readonly leaseToken?: string | null;
  readonly providerRequestId?: string | null;
}

interface OutboxDelegate {
  findMany(args: Record<string, unknown>): Promise<OutboxRow[]>;
}

interface ConfigDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ConfigRow | null>;
}

interface DeliveryDelegate {
  create(args: { data: Record<string, unknown> }): Promise<DeliveryRow>;
  findMany(args: Record<string, unknown>): Promise<DeliveryRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function outbox(client: DbClient): OutboxDelegate {
  return (client as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
}

function configs(client: DbClient): ConfigDelegate {
  return (client as unknown as Record<string, unknown>).customerNotificationConfig as ConfigDelegate;
}

function deliveries(client: DbClient): DeliveryDelegate {
  return (client as unknown as Record<string, unknown>).notificationDelivery as DeliveryDelegate;
}

// ---------- 内容模板（白名单字段渲染；不含敏感凭据） ----------

const SENSITIVE_PATTERN = /(password|secret|private ?key|BEGIN [A-Z ]*PRIVATE KEY|access ?key|token|verifier)/i;

export interface RenderedNotification {
  readonly subject: string;
  readonly body: string;
  /** Webhook 载荷（白名单字段）。 */
  readonly webhookPayload: Record<string, unknown>;
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 渲染通知内容：仅取白名单业务字段（kind/code/severity/deviceId/customerId/时间/状态迁移），
 * 不透传原始 payload 全文。渲染结果做敏感模式 fail-closed 检查。
 */
export function renderNotification(
  eventType: NotifiableEventType,
  payload: Record<string, unknown>,
): RenderedNotification {
  const deviceId = asStr(payload.deviceId) ?? 'unknown';
  const customerId = asStr(payload.customerId) ?? 'unknown';
  const severity = asStr(payload.severity) ?? 'CRITICAL';
  const occurredAt = asStr(payload.occurredAt) ?? asStr(payload.detectedTime) ?? null;

  let title: string;
  const lines: string[] = [];
  if (eventType === 'CRITICAL_ALERT_RAISED' && payload.kind === 'tamper') {
    title = `[${severity}] Tamper ${asStr(payload.eventType) ?? 'UNKNOWN'} on device ${deviceId}`;
    lines.push(`eventType: ${asStr(payload.eventType) ?? 'UNKNOWN'}`);
    if (asStr(payload.component)) lines.push(`component: ${asStr(payload.component)}`);
  } else if (eventType === 'ALARM_STATE_CHANGED') {
    title = `[${severity}] Alarm ${asStr(payload.code) ?? ''} ${asStr(payload.fromStatus) ?? ''}→${asStr(payload.toStatus) ?? ''} on device ${deviceId}`;
    lines.push(`code: ${asStr(payload.code) ?? ''}`);
    lines.push(`transition: ${asStr(payload.fromStatus) ?? ''} -> ${asStr(payload.toStatus) ?? ''}`);
  } else {
    title = `[${severity}] Alarm ${asStr(payload.code) ?? 'UNKNOWN'} on device ${deviceId}`;
    lines.push(`code: ${asStr(payload.code) ?? 'UNKNOWN'}`);
    if (asStr(payload.category)) lines.push(`category: ${asStr(payload.category)}`);
    if (asStr(payload.message)) lines.push(`message: ${asStr(payload.message)}`);
  }
  lines.push(`deviceId: ${deviceId}`);
  lines.push(`customerId: ${customerId}`);
  if (occurredAt) lines.push(`occurredAt: ${occurredAt}`);

  const rendered: RenderedNotification = {
    subject: title,
    body: lines.join('\n'),
    webhookPayload: {
      type: eventType,
      severity,
      deviceId,
      customerId,
      occurredAt,
      code: asStr(payload.code),
      category: asStr(payload.category),
      eventTypeField: asStr(payload.eventType),
      fromStatus: asStr(payload.fromStatus),
      toStatus: asStr(payload.toStatus),
    },
  };
  // 敏感内容 fail-closed：白名单渲染仍做最终检查（防御渲染逻辑漂移）
  const serialized = `${rendered.subject}\n${rendered.body}\n${JSON.stringify(rendered.webhookPayload)}`;
  if (SENSITIVE_PATTERN.test(serialized)) {
    throw new NotificationError('SENSITIVE_CONTENT', 'The notification content matches a sensitive pattern');
  }
  return rendered;
}

// ---------- 派发与重试 ----------

export interface DispatchSummary {
  /** 扫描到的可通知领域事件数。 */
  readonly events: number;
  /** 新建投递记录数。 */
  readonly created: number;
  /** 本次发送成功数。 */
  readonly sent: number;
  /** 本次发送失败数（已标记 FAILED 待重试）。 */
  readonly failed: number;
  /** 幂等跳过数（投递记录已存在）。 */
  readonly skipped: number;
  /** 非 Critical / 无配置 / 停用配置而跳过的事件数。 */
  readonly suppressed: number;
}

function idempotencyKeyOf(eventId: string, channel: NotificationChannel, target: string): string {
  return `${eventId}:${channel}:${target}`;
}

function emailRecipientsOf(row: ConfigRow): string[] {
  return Array.isArray(row.emailRecipients)
    ? row.emailRecipients.filter((e): e is string => typeof e === 'string' && e.length > 0)
    : [];
}

function isCritical(payload: Record<string, unknown>): boolean {
  return payload.severity === 'CRITICAL';
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

async function attemptSend(
  deps: BusinessNotifierDeps,
  delivery: DeliveryRow,
  leaseToken: string,
): Promise<'SENT' | 'FAILED'> {
  const now = deps.now?.() ?? new Date();
  try {
    let providerRequestId: string | void;
    if (delivery.channel === 'EMAIL') {
      providerRequestId = await deps.emailSender.send({
        to: delivery.target,
        subject: delivery.subject ?? '',
        body: delivery.body,
        idempotencyKey: delivery.idempotencyKey,
      });
    } else {
      providerRequestId = await deps.webhookSender.send({
        url: delivery.target,
        payload: JSON.parse(delivery.body) as Record<string, unknown>,
        idempotencyKey: delivery.idempotencyKey,
      });
    }
    await deliveries(deps.client).updateMany({
      where: { id: delivery.id, status: 'PROCESSING', leaseToken },
      data: {
        status: 'SENT',
        sentAt: now,
        lastError: null,
        providerRequestId: typeof providerRequestId === 'string' ? providerRequestId.slice(0, 500) : null,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    return 'SENT';
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'send failed';
    await deliveries(deps.client).updateMany({
      where: { id: delivery.id, status: 'PROCESSING', leaseToken },
      data: { status: 'FAILED', retryCount: { increment: 1 }, lastError: message, leaseToken: null, leaseUntil: null },
    });
    return 'FAILED';
  }
}

async function claimAndAttemptSend(
  deps: BusinessNotifierDeps,
  delivery: DeliveryRow,
  at: Date,
): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
  const leaseToken = randomUUID();
  const claimed = await deliveries(deps.client).updateMany({
    where: {
      id: delivery.id,
      status: { in: ['PENDING', 'FAILED', 'PROCESSING'] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: at } }],
    },
    data: {
      status: 'PROCESSING',
      leaseToken,
      leaseUntil: new Date(at.getTime() + (deps.leaseSeconds ?? 60) * 1000),
    },
  });
  if (claimed.count !== 1) return 'SKIPPED';
  return attemptSend(deps, delivery, leaseToken);
}

/**
 * 扫描可通知领域事件（PENDING/PUBLISHED 均处理；投递幂等键保证只建一条记录），
 * 按 Customer 通知配置生成投递记录并立即尝试发送。
 */
export async function dispatchPendingNotifications(deps: BusinessNotifierDeps): Promise<DispatchSummary> {
  const batchSize = deps.batchSize ?? 50;
  const events = await outbox(deps.client).findMany({
    where: { eventType: { in: [...NOTIFIABLE_EVENT_TYPES] }, status: { in: ['PENDING', 'PUBLISHED'] } },
    orderBy: [{ createdAt: 'asc' }, { aggregateId: 'asc' }],
    take: batchSize,
  });

  let created = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let suppressed = 0;

  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    // 非 Critical 不发送（防御性校验；生产侧已只产出 CRITICAL）
    if (!isCritical(payload)) {
      suppressed += 1;
      continue;
    }
    const customerId = asStr(payload.customerId);
    if (!customerId) {
      suppressed += 1;
      continue;
    }
    const config = await configs(deps.client).findFirst({ where: { customerId } });
    if (!config || !config.enabled) {
      suppressed += 1;
      continue;
    }
    const targets: { channel: NotificationChannel; target: string }[] = [
      ...emailRecipientsOf(config).map((to) => ({ channel: 'EMAIL' as const, target: to })),
      ...(config.webhookUrl ? [{ channel: 'WEBHOOK' as const, target: config.webhookUrl }] : []),
    ];
    if (targets.length === 0) {
      suppressed += 1;
      continue;
    }

    const rendered = renderNotification(event.eventType as NotifiableEventType, payload);
    for (const { channel, target } of targets) {
      const idempotencyKey = idempotencyKeyOf(event.id, channel, target);
      let delivery: DeliveryRow;
      try {
        delivery = await deliveries(deps.client).create({
          data: {
            idempotencyKey,
            eventId: event.id,
            customerId,
            channel,
            target,
            subject: rendered.subject,
            // EMAIL 存纯文本正文；WEBHOOK 存 JSON 载荷
            body: channel === 'EMAIL' ? rendered.body : JSON.stringify(rendered.webhookPayload),
          },
        });
        created += 1;
      } catch (err) {
        // 幂等键冲突：重复事件/重复派发 → 跳过（不重发；FAILED 交由 retryFailedDeliveries）
        if (isUniqueViolation(err)) {
          skipped += 1;
          continue;
        }
        throw err;
      }
      const outcome = await claimAndAttemptSend(deps, delivery, deps.now?.() ?? new Date());
      if (outcome === 'SENT') sent += 1;
      else if (outcome === 'FAILED') failed += 1;
    }
  }

  return { events: events.length, created, sent, failed, skipped, suppressed };
}

/**
 * 重试 FAILED 或恢复租约已过期的 PROCESSING 投递（不超过 maxAttempts）；SENT 永不重发。
 */
export async function retryFailedDeliveries(
  deps: BusinessNotifierDeps,
): Promise<{ retried: number; sent: number; failed: number }> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const batchSize = deps.batchSize ?? 50;
  const at = deps.now?.() ?? new Date();
  const rows = await deliveries(deps.client).findMany({
    where: {
      status: { in: ['FAILED', 'PROCESSING'] },
      retryCount: { lt: maxAttempts },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: at } }],
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  });
  let sent = 0;
  let failed = 0;
  let retried = 0;
  for (const row of rows) {
    const outcome = await claimAndAttemptSend(deps, row, at);
    if (outcome === 'SKIPPED') continue;
    retried += 1;
    if (outcome === 'SENT') sent += 1;
    else failed += 1;
  }
  return { retried, sent, failed };
}
