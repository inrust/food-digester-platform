import { observeDataPathPhase, observeDataPathSyncPhase } from '@fdp/observability';
/**
 * BE-AUD-01 审计日志查询领域服务（框架无关，只读）。
 *
 * 规则（事实源：DOM-03 append-only 审计、AUTH-01 权限矩阵、DEC-012@1.0.0 矩阵固定只读）：
 * - 数据源为 DOM-03 audit_logs（写入时已经 sanitizeAuditPayload 脱敏）；
 *   本服务读取详情时对 beforeValue/afterValue 再次脱敏兜底——敏感字段永不返回；
 * - 筛选：actorId/customerId/objectType/objectId/action/result(SUCCESS|FAILURE)/createdAt 时间范围；
 * - 排序：createdAt 倒序 + id 决胜；键集游标为复合键（createdAt|id，复用共享游标编码）；
 * - 租户隔离：Auditor/PlatformSuperAdmin 可跨 Customer 只读；Customer actor 强制
 *   actor.customerId scope（customerId 参数不一致 → 403；详情跨 Customer → 404）；
 *   V1 矩阵中 Customer 角色无 audit:read（handler 层 403），本层隔离为纵深防御；
 * - 只读：本模块不提供任何修改/删除路径（append-only 由 repository 拦截器强制）；
 * - 功能边界：不查询 CloudTrail 和基础设施日志。
 */
import type { DbClient, Page } from '@fdp/database';
import { decodeKeysetCursor, encodeKeysetCursor, normalizeLimit, sanitizeAuditPayload } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { auditForbidden, auditNotFound, auditValidationFailed } from './errors.js';

export interface AuditQueryDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

const AUDIT_RESULTS = ['SUCCESS', 'FAILURE'] as const;
const CURSOR_KEY_SEPARATOR = '|';

// ---------- 行类型与数据访问 ----------

interface AuditLogRow {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorRole: string | null;
  readonly customerId: string | null;
  readonly objectType: string;
  readonly objectId: string;
  readonly action: string;
  readonly reason: string | null;
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly result: string;
  readonly requestId: string | null;
  readonly createdAt: Date;
}

interface AuditLogDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<unknown>;
  findMany(args: Record<string, unknown>): Promise<unknown[]>;
}

function auditLogs(client: DbClient): AuditLogDelegate {
  return (client as unknown as Record<string, unknown>).auditLog as AuditLogDelegate;
}

// ---------- DTO ----------

export interface AuditLogView {
  readonly auditId: string;
  readonly actorId: string | null;
  readonly actorRole: string | null;
  readonly customerId: string | null;
  readonly objectType: string;
  readonly objectId: string;
  readonly action: string;
  readonly result: string;
  readonly createdAt: string;
}

export interface AuditLogDetailView extends AuditLogView {
  readonly reason: string | null;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
}

function toView(row: AuditLogRow): AuditLogView {
  return {
    auditId: row.id,
    actorId: row.actorId,
    actorRole: row.actorRole,
    customerId: row.customerId,
    objectType: row.objectType,
    objectId: row.objectId,
    action: row.action,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetailView(row: AuditLogRow): AuditLogDetailView {
  return {
    ...toView(row),
    reason: row.reason,
    requestId: row.requestId,
    ip: row.ip,
    userAgent: row.userAgent,
    // 读取时再次脱敏兜底（写入侧 DOM-03 已脱敏）——敏感字段永不返回
    beforeValue: sanitizeAuditPayload(row.beforeValue ?? null),
    afterValue: sanitizeAuditPayload(row.afterValue ?? null),
  };
}

// ---------- 租户隔离 ----------

/** Customer actor 强制自身 Customer scope；参数与身份不一致 → 403。返回生效的 customerId 筛选。 */
function resolveCustomerScope(actor: ActorContext, filterCustomerId: string | undefined): string | undefined {
  if (actor.actorType !== 'customer') return filterCustomerId;
  if (filterCustomerId !== undefined && filterCustomerId !== actor.customerId) {
    throw auditForbidden('Customer roles can only query their own customer scope');
  }
  return actor.customerId ?? '__none__';
}

// ---------- 时间解析 ----------

function parseTime(value: string | undefined, field: string): Date | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw auditValidationFailed(`${field} must be a valid date-time`);
  return new Date(time);
}

// ---------- 列表 ----------

export interface ListAuditLogsFilter {
  readonly actorId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly objectType?: string | undefined;
  readonly objectId?: string | undefined;
  readonly action?: string | undefined;
  readonly result?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

export async function listAuditLogs(
  deps: AuditQueryDeps,
  actor: ActorContext,
  filter: ListAuditLogsFilter = {},
): Promise<Page<AuditLogView>> {
  if (filter.result !== undefined && !(AUDIT_RESULTS as readonly string[]).includes(filter.result)) {
    throw auditValidationFailed(`result must be one of: ${AUDIT_RESULTS.join(', ')}`);
  }
  const scopedCustomerId = resolveCustomerScope(actor, filter.customerId);
  const limit = normalizeLimit(filter.limit ?? null);

  const conditions: Record<string, unknown>[] = [];
  if (scopedCustomerId) conditions.push({ customerId: scopedCustomerId });
  if (filter.actorId) conditions.push({ actorId: filter.actorId });
  if (filter.objectType) conditions.push({ objectType: filter.objectType });
  if (filter.objectId) conditions.push({ objectId: filter.objectId });
  if (filter.action) conditions.push({ action: filter.action });
  if (filter.result) conditions.push({ result: filter.result });
  const from = parseTime(filter.from, 'from');
  const to = parseTime(filter.to, 'to');
  if (from || to) {
    conditions.push({ createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });
  }

  // 复合键集游标（createdAt 倒序 + id 决胜）：复用共享游标编码，键为 `${iso}|${id}`
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) {
    const sep = after.lastIndexOf(CURSOR_KEY_SEPARATOR);
    const cursorTime = sep > 0 ? Date.parse(after.slice(0, sep)) : Number.NaN;
    const cursorId = sep > 0 ? after.slice(sep + 1) : '';
    if (Number.isNaN(cursorTime) || cursorId.length === 0) {
      throw auditValidationFailed('cursor is invalid');
    }
    const cursorDate = new Date(cursorTime);
    conditions.push({ OR: [{ createdAt: { lt: cursorDate } }, { createdAt: cursorDate, id: { lt: cursorId } }] });
  }

  const where: Record<string, unknown> =
    conditions.length === 0 ? {} : conditions.length === 1 ? { ...conditions[0] } : { AND: conditions };

  const rows = (await observeDataPathPhase('audit-list-query', () =>
    auditLogs(deps.client).findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }),
  )) as unknown as AuditLogRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: observeDataPathSyncPhase('audit-view', () => page.map(toView)),
    nextCursor:
      rows.length > limit && last
        ? encodeKeysetCursor(`${last.createdAt.toISOString()}${CURSOR_KEY_SEPARATOR}${last.id}`)
        : null,
  };
}

// ---------- 详情 ----------

export async function getAuditLogDetail(
  deps: AuditQueryDeps,
  actor: ActorContext,
  auditId: string,
): Promise<AuditLogDetailView> {
  const row = (await observeDataPathPhase('audit-detail-query', () =>
    auditLogs(deps.client).findFirst({ where: { id: auditId } }),
  )) as AuditLogRow | null;
  if (!row) throw auditNotFound();
  // 跨 Customer 详情 → 404（不泄露存在性）
  if (actor.actorType === 'customer' && row.customerId !== actor.customerId) throw auditNotFound();
  return observeDataPathSyncPhase('audit-view', () => toDetailView(row));
}
