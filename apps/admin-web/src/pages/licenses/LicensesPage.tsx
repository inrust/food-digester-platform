/**
 * FE-08 授权管理页（/licenses）：License 列表/详情、Draft 创建、Issue、Activate、Renew、
 * Revoke、Entitlement 配置与历史时间线。
 *
 * - 列表视角：BE-LIC-01 无全量列表 API，复用 listDevices（BE-DEV-01）的 Device.license
 *   摘要 + licenseStatus/keyword 筛选（每设备当前授权；NoLicense 行明确显示“无授权”）；
 * - 只显示当前状态允许动作（LICENSE_ACTION_MATRIX × license:write）；
 * - 撤销强制原因（ConfirmDialog requireReason）；签发/激活为明确确认（无请求体）；
 * - 续期：newValidTo 必须晚于当前 validTo（本地校验 + 服务端兜底）；
 * - 历史时间线：listLicenseHistory（createdAt 倒序）；操作成功后经 onRefresh 回源；
 * - 冲突可读：设备已有非终态 License 时创建 → 409 CONFLICT 原样呈现后端 message。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import { LICENSE_FILTER_LABELS, LICENSE_FILTER_OPTIONS } from '../devices/device-state.js';
import type { DeviceView } from '../devices/types.js';
import { LicenseSummary } from './LicenseSummary.js';
import type { LicenseCreateInput } from './licenses-api.js';
import {
  ENTITLEMENT_CODES,
  ENTITLEMENT_LABELS,
  canCreateLicense,
  gateLicenseAction,
  licenseStatusLabel,
  validateLicenseDraft,
  validateRenew,
} from './license-state.js';
import type { EntitlementCode, LicenseHistoryEntryView, LicenseRenewResultView, LicenseView } from './types.js';

export type LicenseDetailState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | {
      readonly kind: 'ready';
      readonly license: LicenseView;
      /** null = 历史加载中。 */
      readonly history: readonly LicenseHistoryEntryView[] | null;
      readonly historyError?: unknown;
    };

export interface LicenseFilter {
  readonly licenseStatus: string | null;
  readonly keyword: string | null;
}

export const EMPTY_LICENSE_FILTER: LicenseFilter = { licenseStatus: null, keyword: null };

export interface LicensesPageProps {
  readonly role: Role;
  readonly list: {
    readonly rows: readonly DeviceView[] | null;
    readonly loading?: boolean;
    readonly error?: unknown;
    readonly nextCursor?: string | null;
  };
  readonly appliedFilter: LicenseFilter;
  readonly onApplyFilter: (filter: LicenseFilter) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly onRefresh: () => void;
  readonly detail: LicenseDetailState;
  readonly onSelect: (licenseId: string) => void;
  readonly onCloseDetail: () => void;
  /** 创建 Draft 的设备候选（父级提供已分配设备；重复创建由后端 409 拒绝并呈现）。 */
  readonly createCandidates: readonly { readonly deviceId: string; readonly label: string }[];
  readonly onCreate: (input: LicenseCreateInput) => Promise<LicenseView>;
  readonly onIssue: (licenseId: string) => Promise<LicenseView>;
  readonly onActivate: (licenseId: string) => Promise<LicenseView>;
  readonly onRenew: (licenseId: string, newValidTo: string) => Promise<LicenseRenewResultView>;
  readonly onRevoke: (licenseId: string, reason: string) => Promise<LicenseView>;
}

type PendingAction = 'issue' | 'activate' | 'revoke';

