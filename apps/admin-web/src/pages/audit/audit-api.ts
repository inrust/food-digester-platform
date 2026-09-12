/**
 * FE-15 审计日志 API 装配（BE-AUD-01）。
 *
 * 只读 API：仅两个 GET 端点（listAuditLogs/getAuditLogDetail），不存在任何修改/删除路由；
 * 本模块不提供写函数。audit:read V1 仅 PlatformSuperAdmin/Auditor（Customer 角色 403，
 * 服务层仍强制 actor.customerId 租户隔离作为纵深防御）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { AuditLogDetailView, AuditLogView, AuditResult } from './types.js';

export interface Page<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

export interface AuditLogListFilter {
  readonly actorId?: string | null;
  /** 仅平台角色可跨 Customer 筛选（Customer actor 强制 actor.customerId，不一致 → 403）。 */
  readonly customerId?: string | null;
  readonly objectType?: string | null;
  readonly objectId?: string | null;
  readonly action?: string | null;
  readonly result?: AuditResult | null;
  /** createdAt 起（UTC ISO，含）。 */
  readonly from?: string | null;
  /** createdAt 止（UTC ISO，含）。 */
  readonly to?: string | null;
}

function buildQuery(filter: AuditLogListFilter, cursor?: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  if (cursor !== undefined && cursor !== '') params.set('cursor', cursor);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export async function listAuditLogs(
  api: ApiClient,
  filter: AuditLogListFilter,
  cursor?: string,
): Promise<Page<AuditLogView>> {
  const response = await api.request<{ data: AuditLogView[]; meta: { nextCursor: string | null } }>(
    `/admin/audit-logs${buildQuery(filter, cursor)}`,
  );
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}

export async function getAuditLogDetail(api: ApiClient, auditId: string): Promise<AuditLogDetailView> {
  const response = await api.request<{ data: AuditLogDetailView }>(`/admin/audit-logs/${encodeURIComponent(auditId)}`);
  return response.data;
}
