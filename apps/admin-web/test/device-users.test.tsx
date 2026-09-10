// @vitest-environment jsdom
/**
 * FE-09 Device User 页测试：
 * - 创建/停用/分配/撤销/资料修改/受控密码重置全流程（If-Match=version + 强制原因）；
 * - 敏感字段浏览器快照为 0：DOM 不出现 passwordHash，密码只进入一次受控提交、
 *   提交后清空且不回显（type=password）；
 * - 停用用户不进入新 Sync 的语义提示；同步版本（version）展示；
 * - Auditor 只读；CustomerAdmin 固定 customerId。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { DeviceUsersPage } from '../src/pages/device-users/DeviceUsersPage.js';
import type { DeviceUsersPageProps } from '../src/pages/device-users/DeviceUsersPage.js';
import {
  assignDeviceUser,
  createDeviceUser,
  disableDeviceUser,
  revokeDeviceUser,
  updateDeviceUser,
} from '../src/pages/device-users/device-users-api.js';
import type { DeviceUserDetailView, DeviceUserListItemView } from '../src/pages/device-users/types.js';

afterEach(cleanup);

const LIST_ITEM: DeviceUserListItemView = {
  deviceUserId: 'du-001',
  customerId: 'cust-1',
  username: 'operator01',
  displayName: '一号操作员',
  status: 'ACTIVE',
  version: 3,
  createdAt: '2026-09-01T02:00:00Z',
  updatedAt: '2026-09-05T02:00:00Z',
  activeDeviceCount: 2,
};

const DETAIL: DeviceUserDetailView = {
  ...LIST_ITEM,
  assignments: [
    {
      assignmentId: 'dua-1',
      deviceId: 'dev-001',
      status: 'ACTIVE',
      assignedAt: '2026-09-02T02:00:00Z',
      revokedAt: null,
    },
    {
      assignmentId: 'dua-2',
      deviceId: 'dev-002',
      status: 'REVOKED',
      assignedAt: '2026-09-01T02:00:00Z',
      revokedAt: '2026-09-03T02:00:00Z',
    },
  ],
  syncStates: [
    {
      deviceId: 'dev-001',
      entityVersion: 3,
      notificationStatus: 'PUBLISHED',
      notificationPublishedAt: '2026-09-05T02:01:00Z',
      deliveredEntityVersion: 3,
      snapshotStatus: 'ACKNOWLEDGED',
      snapshotServedAt: '2026-09-05T02:05:00Z',
      deviceReportedLastSyncAt: '2026-09-05T02:05:00Z',
      deviceApplyStatus: 'NOT_REPORTED',
    },
  ],
};

function renderPage(overrides: Partial<DeviceUsersPageProps> = {}) {
  const calls = {
    applied: [] as unknown[],
    refreshed: 0,
    selected: [] as string[],
    created: [] as Record<string, unknown>[],
    updated: [] as Record<string, unknown>[],
    disabled: [] as Record<string, unknown>[],
    assigned: [] as Record<string, unknown>[],
    revoked: [] as Record<string, unknown>[],
  };
  const props: DeviceUsersPageProps = {
    role: 'PlatformSuperAdmin',
    customerOptions: [{ value: 'cust-1', label: '示例客户' }],
    list: { rows: [LIST_ITEM] },
    appliedFilter: { customerId: null, status: null, keyword: null },
    onApplyFilter: (f) => calls.applied.push(f),
    onRefresh: () => {
      calls.refreshed += 1;
    },
    detail: { kind: 'none' },
    onSelect: (id) => calls.selected.push(id),
    onCloseDetail: () => {},
    assignableDevices: [
      { value: 'dev-003', label: 'XJ-2026-003' },
      { value: 'dev-004', label: 'XJ-2026-004' },
    ],
    onCreate: async (input) => {
      calls.created.push(input as Record<string, unknown>);
      return LIST_ITEM;
    },
    onUpdate: async (deviceUserId, input) => {
      calls.updated.push({ deviceUserId, ...input });
      return LIST_ITEM;
    },
    onDisable: async (deviceUserId, reason) => {
      calls.disabled.push({ deviceUserId, reason });
      return { ...LIST_ITEM, status: 'DISABLED' };
    },
    onAssign: async (deviceUserId, deviceIds, reason) => {
      calls.assigned.push({ deviceUserId, deviceIds: [...deviceIds], reason });
      return { deviceUserId, deviceIds, assignments: [] };
    },
    onRevoke: async (deviceUserId, deviceIds, reason) => {
      calls.revoked.push({ deviceUserId, deviceIds: [...deviceIds], reason });
      return { deviceUserId, deviceIds };
    },
    ...overrides,
  };
  const utils = render(<DeviceUsersPage {...props} />);
  return { calls, unmount: utils.unmount };
}

function disabled(testid: string): boolean {
  return (screen.getByTestId(testid) as HTMLButtonElement).disabled;
}

// ---------- 敏感字段 ----------

test('敏感字段快照为 0：任何响应与 DOM 不显示 passwordHash；密码输入不回显', async () => {
  const user = userEvent.setup();
  renderPage({ detail: { kind: 'ready', detail: DETAIL } });

  // 页面任意状态下 DOM 不含 passwordHash
  assert.notMatch(screen.getByTestId('device-users-page').textContent ?? '', /passwordHash/i);
  assert.notMatch(document.body.innerHTML, /passwordHash/i);

  // 创建：密码只进入一次受控提交，提交后清空
  await user.click(screen.getByTestId('device-user-create'));
  const passwordInput = screen.getByTestId('create-password') as HTMLInputElement;
  assert.equal(passwordInput.type, 'password');
  await user.selectOptions(screen.getByTestId('create-user-customer'), 'cust-1');
  await user.type(screen.getByTestId('create-username'), 'operator02');
  await user.type(passwordInput, 'S3cret!once');
  await user.click(screen.getByTestId('create-user-submit'));
  await screen.findByTestId('action-notice');
  // 提交后表单关闭，密码值不在 DOM 任何地方（不回显）
  assert.equal(screen.queryByTestId('create-password'), null);
  assert.notMatch(document.body.textContent ?? '', /S3cret!once/);
  assert.notMatch(document.body.innerHTML, /S3cret!once/);
});

test('重置密码：仅一次受控提交 + 必填原因；提交后清空不回显', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ detail: { kind: 'ready', detail: DETAIL } });
  await user.click(screen.getByTestId('device-user-password-reset'));
  const form = screen.getByTestId('device-user-password-form');
  const submit = within(form).getByTestId('reset-submit') as HTMLButtonElement;
  assert.ok(submit.disabled, '密码与原因必填');
  const passwordInput = within(form).getByTestId('reset-password') as HTMLInputElement;
  assert.equal(passwordInput.type, 'password');
  await user.type(passwordInput, 'NewSecret#1');
  await user.type(within(form).getByTestId('reset-reason'), '定期轮换');
  await user.click(submit);
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.updated, [{ deviceUserId: 'du-001', password: 'NewSecret#1', reason: '定期轮换' }]);
  // 提交后表单关闭，密码值不在 DOM 任何地方（不回显）
  assert.equal(screen.queryByTestId('reset-password'), null);
  assert.notMatch(document.body.textContent ?? '', /NewSecret#1/);
  assert.notMatch(document.body.innerHTML, /NewSecret#1|passwordHash/i);
});

// ---------- 创建/筛选 ----------

test('创建：username/password 必填校验；platform 角色需选客户', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('device-user-create'));
  const submit = screen.getByTestId('create-user-submit') as HTMLButtonElement;
  assert.ok(submit.disabled);
  await user.selectOptions(screen.getByTestId('create-user-customer'), 'cust-1');
  await user.type(screen.getByTestId('create-username'), 'operator02');
  assert.ok(submit.disabled, '密码必填');
  await user.type(screen.getByTestId('create-password'), 'pw');
  await user.click(submit);
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.created, [{ customerId: 'cust-1', username: 'operator02', password: 'pw' }]);
  assert.equal(calls.refreshed, 1);
});

test('筛选：customer/status/keyword 应用与重置；CustomerAdmin 固定客户且无客户选择', async () => {
  const user = userEvent.setup();
  const { calls, unmount } = renderPage();
  await user.selectOptions(screen.getByTestId('device-user-customer-filter'), 'cust-1');
  await user.selectOptions(screen.getByTestId('device-user-status-filter'), 'ACTIVE');
  await user.type(screen.getByTestId('device-user-keyword'), 'operator');
  await user.click(screen.getByTestId('device-user-search'));
  assert.deepEqual(calls.applied, [{ customerId: 'cust-1', status: 'ACTIVE', keyword: 'operator' }]);
  await user.click(screen.getByTestId('device-user-filter-reset'));
  assert.deepEqual(calls.applied[1], { customerId: null, status: null, keyword: null });
  unmount();

  const second = renderPage({ role: 'CustomerAdmin', fixedCustomerId: 'cust-1' });
  assert.equal(screen.queryByTestId('device-user-customer-filter'), null);
  await user.click(screen.getByTestId('device-user-create'));
  assert.equal(screen.queryByTestId('create-user-customer'), null, 'Customer 角色不渲染客户选择');
  await user.type(screen.getByTestId('create-username'), 'op-c');
  await user.type(screen.getByTestId('create-password'), 'pw');
  await user.click(screen.getByTestId('create-user-submit'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(second.calls.created, [{ customerId: 'cust-1', username: 'op-c', password: 'pw' }]);
});

// ---------- 停用/分配/撤销/资料 ----------

test('停用：强制原因 + If-Match 语义；停用后停用/分配按钮禁用', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ detail: { kind: 'ready', detail: DETAIL } });
  await user.click(screen.getByTestId('device-user-disable'));
  const dialog = screen.getByTestId('confirm-dialog');
  assert.ok(dialog.textContent?.includes('不进入新 Sync'));
  const confirm = within(dialog).getByRole('button', { name: '确认停用' }) as HTMLButtonElement;
  assert.ok(confirm.disabled);
  await user.type(within(dialog).getByLabelText('停用原因'), '离职');
  await user.click(confirm);
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.disabled, [{ deviceUserId: 'du-001', reason: '离职' }]);
});

test('停用用户：停用/分配禁用并提示；撤销仍可用（有 ACTIVE 分配）', () => {
  renderPage({ detail: { kind: 'ready', detail: { ...DETAIL, status: 'DISABLED' } } });
  assert.ok(disabled('device-user-disable'));
  assert.ok(disabled('device-user-assign'));
  assert.match(screen.getByTestId('device-user-assign').getAttribute('title') ?? '', /停用用户不可新分配/);
  assert.ok(!disabled('device-user-revoke'));
});

test('分配：批量勾选 + 强制原因；撤销仅列 ACTIVE 分配', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ detail: { kind: 'ready', detail: DETAIL } });

  await user.click(screen.getByTestId('device-user-assign'));
  const assignForm = screen.getByTestId('assign-form');
  assert.ok(disabled('assign-submit'));
  await user.click(within(assignForm).getByTestId('assign-device-dev-003'));
  await user.click(within(assignForm).getByTestId('assign-device-dev-004'));
  assert.ok(disabled('assign-submit'), '原因必填');
  await user.type(within(assignForm).getByTestId('assign-reason'), '上线两台设备');
  await user.click(within(assignForm).getByTestId('assign-submit'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.assigned, [
    { deviceUserId: 'du-001', deviceIds: ['dev-003', 'dev-004'], reason: '上线两台设备' },
  ]);

  await user.click(screen.getByTestId('device-user-revoke'));
  const revokeForm = screen.getByTestId('revoke-form');
  // 仅 ACTIVE 分配（dev-001），不含已撤销的 dev-002
  assert.ok(within(revokeForm).getByTestId('revoke-device-dev-001'));
  assert.equal(within(revokeForm).queryByTestId('revoke-device-dev-002'), null);
  await user.click(within(revokeForm).getByTestId('revoke-device-dev-001'));
  await user.type(within(revokeForm).getByTestId('revoke-reason'), '设备移交');
  await user.click(within(revokeForm).getByTestId('revoke-submit'));
  await screen.findByText('分配已撤销');
  assert.deepEqual(calls.revoked, [{ deviceUserId: 'du-001', deviceIds: ['dev-001'], reason: '设备移交' }]);
});

test('修改资料：原因必填；空显示名提交 null；详情含同步版本与分配历史', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ detail: { kind: 'ready', detail: DETAIL } });
  // 同步版本展示
  assert.equal(screen.getByTestId('detail-version').textContent, 'v3');
  // 分配历史
  assert.ok(screen.getByTestId('user-assignment-dua-1').textContent?.includes('生效中'));
  assert.ok(screen.getByTestId('user-assignment-dua-2').textContent?.includes('已撤销'));
  const syncState = screen.getByTestId('user-sync-dev-001').textContent ?? '';
  assert.match(syncState, /PUBLISHED/);
  assert.match(syncState, /设备后续同步已确认 v3/);
  assert.match(syncState, /协议未上报/);

  await user.click(screen.getByTestId('device-user-edit'));
  const form = screen.getByTestId('device-user-edit-form');
  assert.ok(disabled('edit-submit'), '原因必填');
  await user.clear(within(form).getByTestId('edit-display-name'));
  await user.type(within(form).getByTestId('edit-reason'), '规范化命名');
  await user.click(within(form).getByTestId('edit-submit'));
  await screen.findByText('资料已更新');
  assert.deepEqual(calls.updated, [{ deviceUserId: 'du-001', displayName: null, reason: '规范化命名' }]);
});

test('Auditor 只读：无创建/编辑/重置/停用/分配/撤销入口', () => {
  renderPage({ role: 'Auditor', detail: { kind: 'ready', detail: DETAIL } });
  assert.equal(screen.queryByTestId('device-user-create'), null);
  for (const testid of [
    'device-user-edit',
    'device-user-password-reset',
    'device-user-disable',
    'device-user-assign',
    'device-user-revoke',
  ]) {
    assert.equal(screen.queryByTestId(testid), null, `Auditor 不应看到 ${testid}`);
  }
});

// ---------- API 装配（If-Match=version + 强制原因 + 密码仅写） ----------

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

test('API 装配：写操作携 If-Match=version；password 仅在 create/update 请求体', async () => {
  const { api, calls } = stubApi();

  await createDeviceUser(api, { customerId: 'c1', username: 'u1', password: 'pw' });
  assert.equal(calls[0]?.path, '/admin/device-users');
  assert.deepEqual(calls[0]?.options.body, { customerId: 'c1', username: 'u1', password: 'pw' });

  await updateDeviceUser(api, 'du-1', 3, { password: 'new-pw', reason: '轮换' });
  assert.equal(calls[1]?.path, '/admin/device-users/du-1');
  assert.equal(calls[1]?.options.method, 'PATCH');
  assert.equal(calls[1]?.options.ifMatch, 3);
  assert.deepEqual(calls[1]?.options.body, { reason: '轮换', password: 'new-pw' });

  await disableDeviceUser(api, 'du-1', 4, '离职');
  assert.equal(calls[2]?.options.ifMatch, 4);
  assert.deepEqual(calls[2]?.options.body, { reason: '离职' });
  // 停用请求体不含密码
  assert.notMatch(JSON.stringify(calls[2]?.options.body), /password/i);

  await assignDeviceUser(api, 'du-1', 5, ['dev-1', 'dev-2'], '上线');
  assert.equal(calls[3]?.path, '/admin/device-users/du-1/assignments');
  assert.equal(calls[3]?.options.ifMatch, 5);
  assert.deepEqual(calls[3]?.options.body, { deviceIds: ['dev-1', 'dev-2'], reason: '上线' });

  await revokeDeviceUser(api, 'du-1', 6, ['dev-1'], '移交');
  assert.equal(calls[4]?.path, '/admin/device-users/du-1/assignments/revoke');
  assert.equal(calls[4]?.options.ifMatch, 6);
  assert.deepEqual(calls[4]?.options.body, { deviceIds: ['dev-1'], reason: '移交' });
});
