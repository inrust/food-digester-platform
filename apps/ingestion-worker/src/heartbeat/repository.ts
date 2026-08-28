/**
 * BE-IOT-04 Heartbeat Repository：每设备唯一 latest state 写入（device_latest_state，DB-01）。
 *
 * - RDS 只保留最新状态：每设备一行，全字段覆盖写；
 * - 乱序旧 Heartbeat 不倒退：条件更新 lastHeartbeatAt < occurredAt 才覆盖；
 *   并发创建败方（P2002）按 stale 处理（胜方已写入更新状态）；
 * - 不进入 Raw Archive：本模块不写 outbox（归档事件归 Telemetry/Report 等 Handler）。
 */
import type { DbClient } from '@fdp/database';

export type LatestStateApplyResult = 'created' | 'updated' | 'stale';

interface LatestStateDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{ deviceId: string } | null>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function latestState(client: DbClient): LatestStateDelegate {
  return (client as unknown as Record<string, unknown>).deviceLatestState as LatestStateDelegate;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * 条件覆盖 latest state：仅当 occurredAt 新于已存 lastHeartbeatAt（或尚无记录）时写入。
 * state 不含 deviceId；lastHeartbeatAt 由调用方放入 state。
 */
export async function applyLatestState(
  client: DbClient,
  deviceId: string,
  state: Record<string, unknown>,
  occurredAt: Date,
): Promise<LatestStateApplyResult> {
  const { count } = await latestState(client).updateMany({
    where: { deviceId, OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: occurredAt } }] },
    data: state,
  });
  if (count === 1) return 'updated';

  const existing = await latestState(client).findFirst({ where: { deviceId } });
  if (existing) return 'stale'; // 乱序旧消息：不倒退最新状态

  try {
    await latestState(client).create({ data: { deviceId, ...state } });
    return 'created';
  } catch (err) {
    if (isUniqueViolation(err)) return 'stale'; // 并发首创建败方
    throw err;
  }
}
