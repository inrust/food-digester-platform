import { translate } from '../../i18n/i18n.js';
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
import { PERMISSIONS, permissionsOf } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
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
  readonly settings: {
    readonly rows: readonly SettingView[] | null;
    readonly error?: unknown;
  };
  readonly onUpdateSetting: (key: SettingKey, value: unknown, version: number) => Promise<SettingView>;
  /** 设备用户标签页内容（FE-09 页面嵌入）；null = 无 device-user:read。 */
  readonly deviceUsers: DeviceUsersPageProps | null;
  readonly onRefresh: () => void;
}
type SettingsTab = 'platform-users' | 'device-users' | 'business-settings';
const TAB_LABELS: Readonly<Record<SettingsTab, string>> = {
  get 'platform-users'() {
    return translate('page.192c9887b3e0');
  },
  get 'device-users'() {
    return translate('page.7fc5eb892df6');
  },
  get 'business-settings'() {
    return translate('page.60735b2edd9f');
  },
};
type ConfirmTarget =
  | {
      readonly kind: 'disable';
      readonly user: UserView;
    }
  | {
      readonly kind: 'reset';
      readonly user: UserView;
    }
  | {
      readonly kind: 'assignRoles';
      readonly user: UserView;
      readonly roles: readonly Role[];
    };
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
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>({
    email: '',
    displayName: '',
    roles: [],
    customerId: '',
  });
  const [assignTarget, setAssignTarget] = useState<{
    user: UserView;
    roles: readonly Role[];
  } | null>(null);
  const [scopeTarget, setScopeTarget] = useState<{
    user: UserView;
    customerId: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [settingEdit, setSettingEdit] = useState<{
    setting: SettingView;
    raw: string;
  } | null>(null);
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
      return translate('page.c8e407df3590') + created.email + translate('page.9ee547c292e4');
    });
  const submitConfirm = () =>
    runAction(async () => {
      if (confirm === null) return '';
      if (confirm.kind === 'disable') {
        await onDisableUser(confirm.user.userId);
        return translate('page.9ba763ea3423') + ' ' + confirm.user.email + (' ' + translate('page.85d8f9c121a9'));
      }
      if (confirm.kind === 'reset') {
        await onResetPassword(confirm.user.userId);
        return translate('page.801f8e1a70bc') + confirm.user.email + translate('page.507c8bd1e8d6');
      }
      const updated = await onAssignRoles(confirm.user.userId, confirm.roles);
      setAssignTarget(null);
      return translate('page.fbb8820173df') + updated.roles.map(roleDisplayName).join('、');
    });
  const submitScope = () =>
    runAction(async () => {
      if (scopeTarget === null) return '';
      await onSetScope(scopeTarget.user.userId, scopeTarget.customerId.trim());
      setScopeTarget(null);
      return translate('page.10981eeb16f3') + ' ' + scopeTarget.customerId.trim();
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
      return (
        translate('page.7debf9cb0372') +
        ' ' +
        SETTING_KEY_LABELS[updated.key] +
        (' ' + translate('page.3395e930dfa7')) +
        updated.version +
        '\uFF0C' +
        RUNTIME_STATUS_LABELS[updated.runtimeStatus] +
        '\uFF09'
      );
    });
  return (
    <div className="settings-page" data-testid="settings-page">
      <div className="page-header">
        <h3>{translate('page.baf84751a2a2')}</h3>
      </div>

      <nav className="tab-bar" data-testid="settings-tabs" aria-label={translate('page.578c6cd1c080')}>
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
        <section data-testid="platform-users-tab" aria-label={translate('page.5da6c051fbdc')}>
          <div className="filter-bar">
            <label htmlFor="user-filter-role-type">{translate('page.cb23226152c7')}</label>
            <select
              id="user-filter-role-type"
              data-testid="user-filter-role-type"
              value={draftFilter.roleType}
              onChange={(event) =>
                setDraftFilter({ ...draftFilter, roleType: event.target.value as 'platform' | 'customer' | '' })
              }
            >
              <option value="">{translate('page.778fc8f99453')}</option>
              <option value="platform">{translate('page.736a37d8b701')}</option>
              <option value="customer">{translate('page.2f9d2e2775b9')}</option>
            </select>
            <label htmlFor="user-filter-status">{translate('page.62e951a692ff')}</label>
            <select
              id="user-filter-status"
              data-testid="user-filter-status"
              value={draftFilter.status}
              onChange={(event) => setDraftFilter({ ...draftFilter, status: event.target.value as UserStatus | '' })}
            >
              <option value="">{translate('page.778fc8f99453')}</option>
              {USER_STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {USER_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
            <label htmlFor="user-filter-customer">{translate('page.a20148b7e39a')}</label>
            <input
              id="user-filter-customer"
              data-testid="user-filter-customer"
              value={draftFilter.customerId}
              onChange={(event) => setDraftFilter({ ...draftFilter, customerId: event.target.value })}
            />
            <label htmlFor="user-filter-q">{translate('page.cc1b21e80080')}</label>
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
              {translate('page.dcce9a144a40')}
            </button>
            <button
              type="button"
              className="primary-button"
              data-testid="user-invite-open"
              disabled={!manageUsers || busy}
              {...(!manageUsers ? { title: translate('page.47ccbd849cdf') } : {})}
              onClick={() => {
                setInviteDraft({ email: '', displayName: '', roles: [], customerId: '' });
                setInviteOpen(true);
              }}
            >
              {translate('page.d3e63cf5b87c')}
            </button>
          </div>

          <CursorTable
            ariaLabel={translate('page.b3d9235f9207')}
            columns={[
              { key: 'email', header: translate('page.9ed627bcf63d'), render: (u) => u.email },
              { key: 'displayName', header: translate('page.c10bbf5ddd2d'), render: (u) => u.displayName },
              {
                key: 'roles',
                header: translate('page.6b26695e4dce'),
                render: (u) => u.roles.map(roleDisplayName).join('、'),
              },
              { key: 'status', header: translate('page.62e951a692ff'), render: (u) => USER_STATUS_LABELS[u.status] },
              {
                key: 'mfaEnabled',
                header: 'MFA',
                render: (u) => (u.mfaEnabled ? translate('page.25d284315063') : translate('page.8bb38ef00ccc')),
              },
              {
                key: 'customerId',
                header: translate('page.467c1137f479'),
                render: (u) => u.customerId ?? translate('page.79dd9422df51'),
              },
              {
                key: 'updatedAt',
                header: translate('page.093dea88c930'),
                render: (u) => <TimeText iso={u.updatedAt} />,
              },
              {
                key: 'actions',
                header: translate('page.f3ea6d345e2a'),
                render: (u) => (
                  <span className="action-row">
                    <button
                      type="button"
                      data-testid={`user-roles-${u.userId}`}
                      disabled={!manageUsers || busy || u.status === 'DISABLED'}
                      onClick={() => setAssignTarget({ user: u, roles: u.roles })}
                    >
                      {translate('page.6b26695e4dce')}
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
                      {translate('page.7e422146dd5b')}
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      data-testid={`user-disable-${u.userId}`}
                      disabled={!manageUsers || busy || u.status === 'DISABLED'}
                      onClick={() => setConfirm({ kind: 'disable', user: u })}
                    >
                      {translate('page.d989e55188c9')}
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
            emptyText={translate('page.3d268bdd3945')}
          />

          <section data-testid="rbac-matrix" aria-label={translate('page.38d9705d3fe6')}>
            <h4>{translate('page.3899d000246c')}</h4>
            <p className="field-hint">{translate('page.af0664f3442f')}</p>
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
        <section data-testid="device-users-tab" aria-label={translate('page.024ebe3ff3d1')}>
          {deviceUsers !== null ? (
            <DeviceUsersPage {...deviceUsers} />
          ) : (
            <p className="empty-state" data-testid="device-users-unavailable">
              {translate('page.7ee40e932983')}
            </p>
          )}
        </section>
      ) : null}

      {tab === 'business-settings' ? (
        <section data-testid="business-settings-tab" aria-label={translate('page.60735b2edd9f')}>
          <p className="field-hint">{translate('page.dd437ec4e4ea')}</p>
          {settings.error !== undefined ? <ErrorNotice error={settings.error} onRefresh={onRefresh} /> : null}
          {settings.rows === null ? (
            <div role="status" data-testid="settings-loading">
              {translate('page.300ee3dee4dc')}
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
                      {setting.runtimeConsumer !== null
                        ? translate('page.dda8021936a5') + ' ' + setting.runtimeConsumer + '\uFF09'
                        : ''}
                    </span>
                  </h5>
                  <p className="field-hint">
                    v{setting.version} · {setting.updatedBy ?? '—'} · <TimeText iso={setting.updatedAt} />
                  </p>
                  <pre data-testid={`setting-value-${setting.key}`}>{JSON.stringify(setting.value, null, 2)}</pre>
                  {readonly ? (
                    <p className="field-hint" data-testid={`setting-readonly-${setting.key}`}>
                      {translate('page.f2b79f39e053')}
                    </p>
                  ) : (
                    <button
                      type="button"
                      data-testid={`setting-edit-${setting.key}`}
                      disabled={!writeSettings || busy}
                      {...(!writeSettings ? { title: translate('page.5a65ed446ce5') } : {})}
                      onClick={() => setSettingEdit({ setting, raw: JSON.stringify(setting.value, null, 2) })}
                    >
                      {translate('page.a7f814c0a40d')}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </section>
      ) : null}

      <Modal
        open={inviteOpen}
        title={translate('page.58e3a8e0bcd4')}
        testid="user-invite-form"
        onClose={() => setInviteOpen(false)}
      >
        <div className="dialog-field">
          <label htmlFor="invite-email">{translate('page.9ed627bcf63d')}</label>
          <input
            id="invite-email"
            data-testid="invite-email"
            value={inviteDraft.email}
            onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })}
          />
        </div>
        <div className="dialog-field">
          <label htmlFor="invite-display-name">{translate('page.c10bbf5ddd2d')}</label>
          <input
            id="invite-display-name"
            data-testid="invite-display-name"
            maxLength={128}
            value={inviteDraft.displayName}
            onChange={(event) => setInviteDraft({ ...inviteDraft, displayName: event.target.value })}
          />
        </div>
        <div className="dialog-field">
          <span id="invite-roles-label">{translate('page.366471e0d0c5')}</span>
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
            <label htmlFor="invite-customer">{translate('page.f0cb172c1c06')}</label>
            <input
              id="invite-customer"
              data-testid="invite-customer"
              value={inviteDraft.customerId}
              onChange={(event) => setInviteDraft({ ...inviteDraft, customerId: event.target.value })}
            />
          </div>
        ) : null}
        <p className="field-hint">{translate('page.2428917b2703')}</p>
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
            {translate('page.ac9575ddbfa8')}
          </button>
        </div>
      </Modal>

      <Modal
        open={assignTarget !== null}
        title={
          assignTarget !== null
            ? translate('page.aabe043f2bda') + assignTarget.user.email
            : translate('page.77afe1b0864d')
        }
        testid="user-roles-form"
        onClose={() => setAssignTarget(null)}
      >
        {assignTarget !== null ? (
          <div>
            <p className="field-hint">{translate('page.3ae0cae155b4')}</p>
            <div role="group" aria-label={translate('page.6b26695e4dce')} data-testid="assign-roles">
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
                {translate('page.2c83f1deab09')}
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
              <label htmlFor="scope-customer">{translate('page.2b5412405821')}</label>
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
                {translate('page.f528cd729593')}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={settingEdit !== null}
        title={
          settingEdit !== null
            ? translate('page.9596698bebd1') + SETTING_KEY_LABELS[settingEdit.setting.key]
            : translate('page.5c87c6154ebd')
        }
        testid="setting-edit-form"
        onClose={() => setSettingEdit(null)}
      >
        {settingEdit !== null ? (
          <div>
            <p className="field-hint">
              {translate('page.0239b8ffa350')}
              {settingEdit.setting.version}
              {translate('page.77df378c18b2')}
              {RUNTIME_STATUS_LABELS[settingEdit.setting.runtimeStatus]}。
            </p>
            <div className="dialog-field">
              <label htmlFor="setting-value-input">{translate('page.9ac6be10cbd4')}</label>
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
                {translate('page.bb79ec7c152f')}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'disable'
            ? translate('page.f7f6a0cc4498') + confirm.user.email
            : confirm?.kind === 'reset'
              ? translate('page.09eec15af8f9') + confirm.user.email
              : confirm?.kind === 'assignRoles'
                ? translate('page.80a86c0a5e78') + confirm.user.email
                : ''
        }
        {...(confirm?.kind === 'disable'
          ? { description: translate('page.1aa8f9fe505f'), danger: true }
          : confirm?.kind === 'reset'
            ? { description: translate('page.ab5cfb10b2d5') }
            : confirm?.kind === 'assignRoles'
              ? {
                  description:
                    translate('page.72081201e4db') + ' ' + confirm.roles.map(roleDisplayName).join('、') + '\u3002',
                  danger: true,
                }
              : {})}
        confirmText={
          confirm?.kind === 'disable'
            ? translate('page.f3abd8941903')
            : confirm?.kind === 'reset'
              ? translate('page.3b82e1c59111')
              : translate('page.3ced65a73925')
        }
        onConfirm={() => void submitConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
