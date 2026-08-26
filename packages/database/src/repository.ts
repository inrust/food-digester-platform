/**
 * DB-02 Customer scope Repository。
 *
 * 规则（技术对接要求）：
 * - scopedRepository：所有读写强制注入 customerId（缺失抛 ScopeRequiredError）；
 *   create 自动写入 customerId，查询/更新自动过滤 customerId；
 * - platformRepository：平台跨 Customer 的显式管理接口（命名即警示，调用需平台角色）；
 * - 乐观锁：updateWithVersion 以 (id, customerId, version) 条件更新并自增，
 *   版本不一致抛 VersionConflictError（mapDbErrorToHttp → 409 VERSION_CONFLICT）；
 * - 软删除策略：仅 opts.softDelete 的实体（customers/sites）支持 softDelete/restore，
 *   默认查询排除已删除；审计与状态历史等无 deletedAt 的表调用 softDelete 抛错。
 */
import {
  AppendOnlyViolationError,
  CursorInvalidError,
  RecordNotFoundError,
  ScopeRequiredError,
  SoftDeleteNotSupportedError,
  VersionConflictError,
} from './errors.js';
import { decodeKeysetCursor, encodeKeysetCursor, normalizeLimit, type Page, type PageArgs } from './pagination.js';
import type { DbClient } from './transaction.js';

/** append-only 表（审计与状态历史）：业务 Repository 不提供更新/删除路径。 */
export const APPEND_ONLY_MODELS: ReadonlySet<string> = new Set([
  'auditLog',
  'deviceStateHistory',
  'licenseHistory',
  'otaStatusHistory',
  'ingestionReceipt',
  'ingestionGap',
]);

export interface Scope {
  readonly customerId: string;
}

/** Prisma 模型 delegate 的最小结构（内部实现细节，不对外暴露 any 泄漏）。 */
interface Delegate {
  findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  findFirst(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  create(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args: Record<string, unknown>): Promise<number>;
}

function delegateOf(client: DbClient, model: string): Delegate {
  const delegate = (client as unknown as Record<string, unknown>)[model] as Delegate | undefined;
  if (!delegate || typeof delegate.findMany !== 'function') {
    throw new Error(`未知 Prisma 模型: ${model}`);
  }
  return delegate;
}

function requireScope(model: string, scope: Scope | undefined): string {
  if (!scope?.customerId) throw new ScopeRequiredError(model);
  return scope.customerId;
}

interface RepoOptions {
  /** 软删除策略：仅需要恢复的业务实体（customers/sites）开启。 */
  readonly softDelete?: boolean;
}

export interface ScopedRepository {
  findById(id: string, scope: Scope, opts?: { includeDeleted?: boolean }): Promise<Record<string, unknown> | null>;
  list(scope: Scope, page?: PageArgs, opts?: { includeDeleted?: boolean }): Promise<Page<Record<string, unknown>>>;
  count(scope: Scope): Promise<number>;
  create(data: Record<string, unknown>, scope: Scope): Promise<Record<string, unknown>>;
  updateWithVersion(
    id: string,
    expectedVersion: number,
    data: Record<string, unknown>,
    scope: Scope,
  ): Promise<Record<string, unknown>>;
  softDelete(id: string, scope: Scope): Promise<void>;
  restore(id: string, scope: Scope): Promise<void>;
}

function baseListQuery(model: string, where: Record<string, unknown>, page: PageArgs, delegate: Delegate) {
  const limit = normalizeLimit(page.limit);
  const after = decodeKeysetCursor(page.cursor);
  const fullWhere = after ? { ...where, id: { gt: after } } : where;
  return { limit, fullWhere, delegate, model };
}

function toPage(rows: Record<string, unknown>[], limit: number): Page<Record<string, unknown>> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > limit && last ? encodeKeysetCursor(String(last.id)) : null;
  return { items, nextCursor };
}

