/**
 * BE-CMD-02 Command MQTT 发布器（框架无关；注入式 MqttPublisher 端口，无 AWS 依赖——部署层接 IoT Data Plane 实现）。
 *
 * 事实源与规则：
 * - Topic：CT-03 topic-catalog `bnx/device/{deviceId}/cmd`；Payload：cmd.schema.json（Envelope meta+data，无 audit 域）；
 *   meta.id 即 commandId（DEC-006 幂等键，下行 meta.seq 可选，V1 不发送 seq）；
 * - QoS：目录 specified 2 → AWS 有效 QoS 1（ADP-002@1.0.0 决策引用：QoS 2→1 为 AWS 技术适配，不删除 ACK/超时/审计机制）；
 * - 发布前重校验：状态（AUTHORIZED 可发 / FAILED 可重试）+ expiresAt（超时后拒绝再次发布）+ 设备生命周期 Retired 拒绝；
 * - 状态机：AUTHORIZED → PUBLISHED（成功）/ FAILED（发布异常）；FAILED 未过期可重试（attempts 逐行记录，attemptNo 递增）；
 * - 发布重试不创建新 commandId（幂等键 = meta.id = commandId，DEC-006）；
 * - 超时后拒绝再次发布（expiresAt 已过 → CONFLICT，不发消息）；
 * - 功能边界：不等待设备同步响应、不推测执行成功（ACK/超时扫描属 BE-CMD-03）。
 */
import type { DbClient } from '@fdp/database';
import { commandConflict, commandNotFound, commandStateNotAllowed } from './errors.js';

// ---------- 注入端口（部署层接 AWS IoT Data Plane） ----------

export interface CommandMqttPublishInput {
  readonly topic: string;
  readonly payload: string;
  /** AWS 有效 QoS（ADP-002@1.0.0：cmd specified 2 → AWS 实际 QoS 1）。 */
  readonly qos: 1;
}

export interface CommandMqttPublisher {
  publish(input: CommandMqttPublishInput): Promise<void>;
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
  /** PUBLISHED（本次成功）| FAILED（发布失败，可重试）| REPLAYED_PUBLISHED（此前已发布，幂等重放未重复发） */
  readonly status: 'PUBLISHED' | 'FAILED' | 'REPLAYED_PUBLISHED';
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
  if (command.status !== 'AUTHORIZED' && command.status !== 'FAILED') {
    throw commandConflict(`Command ${command.id} is not publishable from status ${command.status}`);
  }

  // 抢占发布权：条件更新（仅 AUTHORIZED/FAILED 且未过期）并发兜底；超时后拒绝再次发布
  const claimed = await commands.updateMany({
    where: {
      id: command.id,
      status: { in: ['AUTHORIZED', 'FAILED'] },
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
  try {
    await deps.mqtt.publish({
      topic: commandTopicOf(command.deviceId),
      payload,
      qos: COMMAND_PUBLISH_QOS,
    });
  } catch {
    await attemptsOf(deps.client).create({
      data: { commandId: command.id, attemptNo, publishedAt: now },
    });
    await commands.updateMany({
      where: { id: command.id, status: 'PUBLISHING' },
      data: { status: 'FAILED' },
    });
    return { commandId: command.id, status: 'FAILED', attemptNo };
  }
  await attemptsOf(deps.client).create({
    data: { commandId: command.id, attemptNo, publishedAt: now },
  });
  await commands.updateMany({
    where: { id: command.id, status: 'PUBLISHING' },
    data: { status: 'PUBLISHED' },
  });
  return { commandId: command.id, status: 'PUBLISHED', attemptNo };
}
