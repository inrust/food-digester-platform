/**
 * BE-CUS-02 Site Repository：列表（键集游标分页 + customerId/region/subregion/status 筛选）、
 * 详情（含设备数量）与乐观锁写入。
 *
 * Site 归属唯一 Customer（customerId 不可变，DEC-011：Customer→Site→Device 层级）；
 * 设备数量经 `_count` 单查询聚合（无 N+1）；默认查询排除软删除（deletedAt IS NULL）。
 * 全部写操作经 DOM-03 audited 写审计（Service 层）。
 */
import type { DbClient } from '@fdp/database';
import { decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { Page } from '@fdp/database';
import { siteNameConflict, siteNotFound, siteValidationFailed, siteVersionConflict } from './errors.js';

export const SITE_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export interface SiteRecord {
  readonly id: string;
  readonly customerId: string;
  readonly name: string;
  readonly status: string;
  readonly region: string | null;
  readonly subregion: string | null;
  readonly address: string | null;
  readonly timezone: string;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly _count?: { readonly devices: number };
}

/** 对外 DTO：含设备数量；不暴露 deletedAt（软删除为实现细节）。 */
export interface SiteDto {
  readonly id: string;
  readonly customerId: string;
  readonly name: string;
  readonly status: string;
  readonly region: string | null;
  readonly subregion: string | null;
  readonly address: string | null;
  readonly timezone: string;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly deviceCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toSiteDto(record: SiteRecord): SiteDto {
  return {
    id: record.id,
    customerId: record.customerId,
    name: record.name,
    status: record.status,
    region: record.region,
    subregion: record.subregion,
    address: record.address,
    timezone: record.timezone,
    contactName: record.contactName,
    contactPhone: record.contactPhone,
    contactEmail: record.contactEmail,
    deviceCount: record._count?.devices ?? 0,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

interface SiteDelegate {
  findFirst(args: Record<string, unknown>): Promise<SiteRecord | null>;
  findMany(args: Record<string, unknown>): Promise<SiteRecord[]>;
  create(args: { data: Record<string, unknown> }): Promise<SiteRecord>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export function sites(client: DbClient): SiteDelegate {
  return (client as unknown as Record<string, unknown>).site as SiteDelegate;
}

/** Prisma 唯一约束冲突（P2002）判定。 */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

const DEVICE_COUNT_INCLUDE = { _count: { select: { devices: true } } } as const;

/** 按 id 查询（排除已软删除，含设备数量）；不存在返回 null。 */
export async function findSiteById(client: DbClient, id: string): Promise<SiteRecord | null> {
  return sites(client).findFirst({ where: { id, deletedAt: null }, include: DEVICE_COUNT_INCLUDE });
}

export interface SiteListOptions {
  readonly customerId?: string | undefined;
  readonly region?: string | undefined;
  readonly subregion?: string | undefined;
  readonly status?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

/** 键集游标分页（id ASC，DB-02 游标语义）；customerId/region/subregion/status 可筛选。 */
export async function listSites(client: DbClient, options: SiteListOptions): Promise<Page<SiteRecord>> {
  const limit = normalizeLimit(options.limit ?? null);
  if (options.status !== undefined && !(SITE_STATUSES as readonly string[]).includes(options.status)) {
    throw siteValidationFailed(`status must be one of: ${SITE_STATUSES.join(', ')}`);
  }
  const after = decodeKeysetCursor(options.cursor ?? null);
  const where: Record<string, unknown> = { deletedAt: null };
  if (options.customerId) where.customerId = options.customerId;
  if (options.region) where.region = options.region;
  if (options.subregion) where.subregion = options.subregion;
  if (options.status) where.status = options.status;
  if (after) where.id = { gt: after };
  const rows = await sites(client).findMany({
    where,
    include: DEVICE_COUNT_INCLUDE,
    orderBy: { id: 'asc' },
    take: limit + 1,
  });
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null };
}

/** 创建（同 Customer 重名 → CONFLICT）。 */
export async function createSiteRecord(client: DbClient, data: Record<string, unknown>): Promise<SiteRecord> {
  try {
    return await sites(client).create({ data });
  } catch (err) {
    if (isUniqueViolation(err)) throw siteNameConflict();
    throw err;
  }
}

/**
 * 乐观锁条件更新：(id, version=expectedVersion, 未删除) 命中才写入并自增版本。
 * 未命中时区分 404（不存在/已删除）与 409（版本冲突）；改名撞唯一约束 → CONFLICT。
 */
export async function updateSiteWithVersion(
  client: DbClient,
  id: string,
  expectedVersion: number,
  data: Record<string, unknown>,
): Promise<SiteRecord> {
  let count: number;
  try {
    ({ count } = await sites(client).updateMany({
      where: { id, version: expectedVersion, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    }));
  } catch (err) {
    if (isUniqueViolation(err)) throw siteNameConflict();
    throw err;
  }
  if (count === 1) {
    const updated = await sites(client).findFirst({ where: { id }, include: DEVICE_COUNT_INCLUDE });
    if (!updated) throw siteNotFound();
    return updated;
  }
  const current = await findSiteById(client, id);
  if (!current) throw siteNotFound();
  throw siteVersionConflict();
}

// ---------- 删除约束（功能边界：有关联设备时禁止删除） ----------

interface CountDelegate {
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

/** 关联设备数量（任意生命周期均算关联，设备不存地域真值——DEC-011）。 */
export async function countSiteDevices(client: DbClient, siteId: string): Promise<number> {
  const devices = (client as unknown as Record<string, unknown>).device as CountDelegate;
  return devices.count({ where: { siteId } });
}