/** Customer 范围 Repository：缺少 scope 的查询无法执行（ScopeRequiredError）。 */
export function scopedRepository(client: DbClient, model: string, options: RepoOptions = {}): ScopedRepository {
  const softDelete = options.softDelete === true;
  const visible = (where: Record<string, unknown>, includeDeleted?: boolean) =>
    softDelete && !includeDeleted ? { ...where, deletedAt: null } : where;

  return {
    async findById(id, scope, opts) {
      const customerId = requireScope(model, scope);
      return delegateOf(client, model).findFirst({ where: visible({ id, customerId }, opts?.includeDeleted) });
    },

    async list(scope, page = {}, opts) {
      const customerId = requireScope(model, scope);
      const delegate = delegateOf(client, model);
      const { limit, fullWhere } = baseListQuery(model, visible({ customerId }, opts?.includeDeleted), page, delegate);
      const rows = await delegate.findMany({ where: fullWhere, orderBy: { id: 'asc' }, take: limit + 1 });
      return toPage(rows, limit);
    },

    async count(scope) {
      const customerId = requireScope(model, scope);
      return delegateOf(client, model).count({ where: visible({ customerId }) });
    },

    async create(data, scope) {
      const customerId = requireScope(model, scope);
      return delegateOf(client, model).create({ data: { ...data, customerId } });
    },

    async updateWithVersion(id, expectedVersion, data, scope) {
      if (APPEND_ONLY_MODELS.has(model)) throw new AppendOnlyViolationError(model, 'updateWithVersion');
      const customerId = requireScope(model, scope);
      const delegate = delegateOf(client, model);
      const { count } = await delegate.updateMany({
        where: { id, customerId, version: expectedVersion },
        data: { ...data, version: { increment: 1 } },
      });
      if (count === 1) {
        const updated = await delegate.findFirst({ where: { id, customerId } });
        if (!updated) throw new RecordNotFoundError(model, id);
        return updated;
      }
      const current = await delegate.findFirst({ where: visible({ id, customerId }, true) });
      if (!current) throw new RecordNotFoundError(model, id);
      throw new VersionConflictError(model, id, expectedVersion, Number(current.version));
    },

    async softDelete(id, scope) {
      if (APPEND_ONLY_MODELS.has(model)) throw new AppendOnlyViolationError(model, 'softDelete');
      if (!softDelete) throw new SoftDeleteNotSupportedError(model);
      const customerId = requireScope(model, scope);
      const delegate = delegateOf(client, model);
      const { count } = await delegate.updateMany({
        where: { id, customerId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (count === 0) throw new RecordNotFoundError(model, id);
    },

    async restore(id, scope) {
      if (!softDelete) throw new SoftDeleteNotSupportedError(model);
      const customerId = requireScope(model, scope);
      const delegate = delegateOf(client, model);
      const { count } = await delegate.updateMany({
        where: { id, customerId, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      if (count === 0) throw new RecordNotFoundError(model, id);
    },
  };
}

/**
 * 平台跨 Customer 显式管理接口。
 * 仅平台角色（PlatformSuperAdmin/PlatformOperator/Auditor）的后端服务可调用；
 * 调用必须写审计（DOM-03）。命名即边界：业务接口禁止使用本工厂。
 */
export function platformRepository(client: DbClient, model: string) {
  return {
    async findById(id: string): Promise<Record<string, unknown> | null> {
      return delegateOf(client, model).findFirst({ where: { id } });
    },
    async list(page: PageArgs = {}): Promise<Page<Record<string, unknown>>> {
      const delegate = delegateOf(client, model);
      const { limit, fullWhere } = baseListQuery(model, {}, page, delegate);
      const rows = await delegate.findMany({ where: fullWhere, orderBy: { id: 'asc' }, take: limit + 1 });
      return toPage(rows, limit);
    },
    async count(): Promise<number> {
      return delegateOf(client, model).count({});
    },
  };
}

export { CursorInvalidError };