export function LicensesPage({
  role,
  list,
  appliedFilter,
  onApplyFilter,
  onLoadMore,
  onRefresh,
  detail,
  onSelect,
  onCloseDetail,
  createCandidates,
  onCreate,
  onIssue,
  onActivate,
  onRenew,
  onRevoke,
}: LicensesPageProps) {
  const [draftFilter, setDraftFilter] = useState<LicenseFilter>(appliedFilter);
  const [createOpen, setCreateOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const license = detail.kind === 'ready' ? detail.license : null;
  const canWrite = canCreateLicense(role);

  const runAction = async (execute: () => Promise<unknown>, successText: string) => {
    // 防重复点击：在途请求直接忽略（后端幂等/状态条件兜底）
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPendingAction(null);
    setCreateOpen(false);
    setRenewOpen(false);
    setActionError(null);
    setNotice(null);
    try {
      await execute();
      setNotice(successText);
      // 操作后回源：列表 + 详情 + 历史刷新（验收基准）
      onRefresh();
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="licenses-page" data-testid="licenses-page">
      <div className="filter-bar" data-testid="license-filter-bar">
        <label htmlFor="license-status-filter">授权状态</label>
        <select
          id="license-status-filter"
          data-testid="license-status-filter"
          value={draftFilter.licenseStatus ?? ''}
          onChange={(event) =>
            setDraftFilter({ ...draftFilter, licenseStatus: event.target.value === '' ? null : event.target.value })
          }
        >
          <option value="">全部</option>
          {LICENSE_FILTER_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status === 'None' ? LICENSE_FILTER_LABELS.None : licenseStatusLabel(status)}
            </option>
          ))}
        </select>
        <label htmlFor="license-keyword">关键字</label>
        <input
          id="license-keyword"
          data-testid="license-keyword"
          value={draftFilter.keyword ?? ''}
          onChange={(event) => setDraftFilter({ ...draftFilter, keyword: event.target.value })}
        />
        <button
          type="button"
          className="primary-button"
          data-testid="license-search"
          onClick={() => onApplyFilter(draftFilter)}
        >
          搜索
        </button>
        <button
          type="button"
          data-testid="license-reset"
          onClick={() => {
            setDraftFilter(EMPTY_LICENSE_FILTER);
            onApplyFilter(EMPTY_LICENSE_FILTER);
          }}
        >
          重置
        </button>
        {canWrite ? (
          <button
            type="button"
            className="primary-button"
            data-testid="license-create"
            onClick={() => setCreateOpen(true)}
          >
            新建授权（Draft）
          </button>
        ) : null}
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <CursorTable
        ariaLabel="设备授权列表"
        columns={[
          { key: 'serialNumber', header: '设备唯一ID', render: (d) => d.serialNumber },
          { key: 'alias', header: '设备别名', render: (d) => d.alias ?? '—' },
          { key: 'customer', header: '所属客户', render: (d) => d.customer?.name ?? '—' },
          {
            key: 'license',
            header: '授权摘要',
            render: (d) => <LicenseSummary summary={d.license} {...(d.license !== null ? { onOpen: onSelect } : {})} />,
          },
          {
            key: 'actions',
            header: '操作',
            render: (d) =>
              d.license !== null ? (
                <button
                  type="button"
                  data-testid={`license-detail-${d.id}`}
                  onClick={() => onSelect(d.license?.licenseId ?? '')}
                >
                  详情
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  title="无授权设备无可查看的 License"
                  data-testid={`license-detail-${d.id}`}
                >
                  详情
                </button>
              ),
          },
        ]}
        rows={list.rows === null ? null : [...list.rows]}
        rowKey={(d) => d.id}
        {...(list.loading !== undefined ? { loading: list.loading } : {})}
        {...(list.error !== undefined ? { error: list.error } : {})}
        {...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {})}
        onNextPage={onLoadMore}
        onRefresh={onRefresh}
        emptyText="暂无设备授权记录"
      />

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="license-detail-loading">
          加载中…
        </div>
      ) : null}
      {detail.kind === 'error' ? <ErrorNotice error={detail.error} onRefresh={onRefresh} /> : null}

      {license !== null && detail.kind === 'ready' ? (
        <LicenseDetailPanel
          license={license}
          history={detail.history}
          {...(detail.historyError !== undefined ? { historyError: detail.historyError } : {})}
          role={role}
          busy={busy}
          onClose={onCloseDetail}
          onRefresh={onRefresh}
          onIntent={(action) => setPendingAction(action)}
          onRenewIntent={() => setRenewOpen(true)}
        />
      ) : null}

      <Modal
        open={createOpen}
        title="新建授权（Draft）"
        testid="license-create-dialog"
        onClose={() => setCreateOpen(false)}
      >
        <CreateLicenseForm
          candidates={createCandidates}
          busy={busy}
          onSubmit={(input) => void runAction(() => onCreate(input), '授权 Draft 已创建')}
        />
      </Modal>

      {license !== null ? (
        <Modal open={renewOpen} title="续期授权" testid="license-renew-dialog" onClose={() => setRenewOpen(false)}>
          <RenewForm
            validTo={license.validTo}
            busy={busy}
            onSubmit={(newValidTo) =>
              void runAction(() => onRenew(license.licenseId, newValidTo), '授权已续期（Renewed，待系统结算为 Active）')
            }
          />
        </Modal>
      ) : null}

      <ConfirmDialog
        open={pendingAction === 'issue'}
        title="签发授权"
        {...(license !== null
          ? { description: `签发（Draft→Issued）将生成签名供设备同步。License：${license.licenseId}` }
          : {})}
        confirmText="确认签发"
        onConfirm={() => {
          if (license !== null) void runAction(() => onIssue(license.licenseId), '授权已签发');
        }}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'activate'}
        title="激活授权"
        {...(license !== null
          ? {
              description: `激活（Issued→Active）要求已到达生效日期（validFrom）。License：${license.licenseId}`,
            }
          : {})}
        confirmText="确认激活"
        onConfirm={() => {
          if (license !== null) void runAction(() => onActivate(license.licenseId), '授权已激活');
        }}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'revoke'}
        title="撤销授权"
        danger
        requireReason
        reasonLabel="撤销原因"
        {...(license !== null
          ? { description: `撤销后设备将立即失去授权能力（→Revoked，终态）。License：${license.licenseId}` }
          : {})}
        confirmText="确认撤销"
        onConfirm={(reason) => {
          if (license !== null) void runAction(() => onRevoke(license.licenseId, reason), '授权已撤销');
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

function LicenseDetailPanel({
  license,
  history,
  historyError,
  role,
  busy,
  onClose,
  onRefresh,
  onIntent,
  onRenewIntent,
}: {
  readonly license: LicenseView;
  readonly history: readonly LicenseHistoryEntryView[] | null;
  readonly historyError?: unknown;
  readonly role: Role;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onIntent: (action: PendingAction) => void;
  readonly onRenewIntent: () => void;
}) {
  const issueGate = gateLicenseAction('issue', license.status, role);
  const activateGate = gateLicenseAction('activate', license.status, role);
  const renewGate = gateLicenseAction('renew', license.status, role);
  const revokeGate = gateLicenseAction('revoke', license.status, role);

  return (
    <aside className="license-detail" data-testid="license-detail" aria-label="授权详情">
      <h4>授权详情</h4>
      <dl>
        <dt>License ID</dt>
        <dd data-testid="license-id">{license.licenseId}</dd>
        <dt>设备</dt>
        <dd>{license.deviceId}</dd>
        <dt>客户</dt>
        <dd>{license.customerId}</dd>
        <dt>状态</dt>
        <dd data-testid="license-status">{licenseStatusLabel(license.status)}</dd>
        <dt>有效期</dt>
        <dd data-testid="license-validity">
          {license.validFrom} ~ {license.validTo}
        </dd>
        <dt>当前是否生效</dt>
        <dd data-testid="license-effective">{license.effective ? '生效' : '未生效'}</dd>
        <dt>Entitlement</dt>
        <dd data-testid="license-entitlements">
          {license.entitlements
            .filter((e) => e.enabled)
            .map((e) => ENTITLEMENT_LABELS[e.code])
            .join('、') || '—'}
        </dd>
        <dt>签名（供设备同步）</dt>
        <dd data-testid="license-signature">
          {license.signature !== null ? <code>{license.signature}</code> : '—（Draft 未签发）'}
        </dd>
        <dt>版本</dt>
        <dd>v{license.version}</dd>
        <dt>创建人</dt>
        <dd>{license.createdBy}</dd>
        <dt>更新时间</dt>
        <dd>
          <TimeText iso={license.updatedAt} />
        </dd>
      </dl>

      <div className="detail-actions">
        <button type="button" onClick={onClose}>
          关闭
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="license-issue"
          disabled={!issueGate.enabled || busy}
          {...(issueGate.reason !== null ? { title: issueGate.reason } : {})}
          onClick={() => onIntent('issue')}
        >
          签发
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="license-activate"
          disabled={!activateGate.enabled || busy}
          {...(activateGate.reason !== null ? { title: activateGate.reason } : {})}
          onClick={() => onIntent('activate')}
        >
          激活
        </button>
        <button
          type="button"
          data-testid="license-renew"
          disabled={!renewGate.enabled || busy}
          {...(renewGate.reason !== null ? { title: renewGate.reason } : {})}
          onClick={onRenewIntent}
        >
          续期
        </button>
        <button
          type="button"
          className="danger-button"
          data-testid="license-revoke"
          disabled={!revokeGate.enabled || busy}
          {...(revokeGate.reason !== null ? { title: revokeGate.reason } : {})}
          onClick={() => onIntent('revoke')}
        >
          撤销
        </button>
      </div>

      <section data-testid="license-history" aria-label="状态历史">
        <h5>状态时间线</h5>
        {historyError !== undefined ? <ErrorNotice error={historyError} onRefresh={onRefresh} /> : null}
        {history === null ? (
          <div role="status" data-testid="history-loading">
            加载中…
          </div>
        ) : history.length === 0 ? (
          <p className="empty-state" data-testid="history-empty">
            暂无历史
          </p>
        ) : (
          <ol className="history-timeline">
            {history.map((entry) => (
              <li key={entry.historyId} data-testid={`history-${entry.historyId}`}>
                <TimeText iso={entry.createdAt} />：
                {entry.fromStatus !== null ? `${licenseStatusLabel(entry.fromStatus)} → ` : ''}
                {licenseStatusLabel(entry.toStatus)}
                {entry.actorId !== null ? `（${entry.actorId}）` : ''}
                {entry.reason !== null ? ` — ${entry.reason}` : ''}
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

function CreateLicenseForm({
  candidates,
  busy,
  onSubmit,
}: {
  readonly candidates: readonly { readonly deviceId: string; readonly label: string }[];
  readonly busy: boolean;
  readonly onSubmit: (input: LicenseCreateInput) => void;
}) {
  const [deviceId, setDeviceId] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [entitlements, setEntitlements] = useState<readonly EntitlementCode[]>([]);
  const [reason, setReason] = useState('');
  const reasonTrimmed = reason.trim();
  const validationError = deviceId === '' ? null : validateLicenseDraft({ validFrom, validTo, entitlements });

  const toggleEntitlement = (code: EntitlementCode) => {
    setEntitlements((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  return (
    <div className="license-create-form" data-testid="license-create-form">
      <div className="dialog-field">
        <label htmlFor="create-device">设备（须已分配客户且未退役）</label>
        <select
          id="create-device"
          data-testid="create-device"
          value={deviceId}
          onChange={(event) => setDeviceId(event.target.value)}
        >
          <option value="">请选择设备</option>
          {candidates.map((c) => (
            <option key={c.deviceId} value={c.deviceId}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="dialog-field">
        <label htmlFor="create-valid-from">生效日期（UTC）</label>
        <input
          id="create-valid-from"
          data-testid="create-valid-from"
          placeholder="YYYY-MM-DD"
          value={validFrom}
          onChange={(event) => setValidFrom(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="create-valid-to">到期日期（UTC）</label>
        <input
          id="create-valid-to"
          data-testid="create-valid-to"
          placeholder="YYYY-MM-DD"
          value={validTo}
          onChange={(event) => setValidTo(event.target.value)}
        />
      </div>
      <fieldset className="dialog-field" data-testid="create-entitlements">
        <legend>Entitlement 配置（至少一项）</legend>
        {ENTITLEMENT_CODES.map((code) => (
          <label key={code}>
            <input
              type="checkbox"
              data-testid={`create-entitlement-${code}`}
              checked={entitlements.includes(code)}
              onChange={() => toggleEntitlement(code)}
            />
            {ENTITLEMENT_LABELS[code]}
          </label>
        ))}
      </fieldset>
      <div className="dialog-field">
        <label htmlFor="create-reason">原因（可选，写入审计）</label>
        <textarea
          id="create-reason"
          data-testid="create-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {validationError !== null ? (
        <p className="field-hint" data-testid="create-validation-error">
          {validationError}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button
          type="button"
          className="primary-button"
          data-testid="create-submit"
          disabled={busy || deviceId === '' || validationError !== null}
          onClick={() =>
            onSubmit({
              deviceId,
              validFrom,
              validTo,
              entitlements,
              ...(reasonTrimmed !== '' ? { reason: reasonTrimmed } : {}),
            })
          }
        >
          创建 Draft
        </button>
      </div>
    </div>
  );
}

function RenewForm({
  validTo,
  busy,
  onSubmit,
}: {
  readonly validTo: string;
  readonly busy: boolean;
  readonly onSubmit: (newValidTo: string) => void;
}) {
  const [newValidTo, setNewValidTo] = useState('');
  const validationError = newValidTo === '' ? null : validateRenew(validTo, newValidTo);

  return (
    <div className="license-renew-form" data-testid="license-renew-form">
      <p>
        当前到期日期：<strong>{validTo}</strong>
      </p>
      <div className="dialog-field">
        <label htmlFor="renew-valid-to">新到期日期（UTC，须晚于当前到期日期）</label>
        <input
          id="renew-valid-to"
          data-testid="renew-valid-to"
          placeholder="YYYY-MM-DD"
          value={newValidTo}
          onChange={(event) => setNewValidTo(event.target.value)}
        />
      </div>
      {validationError !== null ? (
        <p className="field-hint" data-testid="renew-validation-error">
          {validationError}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button
          type="button"
          className="primary-button"
          data-testid="renew-submit"
          disabled={busy || validationError !== null || newValidTo === ''}
          onClick={() => onSubmit(newValidTo)}
        >
          确认续期
        </button>
      </div>
    </div>
  );
}
