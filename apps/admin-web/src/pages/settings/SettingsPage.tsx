import { Button, Input } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
/** FE-16 平台用户管理：沿用 Cognito 邀请、角色分配、范围、启停和受控密码重置。 */
import { useRef, useState } from 'react';
import { CUSTOMER_ROLES, PLATFORM_DELIVERY_ROLES } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import { PermissionMatrix } from './PermissionMatrix.js';
import type { InviteUserInput, UserListFilter } from './users-api.js';
import {
  USER_STATUS_LABELS,
  USER_STATUS_OPTIONS,
  canManageUsers,
  isPlatformRole,
  roleDisplayName,
  validateInvite,
  validateRoleAssign,
} from './settings-state.js';
import type { InviteDraft } from './settings-state.js';
import type { ListState, PasswordResetResult, UserStatus, UserView } from './types.js';
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
  readonly onEnableUser: (userId: string) => Promise<UserView>;
  readonly onStatusSuccess: (message: string) => void;
  readonly onResetPassword: (userId: string) => Promise<PasswordResetResult>;
  readonly onRefresh: () => void | Promise<void>;
}
type ConfirmTarget =
  | {
      readonly kind: 'disable' | 'enable' | 'reset';
      readonly user: UserView;
    }
  | {
      readonly kind: 'assignRoles';
      readonly user: UserView;
      readonly roles: readonly Role[];
    };
