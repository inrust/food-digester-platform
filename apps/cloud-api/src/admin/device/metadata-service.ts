/**
 * BE-DEV-06 设备可编辑元数据领域服务（框架无关）。
 *
 * 规则（事实源：任务清单 BE-DEV-06、AUTH-01 权限矩阵、DOM-03 审计）：
 * - V1 字段白名单：仅 alias；请求体携带任何其他字段（deviceId/serialNumber/
 *   Customer/Site/Contract/License/生命周期/连接状态/固件/证书等）→ 400
 *   （不接受任意 JSON merge patch）；不修改 Assignment/Configuration 或设备端
 *   本地名称（本接口仅更新台账 alias，设备端经 Sync 稳定域感知，见 BE-SYNC etag）；
 * - alias 规范化与校验（DEC-019@1.0.0）：去除首尾空格并执行 NFC；null = 清除别名；非空时
 *   长度 1..64；同一 Customer 内唯一（trim 后精确匹配，大小写敏感；未分配设备在
 *   customerId=null 域内判重）→ 冲突 409 CONFLICT；
 * - If-Match 乐观锁：请求必须携带 If-Match 头 = 设备当前 updatedAt（ISO8601，来自
 *   GET 详情）；缺失/非法 → 400；与台账不一致 → 409 VERSION_CONFLICT；条件更新
 *   （id + updatedAt）并发漂移 → 409；单条条件更新保证失败请求不产生部分更新；
 * - 租户隔离：Customer 角色仅本 Customer 设备（assertCustomerScope，跨 Customer → 403）；
 * - 审计：device.metadata.update（before/after alias，DOM-03 同事务）。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { assertCustomerScope } from '@fdp/auth';
import { DEVICE_ALIAS_POLICY } from '@fdp/contracts/domain/device-alias-policy.js';
import { deviceAliasConflict, deviceNotFound, deviceValidationFailed, deviceVersionConflict } from './errors.js';

/** DEC-019@1.0.0 冻结长度上限（Unicode code point）。 */
export const DEVICE_ALIAS_MAX_LENGTH = DEVICE_ALIAS_POLICY.maximumLength;

interface DeviceRow {
  readonly id: string;
  readonly alias: string | null;
  readonly customerId: string | null;
  readonly updatedAt: Date;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function devices(client: DbClient): DeviceDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceDelegate;
}

export interface DeviceMetadataView {
  readonly deviceId: string;
  readonly alias: string | null;
  /** 更新后的台账时点（下次 If-Match 基准）。 */
  readonly updatedAt: string;
}

/** If-Match 解析：缺失/非法 → 400（值 = 设备 updatedAt 的 ISO8601）。 */
export function parseIfMatch(headerValue: string | undefined): Date {
  if (!headerValue) throw deviceValidationFailed('If-Match header is required');
  const time = Date.parse(headerValue);
  if (Number.isNaN(time)) throw deviceValidationFailed('If-Match must be a valid date-time');
  return new Date(time);
}

/** alias 规范化与值校验（trim + 长度；返回 null 表示清除别名）。 */
export function normalizeAlias(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== 'string') throw deviceValidationFailed('alias must be a string or null');
  const normalized = input.trim().normalize(DEVICE_ALIAS_POLICY.unicodeNormalization);
  if (normalized.length === 0) throw deviceValidationFailed('alias must not be empty');
  if ([...normalized].length > DEVICE_ALIAS_MAX_LENGTH) {
    throw deviceValidationFailed(`alias must be at most ${DEVICE_ALIAS_MAX_LENGTH} characters`);
  }
  return normalized;
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === 'P2002' || candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

export async function updateDeviceMetadata(
  deps: { readonly client: DbClient; readonly now?: () => Date },
  actor: ActorContext,
  deviceId: string,
  input: { readonly body: Record<string, unknown>; readonly ifMatch: string | undefined },
): Promise<DeviceMetadataView> {
  // 字段白名单：仅 alias（受保护字段/未知字段 → 400，不产生任何更新）
  for (const field of Object.keys(input.body)) {
    if (field !== 'alias') throw deviceValidationFailed(`field ${field} is not editable via this endpoint`);
  }
  if (!('alias' in input.body)) throw deviceValidationFailed('alias is required');
  const alias = normalizeAlias(input.body.alias);
  const expected = parseIfMatch(input.ifMatch);
  const now = deps.now?.() ?? new Date();

  const device = (await devices(deps.client).findFirst({ where: { id: deviceId } })) as DeviceRow | null;
  if (!device) throw deviceNotFound();
  // Customer 角色仅本 Customer 设备（与 BE-DEV-01 详情一致：跨 Customer → 403）
  if (actor.actorType === 'customer') assertCustomerScope(actor, device.customerId ?? '');
  // If-Match 与台账一致性（先校验再进入事务，避免无意义写）
  if (device.updatedAt.getTime() !== expected.getTime()) throw deviceVersionConflict();

  // 同一 Customer 内 alias 唯一（暂定规则：trim 后精确匹配、大小写敏感）
  if (alias !== null) {
    const conflict = (await devices(deps.client).findFirst({
      where: { customerId: device.customerId, alias, NOT: { id: deviceId } },
    })) as DeviceRow | null;
    if (conflict) throw deviceAliasConflict();
  }

  try {
    return await audited<DeviceMetadataView>(
      deps.client,
      {
        objectType: 'device',
        objectId: deviceId,
        action: 'device.metadata.update',
        reason: `alias "${device.alias ?? ''}" → "${alias ?? ''}"`,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: device.customerId,
        beforeValue: { alias: device.alias },
        afterValue: { alias },
      },
      async (tx) => {
        // 条件更新：并发漂移（updatedAt 已被其他写入改变）→ 409，不产生部分更新
        const { count } = await devices(tx).updateMany({
          where: { id: deviceId, updatedAt: expected },
          data: { alias, updatedAt: now },
        });
        if (count !== 1) throw deviceVersionConflict();
        return { deviceId, alias, updatedAt: now.toISOString() };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw deviceAliasConflict();
    throw error;
  }
}
