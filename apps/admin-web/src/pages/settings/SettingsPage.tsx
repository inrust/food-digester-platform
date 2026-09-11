/**
 * FE-16 用户角色和业务设置页（/settings）：平台用户、设备用户、业务设置三标签页。
 *
 * - 平台用户（BE-RBAC-01）：邀请（Cognito 临时凭证，表单无永久密码字段）、角色整体替换、
 *   Customer scope 变更、停用、受控重置；角色集封闭（DEC-012），高风险权限变更明确确认；
 *   界面显示名用“设备操作员”（不使用“运维人员”）；
 * - RBAC 权限矩阵只读展示（DEC-012：V1 固定，复选框 disabled，仅可分配已有角色）；
 * - 设备用户标签页嵌入 FE-09 DeviceUsersPage（含筛选/重置/创建/停用/分配）；
 * - 业务设置（BE-SET-01）：封闭 key 集四项，乐观锁 version 更新（409 → 刷新恢复）；
 *   command.confirmation 确认方式 DEC-023 固定——只读不提供编辑；固定协议枚举/AWS 运维配置不可编辑；
 * - 自我提权/越权由服务端 403 拒绝并正确呈现；不管理 IAM/CloudWatch/Budget/生产账号。
 */
import { useRef, useState } from 'react';
import { PERMISSIONS, permissionsOf } from '@fdp/auth';
import type { Role } from '@fdp/auth';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import { DeviceUsersPage } from '../device-users/DeviceUsersPage.js';
import type { DeviceUsersPageProps } from '../device-users/DeviceUsersPage.js';
import type { InviteUserInput, UserListFilter } from './users-api.js';
import {
  ROLE_OPTIONS,
  RUNTIME_STATUS_LABELS,
  SETTING_KEY_LABELS,
  SETTING_READONLY_KEYS,
  USER_STATUS_LABELS,
  USER_STATUS_OPTIONS,
  canManageUsers,
  canReadDeviceUsers,
  canReadSettings,
  canReadUsers,
  canWriteSettings,
  isPlatformRole,
  roleDisplayName,
  validateInvite,
  validateRoleAssign,
  validateSettingJson,
} from './settings-state.js';
import type { InviteDraft } from './settings-state.js';
import type { ListState, PasswordResetResult, SettingKey, SettingView, UserStatus, UserView } from './types.js';

export interface SettingsPageProps {
  readonly role: Role;
  readonly users: ListState<UserView>;
  readonly userFilter: UserListFilter;
  readonly onApplyUserFilter: (filter: UserListFilter) => void;
  readonly onLoadMoreUsers: (cursor: string) => void;
  readonly onInviteUser: (input: InviteUserInput) => Promise<UserView>;
  readonly onAssignRoles: (userId: string, roles: readonly Role[]) => Promise<UserView>;
  readonly onSetScope: (userId: string, customerId: string) => Promise<UserView>;
  readonly onDisableUser: (userId: string) => Promise<UserView>;
  readonly onResetPassword: (userId: string) => Promise<PasswordResetResult>;
  readonly settings: { readonly rows: readonly SettingView[] | null; readonly error?: unknown };
  readonly onUpdateSetting: (key: SettingKey, value: unknown, version: number) => Promise<SettingView>;
  /** 设备用户标签页内容（FE-09 页面嵌入）；null = 无 device-user:read。 */
  readonly deviceUsers: DeviceUsersPageProps | null;
  readonly onRefresh: () => void;
}

type SettingsTab = 'platform-users' | 'device-users' | 'business-settings';

const TAB_LABELS: Readonly<Record<SettingsTab, string>> = {
  'platform-users': '平台角色/用户管理',
  'device-users': '设备用户管理',
  'business-settings': '业务设置',
};

type ConfirmTarget =
  | { readonly kind: 'disable'; readonly user: UserView }
  | { readonly kind: 'reset'; readonly user: UserView }
  | { readonly kind: 'assignRoles'; readonly user: UserView; readonly roles: readonly Role[] };