function accountPreview(value: string) {
  const characters = Array.from(value);
  return characters.length > 32 ? <span title={value}>{characters.slice(0, 32).join('')}…</span> : value;
}
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
  onEnableUser,
  onStatusSuccess,
  onResetPassword,
  onRefresh,
}: SettingsPageProps) {
  const [profile, setProfile] = useState<UserView | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>({
    email: '',
    displayName: '',
    roles: [],
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
  const [actionError, setActionError] = useState<unknown>(null);
  const [statusActionFailed, setStatusActionFailed] = useState(false);
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
  const inviteError = validateInvite(inviteDraft);
  const assignOptions = assignTarget?.user.roles.some(isPlatformRole) ? PLATFORM_DELIVERY_ROLES : CUSTOMER_ROLES;
  const assignError = assignTarget === null ? null : validateRoleAssign(assignTarget.roles);
  const assignChanged =
    assignTarget !== null &&
    (assignTarget.roles.length !== assignTarget.user.roles.length ||
      assignTarget.roles.some((candidate) => !assignTarget.user.roles.includes(candidate)));
  const runAction = async (execute: () => Promise<string>, statusChange = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    setStatusActionFailed(false);
    setNotice(null);
    try {
      const message = await execute();
      if (statusChange) {
        onStatusSuccess(message);
        await onRefresh();
      } else {
        setNotice(message);
        void onRefresh();
      }
    } catch (err) {
      setActionError(err);
      if (statusChange) {
        setStatusActionFailed(true);
        await onRefresh();
      }
    } finally {
      setConfirm(null);
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
      };
      const created = await onInviteUser(input);
      setInviteOpen(false);
      setInviteDraft({ email: '', displayName: '', roles: [] });
      return translate('page.c8e407df3590') + created.email + translate('page.9ee547c292e4');
    });
  const submitConfirm = () => {
    if (confirm === null) return;
    const { kind, user } = confirm;
    return runAction(
      async () => {
        switch (kind) {
          case 'disable':
            await onDisableUser(user.userId);
            return translate('settings.account.disabled');
          case 'enable':
            await onEnableUser(user.userId);
            return translate('settings.account.enabled');
          case 'reset':
            await onResetPassword(user.userId);
            return translate('page.801f8e1a70bc') + user.email + translate('page.507c8bd1e8d6');
          case 'assignRoles': {
            const updated = await onAssignRoles(user.userId, confirm.roles);
            setAssignTarget(null);
            return translate('page.fbb8820173df') + updated.roles.map(roleDisplayName).join('、');
          }
        }
      },
      kind === 'disable' || kind === 'enable',
    );
  };
  const submitScope = () =>
    runAction(async () => {
      if (scopeTarget === null) return '';
      await onSetScope(scopeTarget.user.userId, scopeTarget.customerId.trim());
      setScopeTarget(null);
      return translate('page.10981eeb16f3') + ' ' + scopeTarget.customerId.trim();
    });
  return (
    <div className="settings-page" data-testid="settings-page">
      <header className="page-header">
        <h1>{translate('menu.settings')}</h1>
      </header>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null && assignTarget === null ? (
        <>
          <ErrorNotice error={actionError} onRefresh={onRefresh} />
          {statusActionFailed ? <p>{translate('settings.account.retryHint')}</p> : null}
        </>
      ) : null}

      <section data-testid="platform-users-tab" aria-label={translate('menu.settings')}>
        <div className="filter-bar">
          <div className="filter-field">
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
          </div>
          <div className="filter-field">
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
          </div>
          <div className="filter-field">
            <label htmlFor="user-filter-customer">{translate('page.a20148b7e39a')}</label>
            <Input
              id="user-filter-customer"
              data-testid="user-filter-customer"
              value={draftFilter.customerId}
              onChange={(event) => setDraftFilter({ ...draftFilter, customerId: event.target.value })}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="user-filter-q">{translate('page.cc1b21e80080')}</label>
            <Input
              id="user-filter-q"
              data-testid="user-filter-q"
              value={draftFilter.q}
              onChange={(event) => setDraftFilter({ ...draftFilter, q: event.target.value })}
            />
          </div>
          <Button
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
          </Button>
          <Button
            type="button"
            className="primary-button"
            data-testid="user-invite-open"
            disabled={!manageUsers || busy}
            {...(!manageUsers ? { title: translate('page.47ccbd849cdf') } : {})}
            onClick={() => {
              setInviteDraft({ email: '', displayName: '', roles: [] });
              setInviteOpen(true);
            }}
          >
            {translate('page.d3e63cf5b87c')}
          </Button>
        </div>

        <div className="platform-user-list">
          <CursorTable
            keyboardScrollable
            ariaLabel={translate('page.b3d9235f9207')}
            columns={[
              {
                key: 'email',
                header: translate('page.9ed627bcf63d'),
                width: 175,
                render: (u) => accountPreview(u.email),
              },
              {
                key: 'displayName',
                header: translate('page.c10bbf5ddd2d'),
                width: 145,
                render: (u) => accountPreview(u.displayName),
              },
              {
                key: 'roles',
                header: translate('page.6b26695e4dce'),
                width: 140,
                render: (u) => (
                  <ul className="status-tag-list">
                    {u.roles.map((r) => (
                      <li key={r}>
                        <span className="detail-status-badge">{roleDisplayName(r)}</span>
                      </li>
                    ))}
                  </ul>
                ),
              },
              {
                key: 'status',
                header: translate('page.62e951a692ff'),
                width: 82,
                render: (u) => (
                  <span className="detail-status-badge" data-user-status={u.status}>
                    {USER_STATUS_LABELS[u.status]}
                  </span>
                ),
              },
              {
                key: 'mfaEnabled',
                header: 'MFA',
                width: 62,
                render: (u) => (u.mfaEnabled ? translate('page.25d284315063') : translate('page.8bb38ef00ccc')),
              },
              {
                key: 'customerId',
                header: translate('page.467c1137f479'),
                width: 125,
                render: (u) => accountPreview(u.customerId ?? translate('page.79dd9422df51')),
              },
              {
                key: 'updatedAt',
                header: translate('page.093dea88c930'),
                width: 132,
                render: (u) => <TimeText iso={u.updatedAt} />,
              },
              {
                key: 'actions',
                header: translate('page.f3ea6d345e2a'),
                width: 243,
                render: (u) => (
                  <div className="platform-user-actions">
                    <Button type="button" data-testid={`user-profile-${u.userId}`} onClick={() => setProfile(u)}>
                      {translate('detail.user.viewFull')}
                    </Button>
                    <Button
                      type="button"
                      data-testid={`user-roles-${u.userId}`}
                      disabled={!manageUsers || busy || u.status === 'DISABLED'}
                      onClick={() => {
                        setActionError(null);
                        setAssignTarget({ user: u, roles: u.roles });
                      }}
                    >
                      {translate('page.6b26695e4dce')}
                    </Button>
                    {u.roles.every((r) => !isPlatformRole(r)) ? (
                      <Button
                        type="button"
                        data-testid={`user-scope-${u.userId}`}
                        disabled={!manageUsers || busy || u.status === 'DISABLED'}
                        onClick={() => setScopeTarget({ user: u, customerId: u.customerId ?? '' })}
                      >
                        Scope
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      data-testid={`user-reset-${u.userId}`}
                      disabled={!manageUsers || busy || u.status === 'DISABLED'}
                      onClick={() => setConfirm({ kind: 'reset', user: u })}
                    >
                      {translate('page.7e422146dd5b')}
                    </Button>
                    <Button
                      type="button"
                      className={u.status === 'DISABLED' ? undefined : 'danger-button'}
                      data-testid={`user-${u.status === 'DISABLED' ? 'enable' : 'disable'}-${u.userId}`}
                      disabled={!manageUsers || busy || users.loading === true}
                      onClick={() => setConfirm({ kind: u.status === 'DISABLED' ? 'enable' : 'disable', user: u })}
                    >
                      {translate(u.status === 'DISABLED' ? 'settings.account.enable' : 'page.d989e55188c9')}
                    </Button>
                  </div>
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
        </div>

        <PermissionMatrix />

        <Modal
          open={profile !== null}
          title={translate('detail.user.profile')}
          testid="user-profile-dialog"
          onClose={() => setProfile(null)}
        >
          {profile !== null ? (
            <div className="detail-card">
              <dl>
                <dt>{translate('page.9ed627bcf63d')}</dt>
                <dd>{profile.email}</dd>
                <dt>{translate('page.c10bbf5ddd2d')}</dt>
                <dd>{profile.displayName}</dd>
                <dt>{translate('page.467c1137f479')}</dt>
                <dd>{profile.customerId ?? translate('page.79dd9422df51')}</dd>
              </dl>
            </div>
          ) : null}
        </Modal>
      </section>

      <Modal
        open={inviteOpen}
        title={translate('page.58e3a8e0bcd4')}
        testid="user-invite-form"
        onClose={() => setInviteOpen(false)}
      >
        <div className="dialog-field">
          <label htmlFor="invite-email">{translate('page.9ed627bcf63d')}</label>
          <Input
            id="invite-email"
            data-testid="invite-email"
            value={inviteDraft.email}
            onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })}
          />
        </div>
        <div className="dialog-field">
          <label htmlFor="invite-display-name">{translate('page.c10bbf5ddd2d')}</label>
          <Input
            id="invite-display-name"
            data-testid="invite-display-name"
            maxLength={128}
            value={inviteDraft.displayName}
            onChange={(event) => setInviteDraft({ ...inviteDraft, displayName: event.target.value })}
          />
        </div>
        <div className="dialog-field">
          <span id="invite-roles-label">{translate('page.366471e0d0c5')}</span>
          <div
            role="group"
            aria-labelledby="invite-roles-label"
            className="role-option-list"
            data-testid="invite-roles"
          >
            {PLATFORM_DELIVERY_ROLES.map((r) => (
              <label key={r} className="role-option">
                <Input
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
        <p className="field-hint">{translate('page.2428917b2703')}</p>
        {inviteError !== null ? (
          <p className="field-hint" data-testid="invite-error">
            {inviteError}
          </p>
        ) : null}
        <div className="dialog-actions">
          <Button
            type="button"
            className="primary-button"
            data-testid="invite-submit"
            disabled={busy || inviteError !== null}
            onClick={() => void submitInvite()}
          >
            {translate('page.ac9575ddbfa8')}
          </Button>
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
            {actionError !== null ? <ErrorNotice error={actionError} /> : null}
            <p className="field-hint">{translate('settings.roles.confirmHint')}</p>
            {assignTarget.user.roles.includes('Auditor') ? (
              <p className="field-hint">{translate('settings.roles.retainedAuditor')}</p>
            ) : null}
            <div
              role="group"
              aria-label={translate('page.6b26695e4dce')}
              className="role-option-list"
              data-testid="assign-roles"
            >
              {assignOptions.map((r) => (
                <label key={r} className="role-option">
                  <Input
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
            {assignError !== null ? (
              <p className="field-hint" data-testid="assign-error">
                {assignError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Button type="button" onClick={() => setAssignTarget(null)}>
                {translate('common.cancel')}
              </Button>
              <Button
                type="button"
                className="primary-button"
                data-testid="assign-submit"
                disabled={busy || assignError !== null || !assignChanged}
                onClick={() => {
                  const target = assignTarget;
                  setConfirm({ kind: 'assignRoles', user: target.user, roles: target.roles });
                }}
              >
                {translate('page.2c83f1deab09')}
              </Button>
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
              <Input
                id="scope-customer"
                data-testid="scope-customer"
                value={scopeTarget.customerId}
                onChange={(event) => setScopeTarget({ ...scopeTarget, customerId: event.target.value })}
              />
            </div>
            <div className="dialog-actions">
              <Button
                type="button"
                className="primary-button"
                data-testid="scope-submit"
                disabled={busy || scopeTarget.customerId.trim() === ''}
                onClick={() => void submitScope()}
              >
                {translate('page.f528cd729593')}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'disable'
            ? translate('page.f7f6a0cc4498') + confirm.user.email
            : confirm?.kind === 'enable'
              ? translate('settings.account.enableTitle') + ' ' + confirm.user.email
              : confirm?.kind === 'reset'
                ? translate('page.09eec15af8f9') + confirm.user.email
                : confirm?.kind === 'assignRoles'
                  ? translate('page.80a86c0a5e78') + confirm.user.email
                  : ''
        }
        {...(confirm?.kind === 'disable'
          ? { description: translate('page.1aa8f9fe505f'), danger: true }
          : confirm?.kind === 'enable'
            ? { description: translate('settings.account.enableDescription') }
            : confirm?.kind === 'reset'
              ? { description: translate('page.ab5cfb10b2d5') }
              : confirm?.kind === 'assignRoles'
                ? {
                    description: translate('settings.roles.confirmResult', {
                      roles: confirm.roles.map(roleDisplayName).join('、'),
                    }),
                    danger: true,
                  }
                : {})}
        confirmText={
          confirm?.kind === 'disable'
            ? translate('page.f3abd8941903')
            : confirm?.kind === 'enable'
              ? translate('settings.account.confirmEnable')
              : confirm?.kind === 'reset'
                ? translate('page.3b82e1c59111')
                : translate('page.3ced65a73925')
        }
        confirmDisabled={busy}
        onConfirm={() => void submitConfirm()}
        onCancel={() => {
          if (!inFlight.current) setConfirm(null);
        }}
      />
    </div>
  );
}
