import { translate } from '../../i18n/i18n.js';
/**
 * FE-09 设备用户管理页（/device-users；FE-16 设置页可直接嵌入本页组件）。
 *
 * - 创建/停用/分配/撤销/资料修改/受控密码重置（BE-DUSR-01/02）；
 * - DEC-004：密码仅经 type=password 输入一次受控提交，提交后立即清空、绝不回显；
 *   任何响应与 DOM 不显示 passwordHash（类型层无密码字段，快照测试锁定）；
 * - update/disable/assign/revoke 均 If-Match=version + 强制原因；409 VERSION_CONFLICT 提示刷新；
 * - 同步状态：version 即同步版本展示；停用用户不进入新 Sync（停用确认文案明示）；
 * - Customer 角色 customerId 由父级强制（页面不提供客户选择）。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import type { FilterOption } from '../../components/ScopeFilter.js';
import {
  DEVICE_USER_ASSIGNMENT_STATUS_LABELS,
  DEVICE_USER_STATUS_LABELS,
  DEVICE_USER_STATUS_OPTIONS,
  canAssignDeviceUser,
  canWriteDeviceUser,
  validateDeviceUserCreate,
} from './device-user-state.js';
import type {
  AssignResultView,
  DeviceUserDetailView,
  DeviceUserListItemView,
  DeviceUserView,
  RevokeResultView,
} from './types.js';
export type DeviceUserDetailState =
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
      readonly detail: DeviceUserDetailView;
    };
export interface DeviceUserFilter {
  readonly customerId: string | null;
  readonly region: string | null;
  readonly subregion: string | null;
  readonly deviceId: string | null;
  readonly status: 'ACTIVE' | 'DISABLED' | null;
  readonly keyword: string | null;
}
export const EMPTY_DEVICE_USER_FILTER: DeviceUserFilter = {
  customerId: null,
  region: null,
  subregion: null,
  deviceId: null,
  status: null,
  keyword: null,
};
export interface DeviceUserTopologyOption {
  readonly deviceId: string;
  readonly label: string;
  readonly customerId: string | null;
  readonly region: string | null;
  readonly subregion: string | null;
}
export interface DeviceUsersPageProps {
  readonly role: Role;
  /** Customer 角色父级强制传入本 Customer ID（页面隐藏客户选择）。 */
  readonly fixedCustomerId?: string | null;
  readonly customerOptions: readonly FilterOption[];
  /** 权威设备目录提供的完整拓扑选项，不从当前用户结果集反推。 */
  readonly topologyOptions: readonly DeviceUserTopologyOption[];
  readonly list: {
    readonly rows: readonly DeviceUserListItemView[] | null;
    readonly loading?: boolean;
    readonly error?: unknown;
  };
  readonly appliedFilter: DeviceUserFilter;
  readonly onApplyFilter: (filter: DeviceUserFilter) => void;
  readonly onRefresh: () => void;
  readonly detail: DeviceUserDetailState;
  readonly onSelect: (deviceUserId: string) => void;
  readonly onCloseDetail: () => void;
  /** 分配候选设备（父级提供本 Customer 非 Retired 设备；跨 Customer/Retired 由后端 409 兜底）。 */
  readonly assignableDevices: readonly FilterOption[];
  readonly onCreate: (input: {
    customerId?: string;
    username: string;
    displayName?: string;
    password: string;
    reason?: string;
  }) => Promise<DeviceUserView>;
  readonly onUpdate: (
    deviceUserId: string,
    input: {
      displayName?: string | null;
      password?: string;
      reason: string;
    },
  ) => Promise<DeviceUserView>;
  readonly onDisable: (deviceUserId: string, reason: string) => Promise<DeviceUserView>;
  readonly onAssign: (deviceUserId: string, deviceIds: readonly string[], reason: string) => Promise<AssignResultView>;
  readonly onRevoke: (deviceUserId: string, deviceIds: readonly string[], reason: string) => Promise<RevokeResultView>;
}
type PendingModal = 'create' | 'edit' | 'password' | 'assign' | 'revoke' | null;
export function DeviceUsersPage({
  role,
  fixedCustomerId = null,
  customerOptions,
  topologyOptions,
  list,
  appliedFilter,
  onApplyFilter,
  onRefresh,
  detail,
  onSelect,
  onCloseDetail,
  assignableDevices,
  onCreate,
  onUpdate,
  onDisable,
  onAssign,
  onRevoke,
}: DeviceUsersPageProps) {
  const [draftFilter, setDraftFilter] = useState<DeviceUserFilter>(appliedFilter);
  const [modal, setModal] = useState<PendingModal>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const canWrite = canWriteDeviceUser(role);
  const canAssign = canAssignDeviceUser(role);
  const scopedTopology = topologyOptions.filter(
    (item) => draftFilter.customerId === null || item.customerId === draftFilter.customerId,
  );
  const regions = [
    ...new Set(scopedTopology.map((item) => item.region).filter((value): value is string => value !== null)),
  ];
  const subregions = [
    ...new Set(
      scopedTopology
        .filter((item) => draftFilter.region === null || item.region === draftFilter.region)
        .map((item) => item.subregion)
        .filter((value): value is string => value !== null),
    ),
  ];
  const detailView = detail.kind === 'ready' ? detail.detail : null;
  const runAction = async (execute: () => Promise<unknown>, successText: string) => {
    // 防重复点击：在途请求直接忽略（后端 If-Match/幂等兜底）
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setModal(null);
    setDisableOpen(false);
    setActionError(null);
    setNotice(null);
    try {
      await execute();
      setNotice(successText);
      onRefresh();
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="device-users-page" data-testid="device-users-page">
      <div className="filter-bar" data-testid="device-user-filter-bar">
        {fixedCustomerId === null ? (
          <>
            <label htmlFor="device-user-customer">{translate('page.467c1137f479')}</label>
            <select
              id="device-user-customer"
              data-testid="device-user-customer-filter"
              value={draftFilter.customerId ?? ''}
              onChange={(event) =>
                setDraftFilter({ ...draftFilter, customerId: event.target.value === '' ? null : event.target.value })
              }
            >
              <option value="">{translate('page.778fc8f99453')}</option>
              {customerOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label htmlFor="device-user-region">{translate('page.406e0f8c6852')}</label>
        <select
          id="device-user-region"
          data-testid="device-user-region-filter"
          value={draftFilter.region ?? ''}
          onChange={(event) =>
            setDraftFilter({
              ...draftFilter,
              region: event.target.value || null,
              subregion: null,
              deviceId: null,
            })
          }
        >
          <option value="">{translate('page.778fc8f99453')}</option>
          {regions.map((region) => (
            <option key={region} value={region}>
              {region}
            </option>
          ))}
        </select>
        <label htmlFor="device-user-subregion">{translate('page.ff0beacd69e2')}</label>
        <select
          id="device-user-subregion"
          data-testid="device-user-subregion-filter"
          value={draftFilter.subregion ?? ''}
          onChange={(event) =>
            setDraftFilter({ ...draftFilter, subregion: event.target.value || null, deviceId: null })
          }
        >
          <option value="">{translate('page.778fc8f99453')}</option>
          {subregions.map((subregion) => (
            <option key={subregion} value={subregion}>
              {subregion}
            </option>
          ))}
        </select>
        <label htmlFor="device-user-device">{translate('page.d79416b3896a')}</label>
        <select
          id="device-user-device"
          data-testid="device-user-device-filter"
          value={draftFilter.deviceId ?? ''}
          onChange={(event) => setDraftFilter({ ...draftFilter, deviceId: event.target.value || null })}
        >
          <option value="">{translate('page.778fc8f99453')}</option>
          {scopedTopology
            .filter(
              (item) =>
                (draftFilter.region === null || item.region === draftFilter.region) &&
                (draftFilter.subregion === null || item.subregion === draftFilter.subregion),
            )
            .map((item) => (
              <option key={item.deviceId} value={item.deviceId}>
                {item.label}
              </option>
            ))}
        </select>
        <label htmlFor="device-user-status">{translate('page.62e951a692ff')}</label>
        <select
          id="device-user-status"
          data-testid="device-user-status-filter"
          value={draftFilter.status ?? ''}
          onChange={(event) =>
            setDraftFilter({
              ...draftFilter,
              status: event.target.value === '' ? null : (event.target.value as 'ACTIVE' | 'DISABLED'),
            })
          }
        >
          <option value="">{translate('page.778fc8f99453')}</option>
          {DEVICE_USER_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {DEVICE_USER_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <label htmlFor="device-user-keyword">{translate('page.621219ff9885')}</label>
        <input
          id="device-user-keyword"
          data-testid="device-user-keyword"
          value={draftFilter.keyword ?? ''}
          onChange={(event) => setDraftFilter({ ...draftFilter, keyword: event.target.value })}
        />
        <button
          type="button"
          className="primary-button"
          data-testid="device-user-search"
          onClick={() => onApplyFilter(draftFilter)}
        >
          {translate('page.dcce9a144a40')}
        </button>
        <button
          type="button"
          data-testid="device-user-filter-reset"
          onClick={() => {
            setDraftFilter(EMPTY_DEVICE_USER_FILTER);
            onApplyFilter(EMPTY_DEVICE_USER_FILTER);
          }}
        >
          {translate('page.3d81345303ab')}
        </button>
        {canWrite ? (
          <button
            type="button"
            className="primary-button"
            data-testid="device-user-create"
            onClick={() => setModal('create')}
          >
            {translate('page.6663d2d3519a')}
          </button>
        ) : null}
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      {list.error !== undefined ? <ErrorNotice error={list.error} onRefresh={onRefresh} /> : null}
      {list.rows === null ? (
        <div role="status" data-testid="device-user-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : list.rows.length === 0 ? (
        <p className="empty-state" data-testid="device-user-empty">
          {translate('page.39b4bad93c4a')}
        </p>
      ) : (
        <table aria-label={translate('page.2993d42bd8c9')} data-testid="device-user-table">
          <thead>
            <tr>
              <th scope="col">{translate('page.a1aaf352cb07')}</th>
              <th scope="col">{translate('page.c10bbf5ddd2d')}</th>
              <th scope="col">{translate('page.62e951a692ff')}</th>
              <th scope="col">{translate('page.08eb0e60ad1a')}</th>
              <th scope="col">{translate('page.928728223d5a')}</th>
              <th scope="col">{translate('page.093dea88c930')}</th>
              <th scope="col">{translate('page.f3ea6d345e2a')}</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((row) => (
              <tr key={row.deviceUserId} data-testid={`device-user-row-${row.deviceUserId}`}>
                <td>{row.username}</td>
                <td>{row.displayName ?? '—'}</td>
                <td>{DEVICE_USER_STATUS_LABELS[row.status]}</td>
                <td>{row.activeDeviceCount}</td>
                <td>v{row.version}</td>
                <td>
                  <TimeText iso={row.updatedAt} />
                </td>
                <td>
                  <button
                    type="button"
                    data-testid={`device-user-detail-${row.deviceUserId}`}
                    onClick={() => onSelect(row.deviceUserId)}
                  >
                    {translate('page.4f55ee1e687f')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="device-user-detail-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : null}
      {detail.kind === 'error' ? <ErrorNotice error={detail.error} onRefresh={onRefresh} /> : null}

      {detailView !== null ? (
        <aside
          className="device-user-detail"
          data-testid="device-user-detail"
          aria-label={translate('page.eac30b08be59')}
        >
          <h4>{translate('page.eac30b08be59')}</h4>
          <dl>
            <dt>{translate('page.a1aaf352cb07')}</dt>
            <dd data-testid="detail-username">{detailView.username}</dd>
            <dt>{translate('page.c10bbf5ddd2d')}</dt>
            <dd>{detailView.displayName ?? '—'}</dd>
            <dt>{translate('page.467c1137f479')}</dt>
            <dd>{detailView.customerId}</dd>
            <dt>{translate('page.62e951a692ff')}</dt>
            <dd data-testid="detail-status">{DEVICE_USER_STATUS_LABELS[detailView.status]}</dd>
            <dt>{translate('page.928728223d5a')}</dt>
            <dd data-testid="detail-version">v{detailView.version}</dd>
            <dt>{translate('page.093dea88c930')}</dt>
            <dd>
              <TimeText iso={detailView.updatedAt} />
            </dd>
          </dl>

          <div className="detail-actions">
            <button type="button" onClick={onCloseDetail}>
              {translate('page.6c14bd7f6f9e')}
            </button>
            {canWrite ? (
              <>
                <button type="button" data-testid="device-user-edit" disabled={busy} onClick={() => setModal('edit')}>
                  {translate('page.644d5f06bdba')}
                </button>
                <button
                  type="button"
                  data-testid="device-user-password-reset"
                  disabled={busy}
                  onClick={() => setModal('password')}
                >
                  {translate('page.7e422146dd5b')}
                </button>
                <button
                  type="button"
                  className="danger-button"
                  data-testid="device-user-disable"
                  disabled={busy || detailView.status === 'DISABLED'}
                  {...(detailView.status === 'DISABLED' ? { title: translate('page.0b78023f2a15') } : {})}
                  onClick={() => setDisableOpen(true)}
                >
                  {translate('page.d989e55188c9')}
                </button>
              </>
            ) : null}
            {canAssign ? (
              <>
                <button
                  type="button"
                  data-testid="device-user-assign"
                  disabled={busy || detailView.status === 'DISABLED'}
                  {...(detailView.status === 'DISABLED' ? { title: translate('page.70f547130bda') } : {})}
                  onClick={() => setModal('assign')}
                >
                  {translate('page.229546d5233e')}
                </button>
                <button
                  type="button"
                  data-testid="device-user-revoke"
                  disabled={busy || !detailView.assignments.some((a) => a.status === 'ACTIVE')}
                  {...(!detailView.assignments.some((a) => a.status === 'ACTIVE')
                    ? { title: translate('page.78216ecf2dfc') }
                    : {})}
                  onClick={() => setModal('revoke')}
                >
                  {translate('page.38fe0730070c')}
                </button>
              </>
            ) : null}
          </div>

          <section data-testid="device-user-assignments" aria-label={translate('page.c9a07e5c1fbd')}>
            <h5>{translate('page.c9a07e5c1fbd')}</h5>
            {detailView.assignments.length === 0 ? (
              <p className="empty-state" data-testid="assignments-empty">
                {translate('page.6364e9edd026')}
              </p>
            ) : (
              <table aria-label={translate('page.c9a07e5c1fbd')}>
                <thead>
                  <tr>
                    <th scope="col">{translate('page.01f2c16cda65')}</th>
                    <th scope="col">{translate('page.62e951a692ff')}</th>
                    <th scope="col">{translate('page.af2cdb23eed1')}</th>
                    <th scope="col">{translate('page.cca320a7ae9a')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detailView.assignments.map((a) => (
                    <tr key={a.assignmentId} data-testid={`user-assignment-${a.assignmentId}`}>
                      <td>{a.deviceId}</td>
                      <td>{DEVICE_USER_ASSIGNMENT_STATUS_LABELS[a.status] ?? a.status}</td>
                      <td>
                        <TimeText iso={a.assignedAt} />
                      </td>
                      <td>{a.revokedAt !== null ? <TimeText iso={a.revokedAt} /> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section data-testid="device-user-sync-states" aria-label={translate('page.1338e028c94c')}>
            <h5>{translate('page.969bc1b6280a')}</h5>
            <p className="field-hint">{translate('page.5db8e7715b3a')}</p>
            {(detailView.syncStates ?? []).length === 0 ? (
              <p className="empty-state">{translate('page.920160f6e04d')}</p>
            ) : (
              <table aria-label={translate('page.1338e028c94c')}>
                <thead>
                  <tr>
                    <th scope="col">{translate('page.01f2c16cda65')}</th>
                    <th scope="col">{translate('page.1e6d17c65416')}</th>
                    <th scope="col">{translate('page.590a52b9ae48')}</th>
                    <th scope="col">{translate('page.d8ba8ff705e9')}</th>
                    <th scope="col">{translate('page.1e3d4f2f1d00')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(detailView.syncStates ?? []).map((state) => (
                    <tr key={state.deviceId} data-testid={`user-sync-${state.deviceId}`}>
                      <td>{state.deviceId}</td>
                      <td>
                        {state.entityVersion === null ? translate('page.eb89a5e85f07') : `v${state.entityVersion}`}
                      </td>
                      <td>
                        {state.notificationStatus}
                        {state.notificationPublishedAt ? (
                          <>
                            {' '}
                            · <TimeText iso={state.notificationPublishedAt} />
                          </>
                        ) : null}
                      </td>
                      <td>
                        {state.snapshotStatus === 'NOT_SERVED'
                          ? translate('page.e630360276ef')
                          : (state.snapshotStatus === 'ACKNOWLEDGED'
                              ? translate('page.1086959ccc94')
                              : translate('page.4f75a1dce29f')) +
                            ' v' +
                            (state.deliveredEntityVersion ?? '?')}
                        {state.snapshotServedAt ? (
                          <>
                            {' '}
                            · <TimeText iso={state.snapshotServedAt} />
                          </>
                        ) : null}
                        {state.deviceReportedLastSyncAt ? (
                          <>
                            <br />
                            {translate('page.ba2bdef874e5')}
                            <TimeText iso={state.deviceReportedLastSyncAt} />
                          </>
                        ) : null}
                      </td>
                      <td>
                        {state.deviceApplyStatus === 'NOT_REPORTED'
                          ? translate('page.7b199c696da2')
                          : state.deviceApplyStatus}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </aside>
      ) : null}

      <Modal
        open={modal === 'create'}
        title={translate('page.6663d2d3519a')}
        testid="device-user-create-dialog"
        onClose={() => setModal(null)}
      >
        <CreateDeviceUserForm
          fixedCustomerId={fixedCustomerId}
          customerOptions={customerOptions}
          busy={busy}
          onSubmit={(input) => void runAction(() => onCreate(input), translate('page.7a93fc4e149c'))}
        />
      </Modal>

      {detailView !== null ? (
        <>
          <Modal
            open={modal === 'edit'}
            title={translate('page.644d5f06bdba')}
            testid="device-user-edit-dialog"
            onClose={() => setModal(null)}
          >
            <EditDisplayNameForm
              currentDisplayName={detailView.displayName}
              busy={busy}
              onSubmit={(displayName, reason) =>
                void runAction(
                  () => onUpdate(detailView.deviceUserId, { displayName, reason }),
                  translate('page.df6259d848bc'),
                )
              }
            />
          </Modal>

          <Modal
            open={modal === 'password'}
            title={translate('page.3073ed66a690')}
            testid="device-user-password-dialog"
            onClose={() => setModal(null)}
          >
            <PasswordResetForm
              busy={busy}
              onSubmit={(password, reason) =>
                void runAction(
                  () => onUpdate(detailView.deviceUserId, { password, reason }),
                  translate('page.2a4dfcd4b8bf'),
                )
              }
            />
          </Modal>

          <Modal
            open={modal === 'assign'}
            title={translate('page.229546d5233e')}
            testid="device-user-assign-dialog"
            onClose={() => setModal(null)}
          >
            <DevicePickForm
              testidPrefix="assign"
              devices={assignableDevices}
              reasonLabel={translate('page.fc530c4e70f6')}
              submitText={translate('page.1485e5902972')}
              busy={busy}
              onSubmit={(deviceIds, reason) =>
                void runAction(
                  () => onAssign(detailView.deviceUserId, deviceIds, reason),
                  translate('page.173f47097d59'),
                )
              }
            />
          </Modal>

          <Modal
            open={modal === 'revoke'}
            title={translate('page.38fe0730070c')}
            testid="device-user-revoke-dialog"
            onClose={() => setModal(null)}
          >
            <DevicePickForm
              testidPrefix="revoke"
              devices={detailView.assignments
                .filter((a) => a.status === 'ACTIVE')
                .map((a) => ({ value: a.deviceId, label: a.deviceId }))}
              reasonLabel={translate('page.e28c1ecca078')}
              submitText={translate('page.f7e81a7807cb')}
              busy={busy}
              onSubmit={(deviceIds, reason) =>
                void runAction(
                  () => onRevoke(detailView.deviceUserId, deviceIds, reason),
                  translate('page.543f69929495'),
                )
              }
            />
          </Modal>

          <ConfirmDialog
            open={disableOpen}
            title={translate('page.e79e46d7d4e9')}
            danger
            requireReason
            reasonLabel={translate('page.d599ea3c90af')}
            description={translate('page.e7992b508142') + detailView.username}
            confirmText={translate('page.f3abd8941903')}
            onConfirm={(reason) =>
              void runAction(() => onDisable(detailView.deviceUserId, reason), translate('page.3d95ae7025be'))
            }
            onCancel={() => setDisableOpen(false)}
          />
        </>
      ) : null}
    </div>
  );
}
function CreateDeviceUserForm({
  fixedCustomerId,
  customerOptions,
  busy,
  onSubmit,
}: {
  readonly fixedCustomerId: string | null;
  readonly customerOptions: readonly FilterOption[];
  readonly busy: boolean;
  readonly onSubmit: (input: {
    customerId?: string;
    username: string;
    displayName?: string;
    password: string;
    reason?: string;
  }) => void;
}) {
  const [customerId, setCustomerId] = useState(fixedCustomerId ?? '');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const validationError = validateDeviceUserCreate({ username, password });
  return (
    <div data-testid="device-user-create-form">
      {fixedCustomerId === null ? (
        <div className="dialog-field">
          <label htmlFor="create-user-customer">{translate('page.467c1137f479')}</label>
          <select
            id="create-user-customer"
            data-testid="create-user-customer"
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
          >
            <option value="">{translate('page.6bdb05d6eeeb')}</option>
            {customerOptions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="dialog-field">
        <label htmlFor="create-username">{translate('page.ec8a1f47f74e')}</label>
        <input
          id="create-username"
          data-testid="create-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="create-display-name">{translate('page.5c87b3144de0')}</label>
        <input
          id="create-display-name"
          data-testid="create-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="create-password">{translate('page.dcc2db120b45')}</label>
        <input
          id="create-password"
          type="password"
          autoComplete="new-password"
          data-testid="create-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="create-user-reason">{translate('page.db5e8a988ba0')}</label>
        <textarea
          id="create-user-reason"
          data-testid="create-user-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {username !== '' || password !== '' ? (
        validationError !== null ? (
          <p className="field-hint" data-testid="create-validation-error">
            {validationError}
          </p>
        ) : null
      ) : null}
      <div className="dialog-actions">
        <button
          type="button"
          className="primary-button"
          data-testid="create-user-submit"
          disabled={busy || validationError !== null || (fixedCustomerId === null && customerId === '')}
          onClick={() => {
            const trimmedDisplayName = displayName.trim();
            const trimmedReason = reason.trim();
            onSubmit({
              ...(fixedCustomerId !== null ? { customerId: fixedCustomerId } : { customerId }),
              username: username.trim(),
              ...(trimmedDisplayName !== '' ? { displayName: trimmedDisplayName } : {}),
              password,
              ...(trimmedReason !== '' ? { reason: trimmedReason } : {}),
            });
            // 密码只进入一次受控提交：提交后立即清空本地状态
            setPassword('');
          }}
        >
          {translate('page.315315d695e3')}
        </button>
      </div>
    </div>
  );
}
function EditDisplayNameForm({
  currentDisplayName,
  busy,
  onSubmit,
}: {
  readonly currentDisplayName: string | null;
  readonly busy: boolean;
  readonly onSubmit: (displayName: string | null, reason: string) => void;
}) {
  const [displayName, setDisplayName] = useState(currentDisplayName ?? '');
  const [reason, setReason] = useState('');
  const trimmed = displayName.trim();
  const reasonTrimmed = reason.trim();
  return (
    <div data-testid="device-user-edit-form">
      <div className="dialog-field">
        <label htmlFor="edit-display-name">{translate('page.de534c770f8e')}</label>
        <input
          id="edit-display-name"
          data-testid="edit-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="edit-reason">{translate('page.935f3e28f6f2')}</label>
        <textarea
          id="edit-reason"
          data-testid="edit-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="primary-button"
          data-testid="edit-submit"
          disabled={busy || reasonTrimmed === ''}
          onClick={() => onSubmit(trimmed === '' ? null : trimmed, reasonTrimmed)}
        >
          {translate('page.fadf24dbc5a9')}
        </button>
      </div>
    </div>
  );
}
function PasswordResetForm({
  busy,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onSubmit: (password: string, reason: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const reasonTrimmed = reason.trim();
  return (
    <div data-testid="device-user-password-form">
      <p className="field-hint">{translate('page.907970494838')}</p>
      <div className="dialog-field">
        <label htmlFor="reset-password">{translate('page.d22c9c008539')}</label>
        <input
          id="reset-password"
          type="password"
          autoComplete="new-password"
          data-testid="reset-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="reset-reason">{translate('page.935f3e28f6f2')}</label>
        <textarea
          id="reset-reason"
          data-testid="reset-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="danger-button"
          data-testid="reset-submit"
          disabled={busy || password === '' || reasonTrimmed === ''}
          onClick={() => {
            onSubmit(password, reasonTrimmed);
            // 提交后立即清空，不回显
            setPassword('');
          }}
        >
          {translate('page.30a6079ce340')}
        </button>
      </div>
    </div>
  );
}
function DevicePickForm({
  testidPrefix,
  devices,
  reasonLabel,
  submitText,
  busy,
  onSubmit,
}: {
  readonly testidPrefix: string;
  readonly devices: readonly FilterOption[];
  readonly reasonLabel: string;
  readonly submitText: string;
  readonly busy: boolean;
  readonly onSubmit: (deviceIds: readonly string[], reason: string) => void;
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [reason, setReason] = useState('');
  const reasonTrimmed = reason.trim();
  const toggle = (deviceId: string) => {
    setSelected((prev) => (prev.includes(deviceId) ? prev.filter((d) => d !== deviceId) : [...prev, deviceId]));
  };
  return (
    <div data-testid={`${testidPrefix}-form`}>
      <fieldset className="dialog-field">
        <legend>{translate('page.bcd7aea101ed')}</legend>
        {devices.length === 0 ? <p className="empty-state">{translate('page.18fb8c8c906c')}</p> : null}
        {devices.map((d) => (
          <label key={d.value}>
            <input
              type="checkbox"
              data-testid={`${testidPrefix}-device-${d.value}`}
              checked={selected.includes(d.value)}
              onChange={() => toggle(d.value)}
            />
            {d.label}
          </label>
        ))}
      </fieldset>
      <div className="dialog-field">
        <label htmlFor={`${testidPrefix}-reason`}>
          {reasonLabel}
          {translate('page.7b53c3b8c677')}
        </label>
        <textarea
          id={`${testidPrefix}-reason`}
          data-testid={`${testidPrefix}-reason`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="primary-button"
          data-testid={`${testidPrefix}-submit`}
          disabled={busy || selected.length === 0 || reasonTrimmed === ''}
          onClick={() => onSubmit(selected, reasonTrimmed)}
        >
          {submitText}
        </button>
      </div>
    </div>
  );
}