export function SettingsPage({
  role,
  users,
  userFilter,
  onApplyUserFilter,
  onLoadMoreUsers,
  onInviteUser,
  onAssignRoles,
  onSetScope,
  onDisableUser,
  onResetPassword,
  settings,
  onUpdateSetting,
  deviceUsers,
  onRefresh,
}: SettingsPageProps) {
  const visibleTabs: readonly SettingsTab[] = [
    ...(canReadUsers(role) ? (['platform-users'] as const) : []),
    ...(canReadDeviceUsers(role) ? (['device-users'] as const) : []),
    ...(canReadSettings(role) ? (['business-settings'] as const) : []),
  ];
  const [tab, setTab] = useState<SettingsTab>(visibleTabs[0] ?? 'device-users');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>({ email: '', displayName: '', roles: [], customerId: '' });
  const [assignTarget, setAssignTarget] = useState<{ user: UserView; roles: readonly Role[] } | null>(null);
  const [scopeTarget, setScopeTarget] = useState<{ user: UserView; customerId: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [settingEdit, setSettingEdit] = useState<{ setting: SettingView; raw: string } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftFilter, setDraftFilter] = useState<{
    roleType: 'platform' | 'customer' | '';
    status: UserStatus | '';
    customerId: string;
    q: string;
  }>({
    roleType: userFilter.roleType ?? '',
    status: userFilter.status ?? '',
    customerId: userFilter.customerId ?? '',
    q: userFilter.q ?? '',
  });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const manageUsers = canManageUsers(role);
  const writeSettings = canWriteSettings(role);
  const inviteError = validateInvite(inviteDraft);
  const inviteHasCustomerRole = inviteDraft.roles.some((r) => !isPlatformRole(r));

  const runAction = async (execute: () => Promise<string>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      setNotice(await execute());
      setConfirm(null);
      onRefresh();
    } catch (err) {
      setActionError(err);
      setConfirm(null);
      // 错误提示在 Modal 之外渲染：失败时关闭设置编辑框，避免 inert 背景导致错误不可见/不可交互
      setSettingEdit(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submitInvite = () =>
    runAction(async () => {
      if (inviteError !== null) throw new Error(inviteError);
      const input: InviteUserInput = {
        email: inviteDraft.email.trim(),
        displayName: inviteDraft.displayName.trim(),
        roles: inviteDraft.roles,
        ...(inviteHasCustomerRole ? { customerId: inviteDraft.customerId.trim() } : {}),
      };
      const created = await onInviteUser(input);
      setInviteOpen(false);
      setInviteDraft({ email: '', displayName: '', roles: [], customerId: '' });
      return `邀请已发送（${created.email}，状态：已邀请）；临时凭证由 Cognito 经邮件发送，本页面不接触密码`;
    });

  const submitConfirm = () =>
    runAction(async () => {
      if (confirm === null) return '';
      if (confirm.kind === 'disable') {
        await onDisableUser(confirm.user.userId);
        return `用户 ${confirm.user.email} 已停用（幂等回放）`;
      }
      if (confirm.kind === 'reset') {
        await onResetPassword(confirm.user.userId);
        return `已触发密码重置（${confirm.user.email}）；临时凭证由 Cognito 直接发送给用户，本页面不接触密码`;
      }
      const updated = await onAssignRoles(confirm.user.userId, confirm.roles);
      setAssignTarget(null);
      return `角色已更新：${updated.roles.map(roleDisplayName).join('、')}`;
    });

  const submitScope = () =>
    runAction(async () => {
      if (scopeTarget === null) return '';
      await onSetScope(scopeTarget.user.userId, scopeTarget.customerId.trim());
      setScopeTarget(null);
      return `Customer scope 已更新为 ${scopeTarget.customerId.trim()}`;
    });

  const submitSetting = () =>
    runAction(async () => {
      if (settingEdit === null) return '';
      const jsonError = validateSettingJson(settingEdit.raw);
      if (jsonError !== null) throw new Error(jsonError);
      const updated = await onUpdateSetting(
        settingEdit.setting.key,
        JSON.parse(settingEdit.raw),
        settingEdit.setting.version,
      );
      setSettingEdit(null);
      return `设置 ${SETTING_KEY_LABELS[updated.key]} 已更新（v${updated.version}，${RUNTIME_STATUS_LABELS[updated.runtimeStatus]}）`;
    });

  return (
    <div className="settings-page" data-testid="settings-page">
      <div className="page-header">
        <h3>用户管理</h3>
      </div>

      <nav className="tab-bar" data-testid="settings-tabs" aria-label="设置标签页">
        {visibleTabs.map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`tab-${t}`}
            aria-pressed={tab === t}
            className={tab === t ? 'tab active' : 'tab'}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      {tab === 'platform-users' ? (
        <section data-testid="platform-users-tab" aria-label="平台用户">
          <div className="filter-bar">
            <label htmlFor="user-filter-role-type">角色类型</label>
            <select
              id="user-filter-role-type"
              data-testid="user-filter-role-type"
              value={draftFilter.roleType}
              onChange={(event) =>
                setDraftFilter({ ...draftFilter, roleType: event.target.value as 'platform' | 'customer' | '' })
              }
            >
              <option value="">全部</option>
              <option value="platform">平台角色</option>
              <option value="customer">Customer 角色</option>
            </select>
            <label htmlFor="user-filter-status">状态</label>
            <select
              id="user-filter-status"
              data-testid="user-filter-status"
              value={draftFilter.status}
              onChange={(event) =>
                setDraftFilter({ ...draftFilter, status: event.target.value as UserStatus | '' })
              }
            >
              <option value="">全部</option>
              {USER_STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {USER_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
            <label htmlFor="user-filter-customer">客户 ID</label>
            <input
              id="user-filter-customer"
              data-testid="user-filter-customer"
              value={draftFilter.customerId}
              onChange={(event) => setDraftFilter({ ...draftFilter, customerId: event.target.value })}
            />
            <label htmlFor="user-filter-q">关键词</label>
            <input
              id="user-filter-q"
              data-testid="user-filter-q"
              value={draftFilter.q}
              onChange={(event) => setDraftFilter({ ...draftFilter, q: event.target.value })}
            />
            <button
              type="button"
              className="primary-button"
              data-testid="user-filter-search"
              onClick={() =>
                onApplyUserFilter({
                  roleType: draftFilter.roleType === '' ? null : draftFilter.roleType,
                  status: draftFilter.status === '' ? null : draftFilter.status,
                  customerId: draftFilter.customerId.trim() === '' ? null : draftFilter.customerId.trim(),
                  q: draftFilter.q.trim() === '' ? null : draftFilter.q.trim(),
                })
              }
            >
              筛选
            </button>
            <button
              type="button"
              className="primary-button"
              data-testid="user-invite-open"
              disabled={!manageUsers || busy}
              {...(!manageUsers ? { title: '需要用户写权限（user:write）' } : {})}
              onClick={() => {
                setInviteDraft({ email: '', displayName: '', roles: [], customerId: '' });
                setInviteOpen(true);
              }}
            >
              新建平台用户
            </button>
          </div>

          <CursorTable
            ariaLabel="用户列表"
            columns={[
              { key: 'email', header: '邮箱', render: (u) => u.email },
              { key: 'displayName', header: '显示名', render: (u) => u.displayName },
              {
                key: 'roles',
                header: '角色',
                render: (u) => u.roles.map(roleDisplayName).join('、'),
              },
              { key: 'status', header: '状态', render: (u) => USER_STATUS_LABELS[u.status] },
              { key: 'mfaEnabled', header: 'MFA', render: (u) => (u.mfaEnabled ? '已启用' : '未启用') },
              { key: 'customerId', header: '所属客户', render: (u) => u.customerId ?? '—（平台角色）' },
              { key: 'updatedAt', header: '更新时间', render: (u) => <TimeText iso={u.updatedAt} /> },
              {
                key: 'actions',
                header: '操作',
                render: (u) => (
                  <span className="action-row">
                    <button
                      type="button"
                      data-testid={`user-roles-${u.userId}`}
                      disabled={!manageUsers || busy || u.status === 'DISABLED'}
                      onClick={() => setAssignTarget({ user: u, roles: u.roles })}
                    >
                      角色
                    </button>
                    {u.roles.every((r) => !isPlatformRole(r)) ? (
                      <button
                        type="button"
                        data-testid={`user-scope-${u.userId}`}
                        disabled={!manageUsers || busy || u.status === 'DISABLED'}
                        onClick={() => setScopeTarget({ user: u, customerId: u.customerId ?? '' })}
                      >
                        Scope
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid={`user-reset-${u.userId}`}
                      disabled={!manageUsers || busy || u.status === 'DISABLED'}
                      onClick={() => setConfirm({ kind: 'reset', user: u })}
                    >
                      重置密码
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      data-testid={`user-disable-${u.userId}`}
                      disabled={!manageUsers || busy || u.status === 'DISABLED'}
                      onClick={() => setConfirm({ kind: 'disable', user: u })}
                    >
                      停用
                    </button>
                  </span>
                ),
              },
            ]}
            rows={users.rows === null ? null : [...users.rows]}
            rowKey={(u) => u.userId}
            {...(users.loading !== undefined ? { loading: users.loading } : {})}
            {...(users.error !== undefined ? { error: users.error } : {})}
            {...(users.nextCursor !== undefined ? { nextCursor: users.nextCursor } : {})}
            onNextPage={onLoadMoreUsers}
            onRefresh={onRefresh}
            emptyText="暂无用户"
          />

          <section data-testid="rbac-matrix" aria-label="权限矩阵（只读）">
            <h4>权限矩阵（V1 固定，只读）</h4>
            <p className="field-hint">
              权限复选框仅展示当前角色的固定权限点（DEC-012）；仅允许给用户分配已有角色，矩阵本身不可编辑。
            </p>
            {ROLE_OPTIONS.map((r) => (
              <div key={r} className="rbac-role" data-testid={`rbac-role-${r}`}>
                <h5>{roleDisplayName(r)}</h5>
                <div className="rbac-perms">
                  {PERMISSIONS.map((permission) => (
                    <label key={permission} className="rbac-perm">
                      <input
                        type="checkbox"
                        data-testid={`rbac-${r}-${permission}`}
                        checked={permissionsOf(r).has(permission)}
                        disabled
                        readOnly
                      />
                      {permission}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </section>
        </section>
      ) : null}

      {tab === 'device-users' ? (
        <section data-testid="device-users-tab" aria-label="设备用户">
          {deviceUsers !== null ? (
            <DeviceUsersPage {...deviceUsers} />
          ) : (
            <p className="empty-state" data-testid="device-users-unavailable">
              无设备用户查看权限（device-user:read）
            </p>
          )}
        </section>
      ) : null}

      {tab === 'business-settings' ? (
        <section data-testid="business-settings-tab" aria-label="业务设置">
          <p className="field-hint">
            封闭 key 集四项；固定协议枚举、Topic、DEC-023 确认方式与 AWS 运维配置不可经此编辑。
            更新携带当前版本（乐观锁）；STORED_ONLY 项更新不代表业务行为生效。
          </p>
          {settings.error !== undefined ? <ErrorNotice error={settings.error} onRefresh={onRefresh} /> : null}
          {settings.rows === null ? (
            <div role="status" data-testid="settings-loading">
              加载中…
            </div>
          ) : (
            settings.rows.map((setting) => {
              const readonly = SETTING_READONLY_KEYS.includes(setting.key);
              return (
                <div key={setting.key} className="setting-item" data-testid={`setting-${setting.key}`}>
                  <h5>
                    {SETTING_KEY_LABELS[setting.key]}
                    <span className="setting-runtime" data-testid={`setting-runtime-${setting.key}`}>
                      {RUNTIME_STATUS_LABELS[setting.runtimeStatus]}
                      {setting.runtimeConsumer !== null ? `（消费方 ${setting.runtimeConsumer}）` : ''}
                    </span>
                  </h5>
                  <p className="field-hint">
                    v{setting.version} · {setting.updatedBy ?? '—'} · <TimeText iso={setting.updatedAt} />
                  </p>
                  <pre data-testid={`setting-value-${setting.key}`}>{JSON.stringify(setting.value, null, 2)}</pre>
                  {readonly ? (
                    <p className="field-hint" data-testid={`setting-readonly-${setting.key}`}>
                      确认方式由 DEC-023 固定，只读
                    </p>
                  ) : (
                    <button
                      type="button"
                      data-testid={`setting-edit-${setting.key}`}
                      disabled={!writeSettings || busy}
                      {...(!writeSettings ? { title: '需要设置写权限（settings:write）' } : {})}
                      onClick={() => setSettingEdit({ setting, raw: JSON.stringify(setting.value, null, 2) })}
                    >
                      编辑
                    </button>
                  )}
                </div>
              );
            })
          )}
        </section>
      ) : null}

      <Modal open={inviteOpen} title="新建平台用户（邀请）" testid="user-invite-form" onClose={() => setInviteOpen(false)}>
        <div className="dialog-field">
          <label htmlFor="invite-email">邮箱</label>
          <input
            id="invite-email"
            data-testid="invite-email"
            value={inviteDraft.email}
            onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })}
          />
        </div>
        <div className="dialog-field">
          <label htmlFor="invite-display-name">显示名</label>
          <input
            id="invite-display-name"
            data-testid="invite-display-name"
            maxLength={128}
            value={inviteDraft.displayName}
            onChange={(event) => setInviteDraft({ ...inviteDraft, displayName: event.target.value })}
          />
        </div>
        <div className="dialog-field">
          <span id="invite-roles-label">角色（封闭集，平台/Customer 禁止混绑）</span>
          <div role="group" aria-labelledby="invite-roles-label" data-testid="invite-roles">
            {ROLE_OPTIONS.map((r) => (
              <label key={r}>
                <input
                  type="checkbox"
                  data-testid={`invite-role-${r}`}
                  checked={inviteDraft.roles.includes(r)}
                  onChange={(event) =>
                    setInviteDraft({
                      ...inviteDraft,
                      roles: event.target.checked
                        ? [...inviteDraft.roles, r]
                        : inviteDraft.roles.filter((x) => x !== r),
                    })
                  }
                />
                {roleDisplayName(r)}
              </label>
            ))}
          </div>
        </div>
        {inviteHasCustomerRole ? (
          <div className="dialog-field">
            <label htmlFor="invite-customer">所属 Customer（Customer 角色必填）</label>
            <input
              id="invite-customer"
              data-testid="invite-customer"
              value={inviteDraft.customerId}
              onChange={(event) => setInviteDraft({ ...inviteDraft, customerId: event.target.value })}
            />
          </div>
        ) : null}
        <p className="field-hint">临时凭证由 Cognito 生成并经邮件发送；本表单不设置永久密码。</p>
        {inviteError !== null ? (
          <p className="field-hint" data-testid="invite-error">
            {inviteError}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button"
            data-testid="invite-submit"
            disabled={busy || inviteError !== null}
            onClick={() => void submitInvite()}
          >
            发送邀请
          </button>
        </div>
      </Modal>

      <Modal
        open={assignTarget !== null}
        title={assignTarget !== null ? `角色分配：${assignTarget.user.email}` : '角色分配'}
        testid="user-roles-form"
        onClose={() => setAssignTarget(null)}
      >
        {assignTarget !== null ? (
          <div>
            <p className="field-hint">整体替换角色集（1~3 个，平台/Customer 禁止混绑）；变更为高风险权限操作，需明确确认。</p>
            <div role="group" aria-label="角色" data-testid="assign-roles">
              {ROLE_OPTIONS.map((r) => (
                <label key={r}>
                  <input
                    type="checkbox"
                    data-testid={`assign-role-${r}`}
                    checked={assignTarget.roles.includes(r)}
                    onChange={(event) =>
                      setAssignTarget({
                        ...assignTarget,
                        roles: event.target.checked
                          ? [...assignTarget.roles, r]
                          : assignTarget.roles.filter((x) => x !== r),
                      })
                    }
                  />
                  {roleDisplayName(r)}
                </label>
              ))}
            </div>
            {validateRoleAssign(assignTarget.roles) !== null ? (
              <p className="field-hint" data-testid="assign-error">
                {validateRoleAssign(assignTarget.roles)}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                data-testid="assign-submit"
                disabled={busy || validateRoleAssign(assignTarget.roles) !== null}
                onClick={() => setConfirm({ kind: 'assignRoles', user: assignTarget.user, roles: assignTarget.roles })}
              >
                提交角色变更
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={scopeTarget !== null}
        title={scopeTarget !== null ? `Customer scope：${scopeTarget.user.email}` : 'Customer scope'}
        testid="user-scope-form"
        onClose={() => setScopeTarget(null)}
      >
        {scopeTarget !== null ? (
          <div>
            <div className="dialog-field">
              <label htmlFor="scope-customer">所属 Customer</label>
              <input
                id="scope-customer"
                data-testid="scope-customer"
                value={scopeTarget.customerId}
                onChange={(event) => setScopeTarget({ ...scopeTarget, customerId: event.target.value })}
              />
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                data-testid="scope-submit"
                disabled={busy || scopeTarget.customerId.trim() === ''}
                onClick={() => void submitScope()}
              >
                保存 scope
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={settingEdit !== null}
        title={settingEdit !== null ? `编辑设置：${SETTING_KEY_LABELS[settingEdit.setting.key]}` : '编辑设置'}
        testid="setting-edit-form"
        onClose={() => setSettingEdit(null)}
      >
        {settingEdit !== null ? (
          <div>
            <p className="field-hint">
              当前版本 v{settingEdit.setting.version}（乐观锁，提交时回传；冲突 → 刷新后重试）。
              {RUNTIME_STATUS_LABELS[settingEdit.setting.runtimeStatus]}。
            </p>
            <div className="dialog-field">
              <label htmlFor="setting-value-input">设置值（JSON）</label>
              <textarea
                id="setting-value-input"
                data-testid="setting-value-input"
                rows={10}
                value={settingEdit.raw}
                onChange={(event) => setSettingEdit({ ...settingEdit, raw: event.target.value })}
              />
            </div>
            {validateSettingJson(settingEdit.raw) !== null ? (
              <p className="field-hint" data-testid="setting-value-error">
                {validateSettingJson(settingEdit.raw)}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                data-testid="setting-submit"
                disabled={busy || validateSettingJson(settingEdit.raw) !== null}
                onClick={() => void submitSetting()}
              >
                保存设置
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'disable'
            ? `停用用户：${confirm.user.email}`
            : confirm?.kind === 'reset'
              ? `重置密码：${confirm.user.email}`
              : confirm?.kind === 'assignRoles'
                ? `确认角色变更：${confirm.user.email}`
                : ''
        }
        {...(confirm?.kind === 'disable'
          ? { description: '停用后该用户无法登录（Cognito 同步停用；最后一个平台管理员不可停用）。', danger: true }
          : confirm?.kind === 'reset'
            ? { description: '触发后 Cognito 生成并发送临时凭证给用户；本操作不读取或显示密码。' }
            : confirm?.kind === 'assignRoles'
              ? { description: `高风险权限变更：角色整体替换为 ${confirm.roles.map(roleDisplayName).join('、')}。`, danger: true }
              : {})}
        confirmText={confirm?.kind === 'disable' ? '确认停用' : confirm?.kind === 'reset' ? '触发重置' : '确认变更'}
        onConfirm={() => void submitConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
