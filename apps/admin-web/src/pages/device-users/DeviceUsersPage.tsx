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
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'ready'; readonly detail: DeviceUserDetailView };

export interface DeviceUserFilter {
  readonly customerId: string | null;
  readonly status: 'ACTIVE' | 'DISABLED' | null;
  readonly keyword: string | null;
}

export const EMPTY_DEVICE_USER_FILTER: DeviceUserFilter = { customerId: null, status: null, keyword: null };

export interface DeviceUsersPageProps {
  readonly role: Role;
  /** Customer 角色父级强制传入本 Customer ID（页面隐藏客户选择）。 */
  readonly fixedCustomerId?: string | null;
  readonly customerOptions: readonly FilterOption[];
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
    input: { displayName?: string | null; password?: string; reason: string },
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
            <label htmlFor="device-user-customer">所属客户</label>
            <select
              id="device-user-customer"
              data-testid="device-user-customer-filter"
              value={draftFilter.customerId ?? ''}
              onChange={(event) =>
                setDraftFilter({ ...draftFilter, customerId: event.target.value === '' ? null : event.target.value })
              }
            >
              <option value="">全部</option>
              {customerOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label htmlFor="device-user-status">状态</label>
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
          <option value="">全部</option>
          {DEVICE_USER_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {DEVICE_USER_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <label htmlFor="device-user-keyword">关键字</label>
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
          筛选
        </button>
        <button
          type="button"
          data-testid="device-user-filter-reset"
          onClick={() => {
            setDraftFilter(EMPTY_DEVICE_USER_FILTER);
            onApplyFilter(EMPTY_DEVICE_USER_FILTER);
          }}
        >
          重置
        </button>
        {canWrite ? (
          <button
            type="button"
            className="primary-button"
            data-testid="device-user-create"
            onClick={() => setModal('create')}
          >
            新增设备用户
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
          加载中…
        </div>
      ) : list.rows.length === 0 ? (
        <p className="empty-state" data-testid="device-user-empty">
          暂无设备用户
        </p>
      ) : (
        <table aria-label="设备用户列表" data-testid="device-user-table">
          <thead>
            <tr>
              <th scope="col">用户名</th>
              <th scope="col">显示名</th>
              <th scope="col">状态</th>
              <th scope="col">分配设备数</th>
              <th scope="col">同步版本</th>
              <th scope="col">更新时间</th>
              <th scope="col">操作</th>
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
                    详情
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="device-user-detail-loading">
          加载中…
        </div>
      ) : null}
      {detail.kind === 'error' ? <ErrorNotice error={detail.error} onRefresh={onRefresh} /> : null}

      {detailView !== null ? (
        <aside className="device-user-detail" data-testid="device-user-detail" aria-label="设备用户详情">
          <h4>设备用户详情</h4>
          <dl>
            <dt>用户名</dt>
            <dd data-testid="detail-username">{detailView.username}</dd>
            <dt>显示名</dt>
            <dd>{detailView.displayName ?? '—'}</dd>
            <dt>所属客户</dt>
            <dd>{detailView.customerId}</dd>
            <dt>状态</dt>
            <dd data-testid="detail-status">{DEVICE_USER_STATUS_LABELS[detailView.status]}</dd>
            <dt>同步版本</dt>
            <dd data-testid="detail-version">v{detailView.version}</dd>
            <dt>更新时间</dt>
            <dd>
              <TimeText iso={detailView.updatedAt} />
            </dd>
          </dl>

          <div className="detail-actions">
            <button type="button" onClick={onCloseDetail}>
              关闭
            </button>
            {canWrite ? (
              <>
                <button type="button" data-testid="device-user-edit" disabled={busy} onClick={() => setModal('edit')}>
                  修改资料
                </button>
                <button
                  type="button"
                  data-testid="device-user-password-reset"
                  disabled={busy}
                  onClick={() => setModal('password')}
                >
                  重置密码
                </button>
                <button
                  type="button"
                  className="danger-button"
                  data-testid="device-user-disable"
                  disabled={busy || detailView.status === 'DISABLED'}
                  {...(detailView.status === 'DISABLED' ? { title: '用户已停用' } : {})}
                  onClick={() => setDisableOpen(true)}
                >
                  停用
                </button>
              </>
            ) : null}
            {canAssign ? (
              <>
                <button
                  type="button"
                  data-testid="device-user-assign"
                  disabled={busy || detailView.status === 'DISABLED'}
                  {...(detailView.status === 'DISABLED' ? { title: '停用用户不可新分配' } : {})}
                  onClick={() => setModal('assign')}
                >
                  分配设备
                </button>
                <button
                  type="button"
                  data-testid="device-user-revoke"
                  disabled={busy || !detailView.assignments.some((a) => a.status === 'ACTIVE')}
                  {...(!detailView.assignments.some((a) => a.status === 'ACTIVE')
                    ? { title: '无生效中的分配可撤销' }
                    : {})}
                  onClick={() => setModal('revoke')}
                >
                  撤销分配
                </button>
              </>
            ) : null}
          </div>

          <section data-testid="device-user-assignments" aria-label="分配历史">
            <h5>分配历史</h5>
            {detailView.assignments.length === 0 ? (
              <p className="empty-state" data-testid="assignments-empty">
                暂无分配
              </p>
            ) : (
              <table aria-label="分配历史">
                <thead>
                  <tr>
                    <th scope="col">设备</th>
                    <th scope="col">状态</th>
                    <th scope="col">分配时间</th>
                    <th scope="col">撤销时间</th>
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
        </aside>
      ) : null}

      <Modal
        open={modal === 'create'}
        title="新增设备用户"
        testid="device-user-create-dialog"
        onClose={() => setModal(null)}
      >
        <CreateDeviceUserForm
          fixedCustomerId={fixedCustomerId}
          customerOptions={customerOptions}
          busy={busy}
          onSubmit={(input) => void runAction(() => onCreate(input), '设备用户已创建')}
        />
      </Modal>

      {detailView !== null ? (
        <>
          <Modal
            open={modal === 'edit'}
            title="修改资料"
            testid="device-user-edit-dialog"
            onClose={() => setModal(null)}
          >
            <EditDisplayNameForm
              currentDisplayName={detailView.displayName}
              busy={busy}
              onSubmit={(displayName, reason) =>
                void runAction(() => onUpdate(detailView.deviceUserId, { displayName, reason }), '资料已更新')
              }
            />
          </Modal>

          <Modal
            open={modal === 'password'}
            title="重置设备本地密码"
            testid="device-user-password-dialog"
            onClose={() => setModal(null)}
          >
            <PasswordResetForm
              busy={busy}
              onSubmit={(password, reason) =>
                void runAction(
                  () => onUpdate(detailView.deviceUserId, { password, reason }),
                  '密码已轮换（设备将在下次同步时领取新验证材料）',
                )
              }
            />
          </Modal>

          <Modal
            open={modal === 'assign'}
            title="分配设备"
            testid="device-user-assign-dialog"
            onClose={() => setModal(null)}
          >
            <DevicePickForm
              testidPrefix="assign"
              devices={assignableDevices}
              reasonLabel="分配原因"
              submitText="确认分配"
              busy={busy}
              onSubmit={(deviceIds, reason) =>
                void runAction(() => onAssign(detailView.deviceUserId, deviceIds, reason), '分配已完成')
              }
            />
          </Modal>

          <Modal
            open={modal === 'revoke'}
            title="撤销分配"
            testid="device-user-revoke-dialog"
            onClose={() => setModal(null)}
          >
            <DevicePickForm
              testidPrefix="revoke"
              devices={detailView.assignments
                .filter((a) => a.status === 'ACTIVE')
                .map((a) => ({ value: a.deviceId, label: a.deviceId }))}
              reasonLabel="撤销原因"
              submitText="确认撤销"
              busy={busy}
              onSubmit={(deviceIds, reason) =>
                void runAction(() => onRevoke(detailView.deviceUserId, deviceIds, reason), '分配已撤销')
              }
            />
          </Modal>

          <ConfirmDialog
            open={disableOpen}
            title="停用设备用户"
            danger
            requireReason
            reasonLabel="停用原因"
            description={`停用后该用户不进入新 Sync（设备下次同步后失效）。用户：${detailView.username}`}
            confirmText="确认停用"
            onConfirm={(reason) => void runAction(() => onDisable(detailView.deviceUserId, reason), '设备用户已停用')}
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
          <label htmlFor="create-user-customer">所属客户</label>
          <select
            id="create-user-customer"
            data-testid="create-user-customer"
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
          >
            <option value="">请选择客户</option>
            {customerOptions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="dialog-field">
        <label htmlFor="create-username">用户名（同客户内唯一）</label>
        <input
          id="create-username"
          data-testid="create-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="create-display-name">显示名（可选）</label>
        <input
          id="create-display-name"
          data-testid="create-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="create-password">设备本地密码（仅本次提交，不回显）</label>
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
        <label htmlFor="create-user-reason">原因（可选，写入审计）</label>
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
          创建用户
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
        <label htmlFor="edit-display-name">显示名（留空并勾选清除 = null）</label>
        <input
          id="edit-display-name"
          data-testid="edit-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="edit-reason">原因（必填，写入审计）</label>
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
          保存
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
      <p className="field-hint">
        新密码仅本次提交发送一次，服务端立即派生加盐验证值；本页面不回显、不存储、不可再次查看。
      </p>
      <div className="dialog-field">
        <label htmlFor="reset-password">新密码</label>
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
        <label htmlFor="reset-reason">原因（必填，写入审计）</label>
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
          确认重置
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
        <legend>设备（批量，全成或全败）</legend>
        {devices.length === 0 ? <p className="empty-state">无可选设备</p> : null}
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
        <label htmlFor={`${testidPrefix}-reason`}>{reasonLabel}（必填，写入审计）</label>
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
