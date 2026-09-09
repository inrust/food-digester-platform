/**
 * BE-CMD-02 Command MQTT 发布器（框架无关；注入式 MqttPublisher 端口，无 AWS 依赖——部署层接 IoT Data Plane 实现）。
 *
 * 事实源与规则：
 * - Topic：CT-03 topic-catalog `bnx/device/{deviceId}/cmd`；Payload：cmd.schema.json（Envelope meta+data，无 audit 域）；
 *   meta.id 即 commandId（DEC-006 幂等键，下行 meta.seq 可选，V1 不发送 seq）；
 * - QoS：目录 specified 2 → AWS 有效 QoS 1（ADP-002@1.0.0 决策引用：QoS 2→1 为 AWS 技术适配，不删除 ACK/超时/审计机制）；
 * - 发布前重校验：状态（AUTHORIZED 可发 / PUBLISH_FAILED 可重试）+ expiresAt（超时后拒绝再次发布）+ 设备生命周期 Retired 拒绝；
 * - 状态机：AUTHORIZED → PUBLISHED（成功）/ PUBLISH_FAILED（传输异常）；
 *   PUBLISH_FAILED 未过期可重试，设备 ACK 终态 FAILED 绝不可重发；
 * - 发布重试不创建新 commandId（幂等键 = meta.id = commandId，DEC-006）；
 * - 超时后拒绝再次发布（expiresAt 已过 → CONFLICT，不发消息）；
 * - 功能边界：不等待设备同步响应、不推测执行成功（ACK/超时扫描属 BE-CMD-03）。
 */
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import { commandConflict, commandNotFound, commandStateNotAllowed } from './errors.js';

// ---------- 注入端口（部署层接 AWS IoT Data Plane） ----------

export interface CommandMqttPublishInput {
  readonly topic: string;
  readonly payload: string;
  /** AWS 有效 QoS（ADP-002@1.0.0：cmd specified 2 → AWS 实际 QoS 1）。 */
  readonly qos: 1;
}

export interface CommandMqttPublisher {
  publish(input: CommandMqttPublishInput): Promise<void | { readonly providerMessageId?: string }>;
}

export interface CommandPublisherDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  readonly mqtt: CommandMqttPublisher;
}

// ---------- CT-03 常量 ----------

/** cmd Topic（CT-03：bnx/device/{deviceId}/cmd）。 */
export function commandTopicOf(deviceId: string): string {
  return `bnx/device/${deviceId}/cmd`;
}

/** AWS 有效 QoS（ADP-002@1.0.0：cmd specified 2 → AWS 实际 1）。 */
export const COMMAND_PUBLISH_QOS = 1 as const;

// ---------- 行类型与数据访问 ----------

export interface CommandPublishRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
  readonly command: string;
  readonly requestedBy: string;
  readonly requestTime: Date;
  readonly timeoutSec: number;
  readonly expiresAt: Date | null;
  readonly remarks: string | null;
}

function deviceCommands(client: DbClient): {
  findFirst(args: { where: Record<string, unknown> }): Promise<CommandPublishRow | null>;
  findMany(args: Record<string, unknown>): Promise<CommandPublishRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
} {
  return (client as unknown as Record<string, unknown>).deviceCommand as never;
}

function devicesOf(client: DbClient): {
  findFirst(args: { where: Record<string, unknown> }): Promise<{ lifecycleStatus: string } | null>;
} {
  return (client as unknown as Record<string, unknown>).device as never;
}

function attemptsOf(client: DbClient): {
  count(args: { where: Record<string, unknown> }): Promise<number>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
} {
  return (client as unknown as Record<string, unknown>).commandAttempt as never;
}

function safeProviderErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(name) && name !== 'Error' ? name : 'MQTT_PUBLISH_FAILED';
}

async function finishPublishAttempt(
  deps: CommandPublisherDeps,
  input: {
    readonly command: CommandPublishRow;
    readonly attemptNo: number;
    readonly startedAt: Date;
    readonly finishedAt: Date;
    readonly outcome: 'PUBLISHED' | 'PUBLISH_FAILED';
    readonly errorCode: string | null;
    readonly providerMessageId: string | null;
  },
): Promise<void> {
  await withTransaction(deps.client, async (tx) => {
    await attemptsOf(tx).create({
      data: {
        commandId: input.command.id,
        attemptNo: input.attemptNo,
        publishedAt: input.startedAt,
        outcome: input.outcome,
        errorCode: input.errorCode,
        providerMessageId: input.providerMessageId,
        finishedAt: input.finishedAt,
      },
    });
    const updated = await deviceCommands(tx).updateMany({
      where: { id: input.command.id, status: 'PUBLISHING' },
      data: { status: input.outcome },
    });
    if (updated.count !== 1) throw commandConflict('Command publish ownership was lost');
    await recordAudit(tx, {
      objectType: 'device_command',
      objectId: input.command.id,
      action: 'command.publish',
      result: input.outcome === 'PUBLISHED' ? 'SUCCESS' : 'FAILURE',
      actorId: 'system:command-publisher',
      reason: input.errorCode ?? 'MQTT publish accepted',
      afterValue: {
        status: input.outcome,
        attemptNo: input.attemptNo,
        providerMessageId: input.providerMessageId,
      },
    });
  });
}

