/**
 * FE-15 审计日志页（/audit-logs）：按 actor/Customer/对象/动作/结果/时间筛选 +
 * 键集游标分页；详情显示脱敏前后值与 requestId。
 *
 * - 只读：页面无编辑/删除入口，API 装配仅 GET（DOM-03 append-only）；
 * - 权限：audit:read V1 仅 PlatformSuperAdmin/Auditor（Customer 角色 403，路由层已排除）；
 *   仅平台角色暴露 customerId 筛选（Customer actor 越权筛选 → 403 由服务端兜底）；
 * - 脱敏：前后值经服务端双层脱敏，前端渲染前再兜底脱敏（敏感字段恒为 [REDACTED]）；
 * - 功能边界：不展示 CloudTrail/基础设施日志。
 */
import { useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import { useUserTimeZone } from '../../components/TimeText.js';
import { isUtcRangeOrdered, zonedDateTimeToUtcIso } from '../../components/date-time.js';
import type { AuditLogListFilter } from './audit-api.js';
import { AUDIT_RESULT_LABELS, AUDIT_RESULT_OPTIONS, formatAuditValue } from './audit-state.js';
import type { AuditDetailState, AuditLogListState, AuditResult } from './types.js';

export interface AuditLogsPageProps {
  readonly role: Role;
  readonly logs: AuditLogListState;
  readonly filter: AuditLogListFilter;
  readonly onApplyFilter: (filter: AuditLogListFilter) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly detail: AuditDetailState;
  readonly onSelectLog: (auditId: string) => void;
  readonly onCloseDetail: () => void;
  readonly onRefresh: () => void;
}

interface DraftFilter {
  readonly actorId: string;
  readonly customerId: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly action: string;
  readonly result: AuditResult | '';
  readonly from: string;
  readonly to: string;
}

const EMPTY_DRAFT: DraftFilter = {
  actorId: '',
  customerId: '',
  objectType: '',
  objectId: '',
  action: '',
  result: '',
  from: '',
  to: '',
};

export function AuditLogsPage({
  role,
  logs,
  filter,
  onApplyFilter,
  onLoadMore,
  detail,
  onSelectLog,
  onCloseDetail,
  onRefresh,
}: AuditLogsPageProps) {
  const [draft, setDraft] = useState<DraftFilter>({
    ...EMPTY_DRAFT,
    actorId: filter.actorId ?? '',
    customerId: filter.customerId ?? '',
    objectType: filter.objectType ?? '',
    objectId: filter.objectId ?? '',
    action: filter.action ?? '',
    result: filter.result ?? '',
  });
  const { timeZone } = useUserTimeZone();

  // 仅平台角色可跨 Customer 筛选（Auditor 跨 Customer 只读）
  const isPlatformRole = !role.startsWith('Customer');
  const fromUtc = draft.from === '' ? null : zonedDateTimeToUtcIso(draft.from, timeZone);
  const toUtc = draft.to === '' ? null : zonedDateTimeToUtcIso(draft.to, timeZone);
  const fromInvalid = draft.from !== '' && fromUtc === null;
  const toInvalid = draft.to !== '' && toUtc === null;
  const rangeInvalid = !fromInvalid && !toInvalid && !isUtcRangeOrdered(fromUtc, toUtc);

  const applyFilter = () => {
    if (fromInvalid || toInvalid || rangeInvalid) return;
    onApplyFilter({
      actorId: draft.actorId.trim() === '' ? null : draft.actorId.trim(),
      customerId: isPlatformRole && draft.customerId.trim() !== '' ? draft.customerId.trim() : null,
      objectType: draft.objectType.trim() === '' ? null : draft.objectType.trim(),
      objectId: draft.objectId.trim() === '' ? null : draft.objectId.trim(),
      action: draft.action.trim() === '' ? null : draft.action.trim(),
      result: draft.result === '' ? null : draft.result,
      from: fromUtc,
      to: toUtc,
    });
  };

  const readyDetail = detail.kind === 'ready' ? detail.detail : null;

  return (
    <div className="audit-logs-page" data-testid="audit-logs-page">
      <div className="page-header">
        <h3>审计日志</h3>
      </div>
      <p className="field-hint">
        只读视图（append-only，无编辑/删除）；敏感字段经双层脱敏，恒显示为 [REDACTED]；不含基础设施日志。
      </p>

      <section data-testid="audit-filter" aria-label="筛选">
        <div className="filter-bar">
          <label htmlFor="audit-filter-actor">操作者 actorId</label>
          <input
            id="audit-filter-actor"
            data-testid="audit-filter-actor"
            value={draft.actorId}
            onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}
          />
          {isPlatformRole ? (
            <>
              <label htmlFor="audit-filter-customer">客户 ID</label>
              <input
                id="audit-filter-customer"
                data-testid="audit-filter-customer"
                value={draft.customerId}
                onChange={(event) => setDraft({ ...draft, customerId: event.target.value })}
              />
            </>
          ) : null}
          <label htmlFor="audit-filter-object-type">对象类型</label>
          <input
            id="audit-filter-object-type"
            data-testid="audit-filter-object-type"
            value={draft.objectType}
            onChange={(event) => setDraft({ ...draft, objectType: event.target.value })}
          />
          <label htmlFor="audit-filter-object-id">对象 ID</label>
          <input
            id="audit-filter-object-id"
            data-testid="audit-filter-object-id"
            value={draft.objectId}
            onChange={(event) => setDraft({ ...draft, objectId: event.target.value })}
          />
          <label htmlFor="audit-filter-action">动作</label>
          <input
            id="audit-filter-action"
            data-testid="audit-filter-action"
            value={draft.action}
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
          />
          <label htmlFor="audit-filter-result">结果</label>
          <select
            id="audit-filter-result"
            data-testid="audit-filter-result"
            value={draft.result}
            onChange={(event) =>
              setDraft({ ...draft, result: event.target.value === '' ? '' : (event.target.value as AuditResult) })
            }
          >
            <option value="">全部</option>
            {AUDIT_RESULT_OPTIONS.map((result) => (
              <option key={result} value={result}>
                {AUDIT_RESULT_LABELS[result]}
              </option>
            ))}
          </select>
          <label htmlFor="audit-filter-from">时间起</label>
          <input
            id="audit-filter-from"
            type="datetime-local"
            data-testid="audit-filter-from"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
          <label htmlFor="audit-filter-to">时间止</label>
          <input
            id="audit-filter-to"
            type="datetime-local"
            data-testid="audit-filter-to"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
          <button
            type="button"
            className="primary-button"
            data-testid="audit-filter-search"
            disabled={fromInvalid || toInvalid || rangeInvalid}
            onClick={applyFilter}
          >
            筛选
          </button>
        </div>
        {fromInvalid || toInvalid || rangeInvalid ? (
          <p className="field-hint" data-testid="audit-filter-time-error">
            {rangeInvalid ? '起始时间不得晚于截止时间' : `时间格式非法或在 ${timeZone} 不存在`}
          </p>
        ) : null}
      </section>

      <section data-testid="audit-list-section" aria-label="审计日志列表">
        <CursorTable
          ariaLabel="审计日志列表"
          columns={[
            { key: 'createdAt', header: '时间', render: (log) => <TimeText iso={log.createdAt} /> },
            { key: 'actorId', header: '操作者', render: (log) => log.actorId ?? '—' },
            { key: 'actorRole', header: '角色', render: (log) => log.actorRole ?? '—' },
            { key: 'customerId', header: '客户', render: (log) => log.customerId ?? '—' },
            {
              key: 'object',
              header: '对象',
              render: (log) => `${log.objectType}/${log.objectId}`,
            },
            { key: 'action', header: '动作', render: (log) => log.action },
            {
              key: 'result',
              header: '结果',
              render: (log) => (
                <span className={log.result === 'FAILURE' ? 'severity-badge severity-major' : undefined}>
                  {AUDIT_RESULT_LABELS[log.result] ?? log.result}
                </span>
              ),
            },
            {
              key: 'actions',
              header: '操作',
              render: (log) => (
                <button
                  type="button"
                  data-testid={`audit-detail-${log.auditId}`}
                  onClick={() => onSelectLog(log.auditId)}
                >
                  详情
                </button>
              ),
            },
          ]}
          rows={logs.rows === null ? null : [...logs.rows]}
          rowKey={(log) => log.auditId}
          {...(logs.loading !== undefined ? { loading: logs.loading } : {})}
          {...(logs.error !== undefined ? { error: logs.error } : {})}
          {...(logs.nextCursor !== undefined ? { nextCursor: logs.nextCursor } : {})}
          onNextPage={onLoadMore}
          onRefresh={onRefresh}
          emptyText="暂无审计日志"
        />
      </section>

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="audit-detail-loading">
          加载中…
        </div>
      ) : null}

      <Modal
        open={detail.kind === 'ready' || detail.kind === 'error'}
        title="审计详情"
        testid="audit-detail-modal"
        onClose={onCloseDetail}
      >
        {detail.kind === 'error' ? <ErrorNotice error={detail.error} /> : null}
        {readyDetail !== null ? (
          <div data-testid="audit-detail">
            <dl>
              <dt>审计 ID</dt>
              <dd data-testid="audit-detail-id">{readyDetail.auditId}</dd>
              <dt>requestId</dt>
              <dd data-testid="audit-detail-request-id">{readyDetail.requestId ?? '—'}</dd>
              <dt>操作者 / 角色</dt>
              <dd>
                {readyDetail.actorId ?? '—'} / {readyDetail.actorRole ?? '—'}
              </dd>
              <dt>客户</dt>
              <dd>{readyDetail.customerId ?? '—'}</dd>
              <dt>对象 / 动作 / 结果</dt>
              <dd>
                {readyDetail.objectType}/{readyDetail.objectId} · {readyDetail.action} ·{' '}
                {AUDIT_RESULT_LABELS[readyDetail.result] ?? readyDetail.result}
              </dd>
              <dt>原因</dt>
              <dd data-testid="audit-detail-reason">{readyDetail.reason ?? '—'}</dd>
              <dt>IP / User-Agent</dt>
              <dd>
                {readyDetail.ip ?? '—'} / {readyDetail.userAgent ?? '—'}
              </dd>
              <dt>时间</dt>
              <dd>
                <TimeText iso={readyDetail.createdAt} />
              </dd>
            </dl>
            <h5>变更前值（已脱敏）</h5>
            <pre data-testid="audit-detail-before">{formatAuditValue(readyDetail.beforeValue)}</pre>
            <h5>变更后值（已脱敏）</h5>
            <pre data-testid="audit-detail-after">{formatAuditValue(readyDetail.afterValue)}</pre>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
