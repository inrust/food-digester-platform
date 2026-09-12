import { translate } from '../../i18n/i18n.js';
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
        <h3>{translate('page.7666cd43234e')}</h3>
      </div>
      <p className="field-hint">{translate('page.0ac903fad307')}</p>

      <section data-testid="audit-filter" aria-label={translate('page.dcce9a144a40')}>
        <div className="filter-bar">
          <label htmlFor="audit-filter-actor">{translate('page.6dd194b747ea')}</label>
          <input
            id="audit-filter-actor"
            data-testid="audit-filter-actor"
            value={draft.actorId}
            onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}
          />
          {isPlatformRole ? (
            <>
              <label htmlFor="audit-filter-customer">{translate('page.a20148b7e39a')}</label>
              <input
                id="audit-filter-customer"
                data-testid="audit-filter-customer"
                value={draft.customerId}
                onChange={(event) => setDraft({ ...draft, customerId: event.target.value })}
              />
            </>
          ) : null}
          <label htmlFor="audit-filter-object-type">{translate('page.bfa3562d543a')}</label>
          <input
            id="audit-filter-object-type"
            data-testid="audit-filter-object-type"
            value={draft.objectType}
            onChange={(event) => setDraft({ ...draft, objectType: event.target.value })}
          />
          <label htmlFor="audit-filter-object-id">{translate('page.685ea0707c73')}</label>
          <input
            id="audit-filter-object-id"
            data-testid="audit-filter-object-id"
            value={draft.objectId}
            onChange={(event) => setDraft({ ...draft, objectId: event.target.value })}
          />
          <label htmlFor="audit-filter-action">{translate('page.d9d9827827e1')}</label>
          <input
            id="audit-filter-action"
            data-testid="audit-filter-action"
            value={draft.action}
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
          />
          <label htmlFor="audit-filter-result">{translate('page.0a2c91cec6c8')}</label>
          <select
            id="audit-filter-result"
            data-testid="audit-filter-result"
            value={draft.result}
            onChange={(event) =>
              setDraft({ ...draft, result: event.target.value === '' ? '' : (event.target.value as AuditResult) })
            }
          >
            <option value="">{translate('page.778fc8f99453')}</option>
            {AUDIT_RESULT_OPTIONS.map((result) => (
              <option key={result} value={result}>
                {AUDIT_RESULT_LABELS[result]}
              </option>
            ))}
          </select>
          <label htmlFor="audit-filter-from">{translate('page.b4e119fecbac')}</label>
          <input
            id="audit-filter-from"
            type="datetime-local"
            data-testid="audit-filter-from"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
          <label htmlFor="audit-filter-to">{translate('page.943df5fe5a8b')}</label>
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
            {translate('page.dcce9a144a40')}
          </button>
        </div>
        {fromInvalid || toInvalid || rangeInvalid ? (
          <p className="field-hint" data-testid="audit-filter-time-error">
            {rangeInvalid
              ? translate('page.1c35c2baf9f1')
              : translate('page.19cd7110c11d') + ' ' + timeZone + (' ' + translate('page.0d864b52e306'))}
          </p>
        ) : null}
      </section>

      <section data-testid="audit-list-section" aria-label={translate('page.c0aeecbe7b29')}>
        <CursorTable
          ariaLabel={translate('page.c0aeecbe7b29')}
          columns={[
            {
              key: 'createdAt',
              header: translate('page.89b4aa6364ce'),
              render: (log) => <TimeText iso={log.createdAt} />,
            },
            { key: 'actorId', header: translate('page.ffb50d38789e'), render: (log) => log.actorId ?? '—' },
            { key: 'actorRole', header: translate('page.6b26695e4dce'), render: (log) => log.actorRole ?? '—' },
            { key: 'customerId', header: translate('page.f20687060126'), render: (log) => log.customerId ?? '—' },
            {
              key: 'object',
              header: translate('page.539cb3b0a662'),
              render: (log) => `${log.objectType}/${log.objectId}`,
            },
            { key: 'action', header: translate('page.d9d9827827e1'), render: (log) => log.action },
            {
              key: 'result',
              header: translate('page.0a2c91cec6c8'),
              render: (log) => (
                <span className={log.result === 'FAILURE' ? 'severity-badge severity-major' : undefined}>
                  {AUDIT_RESULT_LABELS[log.result] ?? log.result}
                </span>
              ),
            },
            {
              key: 'actions',
              header: translate('page.f3ea6d345e2a'),
              render: (log) => (
                <button
                  type="button"
                  data-testid={`audit-detail-${log.auditId}`}
                  onClick={() => onSelectLog(log.auditId)}
                >
                  {translate('page.4f55ee1e687f')}
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
          emptyText={translate('page.4e95331245ac')}
        />
      </section>

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="audit-detail-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : null}

      <Modal
        open={detail.kind === 'ready' || detail.kind === 'error'}
        title={translate('page.18c5e1d426e6')}
        testid="audit-detail-modal"
        onClose={onCloseDetail}
      >
        {detail.kind === 'error' ? <ErrorNotice error={detail.error} /> : null}
        {readyDetail !== null ? (
          <div data-testid="audit-detail">
            <dl>
              <dt>{translate('page.80532abd24d4')}</dt>
              <dd data-testid="audit-detail-id">{readyDetail.auditId}</dd>
              <dt>requestId</dt>
              <dd data-testid="audit-detail-request-id">{readyDetail.requestId ?? '—'}</dd>
              <dt>{translate('page.558f09d9d926')}</dt>
              <dd>
                {readyDetail.actorId ?? '—'} / {readyDetail.actorRole ?? '—'}
              </dd>
              <dt>{translate('page.f20687060126')}</dt>
              <dd>{readyDetail.customerId ?? '—'}</dd>
              <dt>{translate('page.a426465ce19a')}</dt>
              <dd>
                {readyDetail.objectType}/{readyDetail.objectId} · {readyDetail.action} ·{' '}
                {AUDIT_RESULT_LABELS[readyDetail.result] ?? readyDetail.result}
              </dd>
              <dt>{translate('page.1ff9c3d00112')}</dt>
              <dd data-testid="audit-detail-reason">{readyDetail.reason ?? '—'}</dd>
              <dt>IP / User-Agent</dt>
              <dd>
                {readyDetail.ip ?? '—'} / {readyDetail.userAgent ?? '—'}
              </dd>
              <dt>{translate('page.89b4aa6364ce')}</dt>
              <dd>
                <TimeText iso={readyDetail.createdAt} />
              </dd>
            </dl>
            <h5>{translate('page.504bbdd261f1')}</h5>
            <pre data-testid="audit-detail-before">{formatAuditValue(readyDetail.beforeValue)}</pre>
            <h5>{translate('page.9430f0567db6')}</h5>
            <pre data-testid="audit-detail-after">{formatAuditValue(readyDetail.afterValue)}</pre>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
