import { translate } from '../../i18n/i18n.js';
/**
 * FE-08 授权管理页（/licenses）：License 列表/详情、Draft 创建、Issue、Activate、Renew、
 * Revoke、Entitlement 配置与历史时间线。
 *
 * - 列表视角：使用正式 License 实体列表 API，支持状态/关键字筛选和历史终态档案枚举；
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
import { LICENSE_FILTER_OPTIONS } from '../devices/device-state.js';
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
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'loading';
    }
  | {
      readonly kind: 'error';
      readonly error: unknown;
    }
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
    readonly rows: readonly LicenseView[] | null;
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
  readonly createCandidates: readonly {
    readonly deviceId: string;
    readonly label: string;
  }[];
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
        <label htmlFor="license-status-filter">{translate('page.ac3cc79f9199')}</label>
        <select
          id="license-status-filter"
          data-testid="license-status-filter"
          value={draftFilter.licenseStatus ?? ''}
          onChange={(event) =>
            setDraftFilter({ ...draftFilter, licenseStatus: event.target.value === '' ? null : event.target.value })
          }
        >
          <option value="">{translate('page.778fc8f99453')}</option>
          {LICENSE_FILTER_OPTIONS.filter((status) => status !== 'None').map((status) => (
            <option key={status} value={status}>
              {licenseStatusLabel(status)}
            </option>
          ))}
        </select>
        <label htmlFor="license-keyword">{translate('page.621219ff9885')}</label>
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
          {translate('page.f04090805c6e')}
        </button>
        <button
          type="button"
          data-testid="license-reset"
          onClick={() => {
            setDraftFilter(EMPTY_LICENSE_FILTER);
            onApplyFilter(EMPTY_LICENSE_FILTER);
          }}
        >
          {translate('page.3d81345303ab')}
        </button>
        {canWrite ? (
          <button
            type="button"
            className="primary-button"
            data-testid="license-create"
            onClick={() => setCreateOpen(true)}
          >
            {translate('page.d06cb1f9df42')}
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
        ariaLabel={translate('page.559620d8d042')}
        columns={[
          { key: 'licenseId', header: 'License ID', render: (license) => license.licenseId },
          { key: 'deviceId', header: translate('page.9a04e46a8d92'), render: (license) => license.deviceId },
          { key: 'customerId', header: translate('page.a20148b7e39a'), render: (license) => license.customerId },
          {
            key: 'status',
            header: translate('page.135724b7acb6'),
            render: (license) => `${licenseStatusLabel(license.status)} · ${license.validFrom} ~ ${license.validTo}`,
          },
          {
            key: 'actions',
            header: translate('page.f3ea6d345e2a'),
            render: (license) => (
              <button
                type="button"
                data-testid={`license-detail-${license.licenseId}`}
                onClick={() => onSelect(license.licenseId)}
              >
                {translate('page.4f55ee1e687f')}
              </button>
            ),
          },
        ]}
        rows={list.rows === null ? null : [...list.rows]}
        rowKey={(license) => license.licenseId}
        {...(list.loading !== undefined ? { loading: list.loading } : {})}
        {...(list.error !== undefined ? { error: list.error } : {})}
        {...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {})}
        onNextPage={onLoadMore}
        onRefresh={onRefresh}
        emptyText={translate('page.64fffdd60a8b')}
      />

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="license-detail-loading">
          {translate('page.300ee3dee4dc')}
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
        title={translate('page.d06cb1f9df42')}
        testid="license-create-dialog"
        onClose={() => setCreateOpen(false)}
      >
        <CreateLicenseForm
          candidates={createCandidates}
          busy={busy}
          onSubmit={(input) => void runAction(() => onCreate(input), translate('page.5447e7009f29'))}
        />
      </Modal>

      {license !== null ? (
        <Modal
          open={renewOpen}
          title={translate('page.dc7711bf8fe4')}
          testid="license-renew-dialog"
          onClose={() => setRenewOpen(false)}
        >
          <RenewForm
            validTo={license.validTo}
            busy={busy}
            onSubmit={(newValidTo) =>
              void runAction(() => onRenew(license.licenseId, newValidTo), translate('page.73c2f65cbe76'))
            }
          />
        </Modal>
      ) : null}

      <ConfirmDialog
        open={pendingAction === 'issue'}
        title={translate('page.223cd10ed1c4')}
        {...(license !== null ? { description: translate('page.415e2601fc61') + license.licenseId } : {})}
        confirmText={translate('page.aebc0a110a42')}
        onConfirm={() => {
          if (license !== null) void runAction(() => onIssue(license.licenseId), translate('page.49cb8f05d960'));
        }}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'activate'}
        title={translate('page.be978c7b9dfc')}
        {...(license !== null
          ? {
              description: translate('page.4d6f7a909100') + license.licenseId,
            }
          : {})}
        confirmText={translate('page.427c6f9a814c')}
        onConfirm={() => {
          if (license !== null) void runAction(() => onActivate(license.licenseId), translate('page.69b439cc5bc0'));
        }}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'revoke'}
        title={translate('page.b31883bd2085')}
        danger
        requireReason
        reasonLabel={translate('page.e28c1ecca078')}
        {...(license !== null ? { description: translate('page.829082246f3d') + license.licenseId } : {})}
        confirmText={translate('page.f7e81a7807cb')}
        onConfirm={(reason) => {
          if (license !== null)
            void runAction(() => onRevoke(license.licenseId, reason), translate('page.5b3056cbcf22'));
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
    <aside className="license-detail" data-testid="license-detail" aria-label={translate('page.93b851a5b6f2')}>
      <h4>{translate('page.93b851a5b6f2')}</h4>
      <dl>
        <dt>License ID</dt>
        <dd data-testid="license-id">{license.licenseId}</dd>
        <dt>{translate('page.01f2c16cda65')}</dt>
        <dd>{license.deviceId}</dd>
        <dt>{translate('page.f20687060126')}</dt>
        <dd>{license.customerId}</dd>
        <dt>{translate('page.62e951a692ff')}</dt>
        <dd data-testid="license-status">{licenseStatusLabel(license.status)}</dd>
        <dt>{translate('page.222460c095e3')}</dt>
        <dd data-testid="license-validity">
          {license.validFrom} ~ {license.validTo}
        </dd>
        <dt>{translate('page.491e18841b98')}</dt>
        <dd data-testid="license-effective">
          {license.effective ? translate('page.b63f91b9f291') : translate('page.2ed178b6071c')}
        </dd>
        <dt>Entitlement</dt>
        <dd data-testid="license-entitlements">
          {license.entitlements
            .filter((e) => e.enabled)
            .map((e) => ENTITLEMENT_LABELS[e.code])
            .join('、') || '—'}
        </dd>
        <dt>{translate('page.07ab7e9e7613')}</dt>
        <dd data-testid="license-signature">
          {license.signature !== null ? <code>{license.signature}</code> : translate('page.b1e93a417c61')}
        </dd>
        <dt>{translate('page.989d1affa089')}</dt>
        <dd>v{license.version}</dd>
        <dt>{translate('page.787ad1deae49')}</dt>
        <dd>{license.createdBy}</dd>
        <dt>{translate('page.093dea88c930')}</dt>
        <dd>
          <TimeText iso={license.updatedAt} />
        </dd>
      </dl>

      <div className="detail-actions">
        <button type="button" onClick={onClose}>
          {translate('page.6c14bd7f6f9e')}
        </button>
        {issueGate.enabled ? (
          <button
            type="button"
            className="primary-button"
            data-testid="license-issue"
            disabled={busy}
            onClick={() => onIntent('issue')}
          >
            {translate('page.e48011457930')}
          </button>
        ) : null}
        {activateGate.enabled ? (
          <button
            type="button"
            className="primary-button"
            data-testid="license-activate"
            disabled={busy}
            onClick={() => onIntent('activate')}
          >
            {translate('page.4c25820818d6')}
          </button>
        ) : null}
        {renewGate.enabled ? (
          <button type="button" data-testid="license-renew" disabled={busy} onClick={onRenewIntent}>
            {translate('page.199d45f0cbc5')}
          </button>
        ) : null}
        {revokeGate.enabled ? (
          <button
            type="button"
            className="danger-button"
            data-testid="license-revoke"
            disabled={busy}
            onClick={() => onIntent('revoke')}
          >
            {translate('page.9fcefd8dc81e')}
          </button>
        ) : null}
      </div>

      <section data-testid="license-history" aria-label={translate('page.eb46c07247da')}>
        <h5>{translate('page.3c6baab8c09c')}</h5>
        {historyError !== undefined ? <ErrorNotice error={historyError} onRefresh={onRefresh} /> : null}
        {history === null ? (
          <div role="status" data-testid="history-loading">
            {translate('page.300ee3dee4dc')}
          </div>
        ) : history.length === 0 ? (
          <p className="empty-state" data-testid="history-empty">
            {translate('page.482a16ecfa18')}
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
  readonly candidates: readonly {
    readonly deviceId: string;
    readonly label: string;
  }[];
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
        <label htmlFor="create-device">{translate('page.afb302dd94fc')}</label>
        <select
          id="create-device"
          data-testid="create-device"
          value={deviceId}
          onChange={(event) => setDeviceId(event.target.value)}
        >
          <option value="">{translate('page.61f337d9709e')}</option>
          {candidates.map((c) => (
            <option key={c.deviceId} value={c.deviceId}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="dialog-field">
        <label htmlFor="create-valid-from">{translate('page.206d975dbad5')}</label>
        <input
          id="create-valid-from"
          data-testid="create-valid-from"
          placeholder="YYYY-MM-DD"
          value={validFrom}
          onChange={(event) => setValidFrom(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="create-valid-to">{translate('page.4a12d38f1810')}</label>
        <input
          id="create-valid-to"
          data-testid="create-valid-to"
          placeholder="YYYY-MM-DD"
          value={validTo}
          onChange={(event) => setValidTo(event.target.value)}
        />
      </div>
      <fieldset className="dialog-field" data-testid="create-entitlements">
        <legend>{translate('page.83b92e730564')}</legend>
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
        <label htmlFor="create-reason">{translate('page.db5e8a988ba0')}</label>
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
          {translate('page.098fafafeea6')}
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
        {translate('page.a6ec02cb4b2e')}
        <strong>{validTo}</strong>
      </p>
      <div className="dialog-field">
        <label htmlFor="renew-valid-to">{translate('page.3645af1b4193')}</label>
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
          {translate('page.10f61d3ddf64')}
        </button>
      </div>
    </div>
  );
}