// ---------- Payload 序列化（cmd.schema.json：meta+data） ----------

export function buildCommandPayload(command: CommandPublishRow, at: Date): string {
  const data: Record<string, unknown> = {
    command: command.command,
    requestedBy: command.requestedBy,
    requestTime: command.requestTime.toISOString(),
    timeoutSec: command.timeoutSec,
    ...(command.remarks !== null ? { remarks: command.remarks } : {}),
  };
  return JSON.stringify({
    meta: { id: command.id, ts: at.toISOString() },
    data,
  });
}

// ---------- 发布 ----------

export interface CommandPublishResult {
  readonly commandId: string;
  /** PUBLISHED（本次成功）| PUBLISH_FAILED（传输失败，可重试）| REPLAYED_PUBLISHED */
  readonly status: 'PUBLISHED' | 'PUBLISH_FAILED' | 'REPLAYED_PUBLISHED';
  readonly attemptNo: number;
}

export async function publishCommand(deps: CommandPublisherDeps, commandId: string): Promise<CommandPublishResult> {
  const now = deps.now?.() ?? new Date();
  const commands = deviceCommands(deps.client);

  const command = await commands.findFirst({ where: { id: commandId } });
  if (!command) throw commandNotFound();

  // 发布前重新校验：设备生命周期（Retired 不发布）
  const device = await devicesOf(deps.client).findFirst({ where: { id: command.deviceId } });
  if (!device) throw commandNotFound();
  if (device.lifecycleStatus === 'Retired') {
    throw commandStateNotAllowed('Device is Retired; command cannot be published');
  }
  // 超时后拒绝再次发布（expiresAt = requestTime + timeoutSec，BE-CMD-01 落库）
  if (command.expiresAt && now.getTime() >= command.expiresAt.getTime()) {
    throw commandConflict('Command has expired');
  }
  // 幂等：已发布 → 重放（不再重复发消息）
  if (command.status === 'PUBLISHED') {
    return { commandId: command.id, status: 'REPLAYED_PUBLISHED', attemptNo: 0 };
  }
  if (command.status !== 'AUTHORIZED' && command.status !== 'PUBLISH_FAILED') {
    throw commandConflict(`Command ${command.id} is not publishable from status ${command.status}`);
  }

  // 抢占发布权：只允许已授权或明确的传输失败重试。
  const claimed = await commands.updateMany({
    where: {
      id: command.id,
      status: { in: ['AUTHORIZED', 'PUBLISH_FAILED'] },
    },
    data: { status: 'PUBLISHING' },
  });
  if (claimed.count !== 1) {
    const current = await commands.findFirst({ where: { id: command.id } });
    if (current?.status === 'PUBLISHED') {
      return { commandId: command.id, status: 'REPLAYED_PUBLISHED', attemptNo: 0 };
    }
    throw commandConflict(`Command ${command.id} is not publishable from status ${current?.status ?? command.status}`);
  }

  // 执行发布（此时持有 PUBLISHING 状态）
  const attemptNo = (await attemptsOf(deps.client).count({ where: { commandId: command.id } })) + 1;
  const payload = buildCommandPayload(command, now);
  let receipt: void | { readonly providerMessageId?: string };
  try {
    receipt = await deps.mqtt.publish({
      topic: commandTopicOf(command.deviceId),
      payload,
      qos: COMMAND_PUBLISH_QOS,
    });
  } catch (error) {
    const errorCode = safeProviderErrorCode(error);
    await finishPublishAttempt(deps, {
      command,
      attemptNo,
      startedAt: now,
      finishedAt: deps.now?.() ?? new Date(),
      outcome: 'PUBLISH_FAILED',
      errorCode,
      providerMessageId: null,
    });
    return { commandId: command.id, status: 'PUBLISH_FAILED', attemptNo };
  }
  await finishPublishAttempt(deps, {
    command,
    attemptNo,
    startedAt: now,
    finishedAt: deps.now?.() ?? new Date(),
    outcome: 'PUBLISHED',
    errorCode: null,
    providerMessageId: receipt?.providerMessageId ?? null,
  });
  return { commandId: command.id, status: 'PUBLISHED', attemptNo };
}

export interface CommandPublishBatchResult {
  readonly selectedCount: number;
  readonly publishedCount: number;
  readonly transportFailedCount: number;
}

/** EventBridge 批处理入口：只选择已授权或明确的传输失败命令，设备执行 FAILED 永不进入重试集合。 */
export async function publishPendingCommands(
  deps: CommandPublisherDeps,
  limit = 50,
): Promise<CommandPublishBatchResult> {
  const now = deps.now?.() ?? new Date();
  const pending = await deviceCommands(deps.client).findMany({
    where: {
      status: { in: ['AUTHORIZED', 'PUBLISH_FAILED'] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ requestTime: 'asc' }, { id: 'asc' }],
    take: limit,
  });
  let publishedCount = 0;
  let transportFailedCount = 0;
  for (const command of pending) {
    const result = await publishCommand(deps, command.id);
    if (result.status === 'PUBLISH_FAILED') transportFailedCount += 1;
    else publishedCount += 1;
  }
  return { selectedCount: pending.length, publishedCount, transportFailedCount };
}
