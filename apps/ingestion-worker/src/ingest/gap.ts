/**
 * BE-IOT-03 序号缺口服务（ingestion_gaps，DB-01 表结构）。
 *
 * - 检测：新 receipt 落库时（同事务调用），若同 deviceId+topicType 已知最大 seq 与新 seq 不连续，
 *   追加缺口记录 { expectedSeq = maxSeq + 1, receivedSeq = 新 seq }（缺失区间 = [expectedSeq, receivedSeq-1]）；
 * - 解除：迟到消息到达时检查包含该 seq 的未解除缺口，区间 [expectedSeq, receivedSeq-1]
 *   被 receipt 全覆盖 → 置 resolvedAt；
 * - 查询：gapStatus 返回未解除缺口（缺口状态查询）。
 *
 * 功能边界：不请求设备补发、不做人工缺口处置；缺口检测为追加式信息记录，不阻塞后续消息。
 * 并发语义：processWithReceipt 在插入 receipt 前按 device+topic 获取事务级 advisory lock，
 * 因而本函数观察到同一消息流的已提交前序状态，不会因不同 seq 并发首处理漏记缺口。
 */
import type { DbClient } from '@fdp/database';

export interface GapKey {
  readonly deviceId: string;
  readonly topicType: string;
  readonly seq: number;
}

export interface GapStatusView {
  readonly id: string;
  readonly deviceId: string;
  readonly topicType: string;
  /** 缺失区间起点（含）。 */
  readonly missingFromSeq: number;
  /** 缺失区间终点（含）。 */
  readonly missingToSeq: number;
  readonly detectedAt: Date;
}

interface GapRow {
  readonly id: string;
  readonly expectedSeq: number;
  readonly receivedSeq: number;
  readonly detectedAt: Date;
}

interface GapDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }): Promise<GapRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
}

interface ReceiptReadDelegate {
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy: Record<string, unknown>;
  }): Promise<{ seq: number | null } | null>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

function gaps(client: DbClient): GapDelegate {
  return (client as unknown as Record<string, unknown>).ingestionGap as GapDelegate;
}

function receipts(client: DbClient): ReceiptReadDelegate {
  return (client as unknown as Record<string, unknown>).ingestionReceipt as ReceiptReadDelegate;
}

/**
 * 新 receipt 落库后的缺口检测与解除（在 receipt 同事务内调用；新 receipt 必须已插入）。
 */
export async function recordGapForNewReceipt(client: DbClient, key: GapKey): Promise<void> {
  const previous = await receipts(client).findFirst({
    where: { deviceId: key.deviceId, topicType: key.topicType, seq: { lt: key.seq } },
    orderBy: { seq: 'desc' },
  });
  const maxSeq = previous?.seq ?? null;
  const ensureGap = async (expectedSeq: number, receivedSeq: number): Promise<void> => {
    if (expectedSeq >= receivedSeq) return;
    // 去重：已有未解除缺口覆盖该缺失区间（如乱序补到触发的重叠检测）则不再追加
    const covering = await gaps(client).findMany({
      where: {
        deviceId: key.deviceId,
        topicType: key.topicType,
        resolvedAt: null,
        expectedSeq: { lte: expectedSeq },
        receivedSeq: { gte: receivedSeq },
      },
    });
    if (covering.length === 0) {
      await gaps(client).create({
        data: {
          deviceId: key.deviceId,
          topicType: key.topicType,
          expectedSeq,
          receivedSeq,
        },
      });
    }
  };
  if (maxSeq !== null) await ensureGap(maxSeq + 1, key.seq);

  // 若较大 seq 先获得锁，较小 seq 随后到达，反向检查已提交后继也能补建缺口。
  const next = await receipts(client).findFirst({
    where: { deviceId: key.deviceId, topicType: key.topicType, seq: { gt: key.seq } },
    orderBy: { seq: 'asc' },
  });
  if (next?.seq !== null && next?.seq !== undefined) {
    await ensureGap(key.seq + 1, next.seq);
  }
  await resolveFilledGaps(client, key);
}

/** 迟到消息补齐检查：覆盖包含本 seq 的未解除缺口，区间被 receipt 全覆盖则解除。 */
async function resolveFilledGaps(client: DbClient, key: GapKey): Promise<void> {
  const candidates = await gaps(client).findMany({
    where: {
      deviceId: key.deviceId,
      topicType: key.topicType,
      resolvedAt: null,
      expectedSeq: { lte: key.seq },
      receivedSeq: { gt: key.seq },
    },
  });
  for (const gap of candidates) {
    const filled = await receipts(client).count({
      where: {
        deviceId: key.deviceId,
        topicType: key.topicType,
        seq: { gte: gap.expectedSeq, lt: gap.receivedSeq },
      },
    });
    if (filled >= gap.receivedSeq - gap.expectedSeq) {
      await gaps(client).updateMany({ where: { id: gap.id }, data: { resolvedAt: new Date() } });
    }
  }
}

/** 缺口状态查询：未解除缺口（缺失区间为 [missingFromSeq, missingToSeq]）。 */
export async function gapStatus(
  client: DbClient,
  query: { readonly deviceId: string; readonly topicType: string },
): Promise<GapStatusView[]> {
  const rows = await gaps(client).findMany({
    where: { deviceId: query.deviceId, topicType: query.topicType, resolvedAt: null },
    orderBy: { detectedAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    deviceId: query.deviceId,
    topicType: query.topicType,
    missingFromSeq: row.expectedSeq,
    missingToSeq: row.receivedSeq - 1,
    detectedAt: row.detectedAt,
  }));
}
