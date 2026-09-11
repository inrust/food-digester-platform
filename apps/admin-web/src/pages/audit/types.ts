/**
 * FE-15 审计日志数据类型：镜像 admin-audit-api.json（BE-AUD-01，DOM-03 append-only）。
 */

export type AuditResult = 'SUCCESS' | 'FAILURE';

/** 列表视图（不含 beforeValue/afterValue/ip/userAgent——经详情获取）。 */
export interface AuditLogView {
  readonly auditId: string;
  readonly actorId: string | null;
  readonly actorRole: string | null;
  readonly customerId: string | null;
  readonly objectType: string;
  readonly objectId: string;
  readonly action: string;
  readonly result: AuditResult;
  readonly createdAt: string;
}

/**
 * 详情视图（含脱敏前后值）。
 * beforeValue/afterValue 为任意 JSON（DOM-03 写入时脱敏 + 读取时再次脱敏；
 * 敏感字段恒为 [REDACTED]——前端渲染前再做一次兜底脱敏）。
 */
export interface AuditLogDetailView extends AuditLogView {
  readonly reason: string | null;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
}

export interface AuditLogListState {
  readonly rows: readonly AuditLogView[] | null;
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly nextCursor?: string | null;
}

export type AuditDetailState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'ready'; readonly detail: AuditLogDetailView };
