/**
 * BE-CNS-01 耗材投影领域规则（纯领域，无 IO）。
 *
 * 事实源：DEC-008（contracts/domain/consumables-policy.json，@1.0.0 frozen）。
 * - 类型代码封闭集合：CARBON_FILTER、BIO_ADDITIVE（与策略 JSON 的一致性由单测强制；
 *   冻结或新增类型必须走 DEC-008 决策变更并整体替换本常量）；
 * - 数据来源 device-reported-only：仅保存设备上报值；云端不得推算百分比/寿命；
 *   未上报维度为 null（查询侧显示 unknown），禁止默认 50% 等臆测值；
 * - 原始名称经字典映射（原型两列："碳包/碳滤网"→CARBON_FILTER、"活性菌/添加剂"→BIO_ADDITIVE，
 *   不混用）；未知名称失败关闭（UNKNOWN_CONSUMABLE_TYPE，不入库）；
 * - 百分比限定 0~100 整数；每设备每耗材只维护最新投影，乱序消息不得倒退覆盖。
 */

export const CONSUMABLE_TYPES = ['CARBON_FILTER', 'BIO_ADDITIVE'] as const;
export type ConsumableType = (typeof CONSUMABLE_TYPES)[number];

/** DEC-008@1.0.0 冻结值：observedAt 距今超过 24h 视为 stale。 */
export const CONSUMABLE_STALE_AFTER_MS = 24 * 3_600_000;

export class ConsumableError extends Error {
  override readonly name = 'ConsumableError';
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'UNKNOWN_CONSUMABLE_TYPE' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

/**
 * 原始上报名称字典（DEC-008 冻结值；key 为 trim + 小写归一后的名称）。
 * 原型两列严格分离："碳包/碳滤网"只映射 CARBON_FILTER，"活性菌/添加剂"只映射 BIO_ADDITIVE。
 */
export const CONSUMABLE_RAW_NAME_DICTIONARY: Readonly<Record<string, ConsumableType>> = {
  carbon_filter: 'CARBON_FILTER',
  'carbon filter': 'CARBON_FILTER',
  carbonfilter: 'CARBON_FILTER',
  carbon: 'CARBON_FILTER',
  碳包: 'CARBON_FILTER',
  碳滤网: 'CARBON_FILTER',
  bio_additive: 'BIO_ADDITIVE',
  'bio additive': 'BIO_ADDITIVE',
  bioadditive: 'BIO_ADDITIVE',
  bio: 'BIO_ADDITIVE',
  活性菌: 'BIO_ADDITIVE',
  添加剂: 'BIO_ADDITIVE',
} as const;

/** 原始名称 → 类型代码；未知名称失败关闭（抛 ConsumableError，禁止入库/臆测）。 */
export function mapConsumableRawName(rawName: string): ConsumableType {
  const normalized = rawName.trim().toLowerCase();
  const type = CONSUMABLE_RAW_NAME_DICTIONARY[normalized];
  if (type === undefined) {
    throw new ConsumableError('UNKNOWN_CONSUMABLE_TYPE', `Unknown consumable raw name: ${rawName}`);
  }
  return type;
}

/** 百分比校验：0~100 整数或 null（未上报）。 */
export function assertRemainingPercent(value: number | null): void {
  if (value === null) return;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new ConsumableError('VALIDATION_FAILED', 'remainingPercent must be an integer between 0 and 100, or null');
  }
}

export interface ConsumableProjectionState {
  readonly observedAt: Date | null;
  readonly sourceMessageId: string | null;
}

export type ProjectionDecision = 'apply' | 'replay' | 'stale-rejected';

/**
 * 乱序倒退防护（每设备每耗材仅最新投影）：
 * - 无既有投影或 incoming.observedAt 更新 → apply；
 * - 同 observedAt 且同 sourceMessageId → replay（幂等，无写入语义）；
 * - 其余（更旧，或同时刻不同消息）→ stale-rejected（旧消息不覆盖新值）。
 */
export function decideProjectionUpdate(
  existing: ConsumableProjectionState | null,
  incoming: { readonly observedAt: Date; readonly sourceMessageId: string },
): ProjectionDecision {
  if (existing === null || existing.observedAt === null) return 'apply';
  if (incoming.observedAt.getTime() > existing.observedAt.getTime()) return 'apply';
  if (
    incoming.observedAt.getTime() === existing.observedAt.getTime() &&
    incoming.sourceMessageId === existing.sourceMessageId
  ) {
    return 'replay';
  }
  return 'stale-rejected';
}

/** stale 派生（读取时点）：未上报或 observedAt 超过阈值 → true。 */
export function isConsumableStale(observedAt: Date | null, at: Date): boolean {
  if (observedAt === null) return true;
  return at.getTime() - observedAt.getTime() > CONSUMABLE_STALE_AFTER_MS;
}

// ---------- 耗材更换申请状态机（BE-CNS-02） ----------

/** 申请状态封闭集合（与 DB CHECK 一致，大写）。 */
export const CONSUMABLE_REQUEST_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED'] as const;
export type ConsumableRequestStatus = (typeof CONSUMABLE_REQUEST_STATUSES)[number];

/** 开放状态：同设备同耗材存在开放申请时重复申请幂等返回现有记录。 */
export const OPEN_REQUEST_STATUSES = ['PENDING', 'PROCESSING'] as const;

/** 合法迁移表（跳级/重复处理 → CONFLICT）。 */
export const CONSUMABLE_REQUEST_TRANSITIONS: Readonly<
  Record<ConsumableRequestStatus, readonly ConsumableRequestStatus[]>
> = {
  PENDING: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
} as const;

/** 状态迁移校验：非法迁移（跳级/重复处理/终态）抛 CONFLICT。 */
export function assertConsumableRequestTransition(from: ConsumableRequestStatus, to: ConsumableRequestStatus): void {
  if (!(CONSUMABLE_REQUEST_TRANSITIONS[from] as readonly string[]).includes(to)) {
    throw new ConsumableError('CONFLICT', `Invalid consumable request transition: ${from} -> ${to}`);
  }
}

/** 申请类型校验：封闭集合外 → VALIDATION_FAILED（查询/创建入口共用）。 */
export function assertKnownConsumableType(type: string): ConsumableType {
  if (!(CONSUMABLE_TYPES as readonly string[]).includes(type)) {
    throw new ConsumableError('VALIDATION_FAILED', `consumableType must be one of ${CONSUMABLE_TYPES.join(', ')}`);
  }
  return type as ConsumableType;
}
