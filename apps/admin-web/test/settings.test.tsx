// @vitest-environment jsdom
/**
 * FE-16 用户角色和业务设置页测试：
 * - 三标签页按权限可见（SuperAdmin 全部；CustomerAdmin 仅设备用户）；
 * - 平台用户：邀请（无永久密码字段/提交体不含 password）、角色整体替换（高风险确认）、
 *   scope 变更、停用、受控重置（不接触密码）；
 * - RBAC 矩阵只读（复选框 disabled）；DEC-012“设备操作员”显示名；
 * - 自我提权/越权 403 正确呈现；业务设置乐观锁 409 可恢复（刷新）；
 * - 封闭 key 集四项；command.confirmation（DEC-023 固定）只读无编辑入口。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError, ForbiddenError } from '../src/api/errors.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { SettingsPage } from '../src/pages/settings/SettingsPage.js';
import type { SettingsPageProps } from '../src/pages/settings/SettingsPage.js';
import { inviteUser, assignUserRoles } from '../src/pages/settings/users-api.js';
import { updateSetting } from '../src/pages/settings/settings-api.js';
import type { InviteUserInput } from '../src/pages/settings/users-api.js';
import { validateInvite, validateRoleAssign } from '../src/pages/settings/settings-state.js';
import type { SettingView, UserView } from '../src/pages/settings/types.js';
import type { DeviceUsersPageProps } from '../src/pages/device-users/DeviceUsersPage.js';
import { EMPTY_DEVICE_USER_FILTER } from '../src/pages/device-users/DeviceUsersPage.js';

afterEach(cleanup);

function makeUser(overrides: Partial<UserView> = {}): UserView {
  return {
    userId: 'usr-001',
    email: 'ops@example.com',
    displayName: '运维一号',
    status: 'ACTIVE',
    mfaEnabled: true,
    roles: ['PlatformOperator'],
    customerId: null,
    createdAt: '2026-09-01T02:00:00Z',
    updatedAt: '2026-09-05T02:00:00Z',
    ...overrides,
  };
}

function makeSetting(overrides: Partial<SettingView> = {}): SettingView {
  return {
    key: 'alarm.thresholds',
    value: { TEMPERATURE_HIGH: { warning: 60, major: 80 } },
    version: 3,
    updatedBy: 'admin@example.com',
    updatedAt: '2026-09-05T02:00:00Z',
    runtimeStatus: 'ACTIVE',
    runtimeConsumer: 'FE-18',
    ...overrides,
  };
}

const DEVICE_USERS_STUB: DeviceUsersPageProps = {
  role: 'PlatformSuperAdmin',
  customerOptions: [],
  topologyOptions: [],
  list: { rows: [] },
  appliedFilter: EMPTY_DEVICE_USER_FILTER,
  onApplyFilter: () => {},
  onRefresh: () => {},
  detail: { kind: 'none' },
  onSelect: () => {},
  onCloseDetail: () => {},
  assignableDevices: [],
  onCreate: async () => {
    throw new Error('not used');
  },
  onUpdate: async () => {
    throw new Error('not used');
  },
  onDisable: async () => {
    throw new Error('not used');
  },
  onAssign: async () => {
    throw new Error('not used');
  },
  onRevoke: async () => {
    throw new Error('not used');
  },
};

function renderPage(overrides: Partial<SettingsPageProps> = {}) {
  const calls = {
    invited: [] as InviteUserInput[],
    assigned: [] as { userId: string; roles: readonly string[] }[],
    scoped: [] as { userId: string; customerId: string }[],
    disabled: [] as string[],
    reset: [] as string[],
    settingUpdated: [] as { key: string; value: unknown; version: number }[],
    filterApplied: [] as unknown[],
    refreshed: 0,
  };
  const props: SettingsPageProps = {
    role: 'PlatformSuperAdmin',
    users: {
      rows: [
        makeUser(),
        makeUser({ userId: 'usr-002', email: 'viewer@example.com', roles: ['CustomerViewer'], customerId: 'cust-1' }),
      ],
      nextCursor: null,
    },
    userFilter: {},
    onApplyUserFilter: (f) => calls.filterApplied.push(f),
    onLoadMoreUsers: () => {},
    onInviteUser: async (input) => {
      calls.invited.push(input);
      return makeUser({ userId: 'usr-new', email: input.email, status: 'INVITED', roles: input.roles });
    },
    onAssignRoles: async (userId, roles) => {
      calls.assigned.push({ userId, roles });
      return makeUser({ userId, roles });
    },
    onSetScope: async (userId, customerId) => {
      calls.scoped.push({ userId, customerId });
      return makeUser({ userId, customerId });
    },
    onDisableUser: async (userId) => {
      calls.disabled.push(userId);
      return makeUser({ userId, status: 'DISABLED' });
    },
    onResetPassword: async (userId) => {
      calls.reset.push(userId);
      return { userId, status: 'RESET_TRIGGERED' };
    },
    settings: {
      rows: [
        makeSetting(),
        makeSetting({
          key: 'command.confirmation',
          value: { mode: 'confirmText' },
          runtimeStatus: 'ACTIVE',
          runtimeConsumer: 'BE-CMD-01',
        }),
        makeSetting({ key: 'dictionary.displayNames', value: {} }),
        makeSetting({ key: 'notification.business', value: { enabled: true } }),
      ],
    },
    onUpdateSetting: async (key, value, version) => {
      calls.settingUpdated.push({ key, value, version });
      return makeSetting({ key, value, version: version + 1 });
    },
    deviceUsers: DEVICE_USERS_STUB,
    onRefresh: () => {
      calls.refreshed += 1;
    },
    ...overrides,
  };
  const utils = render(<SettingsPage {...props} />);
  return { calls, unmount: utils.unmount };
}

// ---------- 标签页可见性 ----------

test('标签页按权限可见：SuperAdmin 三个；CustomerAdmin 仅设备用户', () => {
  const { unmount } = renderPage();
  assert.ok(screen.getByTestId('tab-platform-users'));
  assert.ok(screen.getByTestId('tab-device-users'));
  assert.ok(screen.getByTestId('tab-business-settings'));
  unmount();

  renderPage({ role: 'CustomerAdmin' });
  assert.equal(screen.queryByTestId('tab-platform-users'), null);
  assert.ok(screen.getByTestId('tab-device-users'));
  assert.equal(screen.queryByTestId('tab-business-settings'), null);
});

test('设备用户标签页嵌入 FE-09 页面（含筛选重置锚点）', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByTestId('tab-device-users'));
  assert.ok(screen.getByTestId('device-users-page'));
  assert.ok(screen.getByTestId('device-user-filter-reset'));
});

// ---------- 平台用户 ----------

test('邀请：表单无永久密码字段；提交体不含 password；提示 Cognito 临时凭证', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('user-invite-open'));
  const form = screen.getByTestId('user-invite-form');
  // 拒绝密码输入（CT-06 Reject：settings.modal.passwordInput）
  assert.equal(form.querySelector('input[type="password"]'), null);

  await user.type(within(form).getByTestId('invite-email'), 'new@example.com');
  await user.type(within(form).getByTestId('invite-display-name'), '新用户');
  await user.click(within(form).getByTestId('invite-role-PlatformOperator'));
  await user.click(within(form).getByTestId('invite-submit'));

  assert.equal(calls.invited.length, 1);
  const body = calls.invited[0] as unknown as Record<string, unknown>;
  assert.equal('password' in body, false);
  assert.deepEqual(body['roles'], ['PlatformOperator']);
  assert.equal('customerId' in body, false);
  const notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('Cognito'));
  assert.ok(notice.textContent?.includes('不接触密码'));
});

test('邀请校验：平台/Customer 混绑拒绝；Customer 角色缺 customerId 拒绝', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByTestId('user-invite-open'));
  const form = screen.getByTestId('user-invite-form');
  await user.type(within(form).getByTestId('invite-email'), 'mix@example.com');
  await user.type(within(form).getByTestId('invite-display-name'), '混绑');
  await user.click(within(form).getByTestId('invite-role-Auditor'));
  await user.click(within(form).getByTestId('invite-role-CustomerViewer'));
  assert.ok(within(form).getByTestId('invite-error').textContent?.includes('禁止混绑'));
  assert.equal((within(form).getByTestId('invite-submit') as HTMLButtonElement).disabled, true);

  // 纯 Customer 角色缺 customerId
  assert.ok(
    validateInvite({ email: 'a@b.co', displayName: 'x', roles: ['CustomerAdmin'], customerId: '' })?.includes(
      'Customer',
    ),
  );
  // 平台角色带 customerId
  assert.ok(
    validateInvite({ email: 'a@b.co', displayName: 'x', roles: ['Auditor'], customerId: 'c1' })?.includes('省略'),
  );
  assert.equal(validateInvite({ email: 'a@b.co', displayName: 'x', roles: ['CustomerAdmin'], customerId: 'c1' }), null);
});

test('角色变更：高风险明确确认后整体替换；混绑禁用提交', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('user-roles-usr-002'));
  const form = screen.getByTestId('user-roles-form');
  // 混绑 → 禁用
  await user.click(within(form).getByTestId('assign-role-Auditor'));
  assert.ok(within(form).getByTestId('assign-error').textContent?.includes('禁止混绑'));
  assert.equal((within(form).getByTestId('assign-submit') as HTMLButtonElement).disabled, true);
  // 取消混绑，换 CustomerAdmin
  await user.click(within(form).getByTestId('assign-role-Auditor'));
  await user.click(within(form).getByTestId('assign-role-CustomerViewer'));
  await user.click(within(form).getByTestId('assign-role-CustomerAdmin'));
  await user.click(within(form).getByTestId('assign-submit'));
  // 明确确认（高风险）
  const dialog = screen.getByTestId('confirm-dialog');
  assert.ok(dialog.textContent?.includes('高风险权限变更'));
  await user.click(within(dialog).getByText('确认变更'));
  assert.deepEqual(calls.assigned, [{ userId: 'usr-002', roles: ['CustomerAdmin'] }]);
});

test('停用与重置：明确确认；重置提示不接触密码', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('user-disable-usr-002'));
  await user.click(within(screen.getByTestId('confirm-dialog')).getByText('确认停用'));
  assert.deepEqual(calls.disabled, ['usr-002']);
  let notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('已停用'));

  await user.click(screen.getByTestId('user-reset-usr-001'));
  await user.click(within(screen.getByTestId('confirm-dialog')).getByText('触发重置'));
  assert.deepEqual(calls.reset, ['usr-001']);
  notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('不接触密码'));
});

test('自我提权/越权：403 经 ErrorNotice 正确呈现', async () => {
  const user = userEvent.setup();
  renderPage({
    onAssignRoles: async () => {
      throw new ForbiddenError('FORBIDDEN', '自我提权被拒绝', 'req-403');
    },
  });
  await user.click(screen.getByTestId('user-roles-usr-001'));
  await user.click(screen.getByTestId('assign-role-PlatformSuperAdmin'));
  await user.click(screen.getByTestId('assign-submit'));
  await user.click(within(screen.getByTestId('confirm-dialog')).getByText('确认变更'));
  const error = await screen.findByTestId('error-forbidden');
  assert.ok(error.textContent?.includes('无权访问'));
});

test('RBAC 矩阵只读：复选框全部 disabled；DEC-012 显示名“设备操作员”（无“运维人员”）', () => {
  renderPage();
  const matrix = screen.getByTestId('rbac-matrix');
  const checkboxes = matrix.querySelectorAll('input[type="checkbox"]');
  assert.ok(checkboxes.length > 0);
  for (const checkbox of checkboxes) {
    assert.equal((checkbox as HTMLInputElement).disabled, true);
  }
  assert.ok(matrix.textContent?.includes('设备操作员'));
  assert.ok(!matrix.textContent?.includes('运维人员'));
  assert.ok(matrix.textContent?.includes('平台管理员'));
});

test('用户列表筛选回调（roleType/status/customerId/q）', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.selectOptions(screen.getByTestId('user-filter-role-type'), 'customer');
  await user.selectOptions(screen.getByTestId('user-filter-status'), 'ACTIVE');
  await user.type(screen.getByTestId('user-filter-customer'), 'cust-1');
  await user.type(screen.getByTestId('user-filter-q'), 'viewer');
  await user.click(screen.getByTestId('user-filter-search'));
  assert.deepEqual(calls.filterApplied, [
    { roleType: 'customer', status: 'ACTIVE', customerId: 'cust-1', q: 'viewer' },
  ]);
});

// ---------- 业务设置 ----------

test('业务设置：封闭 key 集四项渲染；command.confirmation 只读无编辑入口', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByTestId('tab-business-settings'));
  for (const key of ['alarm.thresholds', 'command.confirmation', 'dictionary.displayNames', 'notification.business']) {
    assert.ok(screen.getByTestId(`setting-${key}`), key);
  }
  // DEC-023 固定：只读说明 + 无编辑按钮
  assert.ok(screen.getByTestId('setting-readonly-command.confirmation').textContent?.includes('DEC-023'));
  assert.equal(screen.queryByTestId('setting-edit-command.confirmation'), null);
  // FE-18 已接入 alarm.thresholds；命令确认策略仍按 DEC-023 生效。
  assert.ok(screen.getByTestId('setting-runtime-alarm.thresholds').textContent?.includes('已生效'));
  assert.ok(screen.getByTestId('setting-runtime-command.confirmation').textContent?.includes('已生效'));
});

test('设置编辑：非法 JSON 禁用提交；合法提交携 version 乐观锁', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('tab-business-settings'));
  await user.click(screen.getByTestId('setting-edit-alarm.thresholds'));
  const form = screen.getByTestId('setting-edit-form');
  const input = within(form).getByTestId('setting-value-input');
  await user.clear(input);
  await user.type(input, '{{invalid');
  assert.ok(within(form).getByTestId('setting-value-error').textContent?.includes('合法 JSON'));
  assert.equal((within(form).getByTestId('setting-submit') as HTMLButtonElement).disabled, true);

  await user.clear(input);
  await user.click(input);
  // 经 paste 写入避免特殊字符逐键解析问题
  await user.paste('{"TEMPERATURE_HIGH":{"warning":60,"major":90}}');
  await user.click(within(form).getByTestId('setting-submit'));
  assert.deepEqual(calls.settingUpdated, [
    { key: 'alarm.thresholds', value: { TEMPERATURE_HIGH: { warning: 60, major: 90 } }, version: 3 },
  ]);
  const notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('v4'));
});

test('并发冲突可恢复：409 VERSION_CONFLICT → 提示刷新并回调 onRefresh', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({
    onUpdateSetting: async () => {
      throw new ApiClientError(409, 'VERSION_CONFLICT', 'version mismatch', 'req-409');
    },
  });
  await user.click(screen.getByTestId('tab-business-settings'));
  await user.click(screen.getByTestId('setting-edit-alarm.thresholds'));
  await user.click(screen.getByTestId('setting-submit'));
  const error = await screen.findByTestId('error-version-conflict');
  assert.ok(error.textContent?.includes('数据已被他人修改'));
  await user.click(within(error).getByRole('button', { name: '刷新' }));
  assert.equal(calls.refreshed, 1);
});

// ---------- API 装配 ----------

function stubApi(): { api: ApiClient; calls: { path: string; options: ApiRequestOptions }[] } {
  const calls: { path: string; options: ApiRequestOptions }[] = [];
  const api: ApiClient = {
    request: async <T,>(path: string, options: ApiRequestOptions = {}) => {
      calls.push({ path, options });
      return { data: {}, meta: {} } as T;
    },
  };
  return { api, calls };
}

test('API 装配：invite/assignRoles/updateSetting 路径与体（invite 无 password）', async () => {
  const { api, calls } = stubApi();
  await inviteUser(api, { email: 'a@b.co', displayName: 'x', roles: ['Auditor'] });
  assert.equal(calls[0]?.path, '/admin/users');
  assert.deepEqual(calls[0]?.options.body, { email: 'a@b.co', displayName: 'x', roles: ['Auditor'] });

  await inviteUser(api, { email: 'a@b.co', displayName: 'x', roles: ['CustomerAdmin'], customerId: 'c1' });
  assert.deepEqual(calls[1]?.options.body, {
    email: 'a@b.co',
    displayName: 'x',
    roles: ['CustomerAdmin'],
    customerId: 'c1',
  });

  await assignUserRoles(api, 'usr-1', ['Auditor']);
  assert.equal(calls[2]?.path, '/admin/users/usr-1/roles');
  assert.equal(calls[2]?.options.method, 'PUT');

  await updateSetting(api, 'alarm.thresholds', { tempHigh: 90 }, 3);
  assert.equal(calls[3]?.path, '/admin/settings/alarm.thresholds');
  assert.deepEqual(calls[3]?.options.body, { value: { tempHigh: 90 }, version: 3 });
});

test('角色分配校验边界（1~3、不混绑）', () => {
  assert.ok(validateRoleAssign([])?.includes('1~3'));
  assert.ok(validateRoleAssign(['Auditor', 'CustomerAdmin'])?.includes('禁止混绑'));
  assert.equal(validateRoleAssign(['PlatformSuperAdmin']), null);
  assert.equal(validateRoleAssign(['CustomerAdmin', 'CustomerViewer']), null);
});
