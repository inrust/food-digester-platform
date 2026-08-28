/**
 * BE-CUS-01 Customer Repository：列表（键集游标分页 + 状态筛选）、详情与乐观锁写入。
 *
 * Customer 是平台级实体（customers 表无 customer_id 列），不使用 DB-02 scopedRepository；
 * 跨 Customer 隔离由 Handler 授权层（customer:read 权限 / Customer 角色仅自身）保证，
 * 全部写操作经 DOM-03 audited 写审计。默认查询排除软删除（deletedAt IS NULL）。
 */
import type { DbClient } from '@fdp/database';
import { decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { Page } from '@fdp/database';
import { customerNotFound, validationFailed, versionConflict } from './errors.js';

export const CUSTOMER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export interface CustomerRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/** 对外 DTO：不暴露 deletedAt（软删除为实现细节，默认查询已排除）。 */
export interface CustomerDto {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toCustomerDto(record: CustomerRecord): CustomerDto {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

interface CustomerDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CustomerRecord | null>;
  findMany(args: Record<string, unknown>): Promise<CustomerRecord[]>;
  create(args: { data: Record<string, unknown> }): Promise<CustomerRecord>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export function customers(client: DbClient): CustomerDelegate {
  return (client as unknown as Record<string, unknown>).customer as CustomerDelegate;
}

/** 按 id 查询（排除已软删除）；不存在返回 null。 */
export async function findCustomerById(client: DbClient, id: string): Promise<CustomerRecord | null> {
  return customers(client).findFirst({ where: { id, deletedAt: null } });
}

export interface CustomerListOptions {
  readonly status?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

/** 键集游标分页（id ASC，DB-02 游标语义）；status 限 ACTIVE|SUSPENDED。 */
export async function listCustomers(client: DbClient, options: CustomerListOptions): Promise<Page<CustomerRecord>> {
  const limit = normalizeLimit(options.limit ?? null);
  if (options.status !== undefined && !(CUSTOMER_STATUSES as readonly string[]).includes(options.status)) {
    throw validationFailed(`status must be one of: ${CUSTOMER_STATUSES.join(', ')}`);
  }
  const after = decodeKeysetCursor(options.cursor ?? null);
  const where: Record<string, unknown> = { deletedAt: null };
  if (options.status) where.status = options.status;
  if (after) where.id = { gt: after };
  const rows = await customers(client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null };
}

/**
 * 乐观锁条件更新：(id, version=expectedVersion, 未删除) 命中才写入并自增版本。
 * 未命中时区分 404（不存在/已删除）与 409（版本冲突）。
 */
export async function updateCustomerWithVersion(
  client: DbClient,
  id: string,
  expectedVersion: number,
  data: Record<string, unknown>,
): Promise<CustomerRecord> {
  const { count } = await customers(client).updateMany({
    where: { id, version: expectedVersion, deletedAt: null },
    data: { ...data, version: { increment: 1 } },
  });
  if (count === 1) {
    const updated = await customers(client).findFirst({ where: { id } });
    if (!updated) throw customerNotFound();
    return updated;
  }
  const current = await findCustomerById(client, id);
  if (!current) throw customerNotFound();
  throw versionConflict();
}

// ---------- 删除约束（功能边界：有关联有效设备/License 时禁止删除） ----------

interface CountDelegate {
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

function devices(client: DbClient): CountDelegate {
  return (client as unknown as Record<string, unknown>).device as CountDelegate;
}

function licenses(client: DbClient): CountDelegate {
  return (client as unknown as Record<string, unknown>).license as CountDelegate;
}

/** 有效设备：已归属该 Customer 且未达终态（Rejected=接入被拒；Retired=已退役）。 */
export const INACTIVE_DEVICE_LIFECYCLES = ['Rejected', 'Retired'] as const;

/** 有效 License 状态（DOM-02 isLicenseEffective 的状态集合；删除约束按状态判定，不做时间派生）。 */
export const EFFECTIVE_LICENSE_STATUSES = ['Issued', 'Active', 'ExpiringSoon', 'Renewed'] as const;

export async function countActiveDevices(client: DbClient, customerId: string): Promise<number> {
  return devices(client).count({
    where: { customerId, lifecycleStatus: { notIn: [...INACTIVE_DEVICE_LIFECYCLES] } },
  });
}

export async function countEffectiveLicenses(client: DbClient, customerId: string): Promise<number> {
  return licenses(client).count({ where: { customerId, status: { in: [...EFFECTIVE_LICENSE_STATUSES] } } });
}
