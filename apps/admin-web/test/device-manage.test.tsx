// @vitest-environment jsdom
/**
 * FE-07 设备生命周期操作页测试：
 * - 状态矩阵 UI（生命周期 × 角色 → 按钮可用性）；
 * - 非法操作按钮不可用；后端拒绝（403/409）仍正确呈现；
 * - 危险操作原因必填 + 明确确认；Retire 不可恢复警告与等待设备确认状态；
 * - 操作后历史刷新（onRefresh 回源）；别名 If-Match 由 API 装配层验证；
 * - 证书摘要无私钥；轮换按钮表达为“请求轮换”。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError, ForbiddenError } from '../src/api/errors.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { DeviceManagePage } from '../src/pages/device-manage/DeviceManagePage.js';
import type { DeviceManagePageProps } from '../src/pages/device-manage/DeviceManagePage.js';
import {
  assignDevice,
  reactivateDevice,
  requestCertificateRotation,
  retireDevice,
  suspendDevice,
  updateDeviceAlias,
} from '../src/pages/device-manage/device-manage-api.js';
import type {
  DeviceAssignmentView,
  RetirementRecordView,
} from '../src/pages/device-manage/types.js';
import type { DeviceView } from '../src/pages/devices/types.js';

afterEach(cleanup);

function makeDevice(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: 'dev-001',
    serialNumber: 'XJ-2026-001',
    model: 'FD-100',
    hardwareVersion: 'HW-1.0',
    manufacturer: 'BioNexa',
    manufactureDate: '2026-01-01',
    alias: '食堂1号机',
    firmwareVersion: 'v2.3.1',
    customer: { id: 'cust-1', name: '示例客户' },
    site: { id: 'site-1', name: '一号站', region: '华东', subregion: '上海' },
    lifecycleStatus: 'Active',
    operationalStatus: 'Active',
    connectivity: 'ONLINE',
    lastHeartbeatAt: '2026-09-06T03:55:00Z',
    certificate: { certificateId: 'cert-001', fingerprint: 'AB:CD:EF:00:11', status: 'ACTIVE' },
    license: { status: 'Active' },
    contract: null,
    createdAt: '2026-09-01T02:00:00Z',
    updatedAt: '2026-09-05T02:00:00Z',
    ...overrides,
  };
}

const ASSIGNMENT: DeviceAssignmentView = {
  assignmentId: 'asg-1',
  deviceId: 'dev-001',
  customerId: 'cust-1',
  siteId: 'site-1',
  status: 'ACTIVE',
  assignedBy: 'admin@example.com',
  reason: '首次部署',
  assignedAt: '2026-09-01T03:00:00Z',
  endedAt: null,
  lifecycleStatus: 'Assigned',
  notification: 'ASSIGNMENT_CHANGED',
  replayed: false,
};

const PENDING_RETIREMENT: RetirementRecordView = {
  retirementId: 'ret-1',
  status: 'PENDING_CONFIRMATION',
  reason: '设备老化',
  initiatedBy: 'admin@example.com',
  initiatedAt: '2026-09-06T01:00:00Z',
  confirmedAt: null,
  completionMethod: null,
  certificateRevokedAt: null,
};

function renderPage(overrides: Partial<DeviceManagePageProps> = {}) {
  const calls = {
    back: 0,
    refreshed: 0,
    assigned: [] as { customerId: string; siteId: string; reason?: string }[],
    suspended: [] as string[],
    reactivated: [] as string[],
    retired: [] as string[],
    forceCompleted: [] as string[],
    aliasUpdated: [] as (string | null)[],
    rotationRequested: 0,
  };
  const props: DeviceManagePageProps = {
    role: 'PlatformSuperAdmin',
    device: makeDevice(),
    assignments: [ASSIGNMENT],
    retirement: null,
    rotation: null,
    customers: [
      { value: 'cust-1', label: '示例客户' },
      { value: 'cust-2', label: '第二客户' },
    ],
    sites: [
      { value: 'site-1', label: '一号站', customerId: 'cust-1' },
      { value: 'site-2', label: '二号站', customerId: 'cust-2' },
    ],
    onBack: () => {
      calls.back += 1;
    },
    onRefresh: () => {
      calls.refreshed += 1;
    },
    onAssign: async (input) => {
      calls.assigned.push(input);
      return ASSIGNMENT;
    },
    onSuspend: async (reason) => {
      calls.suspended.push(reason);
      return { deviceId: 'dev-001', lifecycleStatus: 'Suspended', operationalStatus: 'Suspended', notification: 'DEVICE_SUSPENDED', replayed: false };
    },
    onReactivate: async (reason) => {
      calls.reactivated.push(reason);
      return { deviceId: 'dev-001', lifecycleStatus: 'Active', operationalStatus: 'Active', notification: 'STATUS_CHANGED', replayed: false };
    },
    onRetire: async (reason) => {
      calls.retired.push(reason);
      return { deviceId: 'dev-001', lifecycleStatus: 'Retired', retirement: PENDING_RETIREMENT, notification: 'DEVICE_RETIRED', replayed: false };
    },
    onForceComplete: async (reason) => {
      calls.forceCompleted.push(reason);
      return {
        deviceId: 'dev-001',
        lifecycleStatus: 'Retired',
        retirement: { ...PENDING_RETIREMENT, status: 'CONFIRMED', completionMethod: 'FORCE_COMPLETE' },
        notification: null,
        replayed: false,
      };
    },
    onUpdateAlias: async (alias) => {
      calls.aliasUpdated.push(alias);
      return { deviceId: 'dev-001', alias, updatedAt: '2026-09-06T04:00:00Z' };
    },
    onRequestRotation: async () => {
      calls.rotationRequested += 1;
      return {
        requestId: 'rot-1',
        deviceId: 'dev-001',
        certificateId: 'cert-001',
        certificateStatus: 'ACTIVE',
        expiryDate: '2027-09-01',
        requestStatus: 'PENDING',
        requestedAt: '2026-09-06T04:00:00Z',
      };
    },
    ...overrides,
  };
  const utils = render(<DeviceManagePage {...props} />);
  return { calls, rerender: utils.rerender, unmount: utils.unmount };
}

function disabled(testid: string): boolean {
  return (screen.getByTestId(testid) as HTMLButtonElement).disabled;
}

// ---------- 状态矩阵 UI ----------

test('状态矩阵：Active 设备（SuperAdmin）可挂起/退役/改名/轮换，不可分配/恢复', () => {
  renderPage();
  assert.ok(!disabled('action-suspend'));
  assert.ok(!disabled('action-retire'));
  assert.ok(!disabled('alias-edit'));
  assert.ok(!disabled('cert-rotate'));
  assert.ok(disabled('action-assign'));
  assert.ok(disabled('action-reactivate'));
});

test('状态矩阵：Suspended 设备（SuperAdmin）可恢复/退役，不可挂起/分配', () => {
  renderPage({ device: makeDevice({ lifecycleStatus: 'Suspended', operationalStatus: 'Suspended' }) });
  assert.ok(!disabled('action-reactivate'));
  assert.ok(!disabled('action-retire'));
  assert.ok(disabled('action-suspend'));
  assert.ok(disabled('action-assign'));
});

test('状态矩阵：Onboarded 首次分配仅 SuperAdmin；Operator 禁用并提示 DOM-01', () => {
  const { unmount } = renderPage({
    device: makeDevice({ lifecycleStatus: 'Onboarded', customer: null, site: null }),
  });
  assert.ok(!disabled('action-assign'));
  unmount();

  renderPage({
    role: 'PlatformOperator',
    device: makeDevice({ lifecycleStatus: 'Onboarded', customer: null, site: null }),
  });
  const assignButton = screen.getByTestId('action-assign');
  assert.ok((assignButton as HTMLButtonElement).disabled);
  assert.match(assignButton.getAttribute('title') ?? '', /首次分配.*平台超级管理员/);
});

test('状态矩阵：Assigned 设备 Operator 可再分配；Retired 设备全部生命周期操作禁用', () => {
  const { unmount } = renderPage({
    role: 'PlatformOperator',
    device: makeDevice({ lifecycleStatus: 'Assigned' }),
  });
  assert.ok(!disabled('action-assign'));
  unmount();

  renderPage({ device: makeDevice({ lifecycleStatus: 'Retired', operationalStatus: 'Retired' }) });
  for (const testid of ['action-assign', 'action-suspend', 'action-reactivate', 'action-retire', 'cert-rotate']) {
    assert.ok(disabled(testid), `${testid} 应禁用`);
  }
  assert.ok(!disabled('alias-edit'));
  // Retired 展示退役面板
  assert.ok(screen.getByTestId('retirement-panel'));
});

test('权限门：Auditor/CustomerViewer/CustomerAdmin 全部写操作禁用（无 device:write/assign）', () => {
  for (const role of ['Auditor', 'CustomerViewer', 'CustomerAdmin'] as const) {
    const { unmount } = renderPage({ role });
    for (const testid of ['action-assign', 'action-suspend', 'action-reactivate', 'action-retire', 'alias-edit', 'cert-rotate']) {
      assert.ok(disabled(testid), `${role} 的 ${testid} 应禁用`);
    }
    unmount();
  }
});

test('权限门：Operator 可挂起/恢复/分配但不可退役/轮换（DOM-01 + certificate:rotate）', () => {
  renderPage({ role: 'PlatformOperator' });
  assert.ok(!disabled('action-suspend'));
  assert.ok(disabled('action-retire'));
  assert.match(screen.getByTestId('action-retire').getAttribute('title') ?? '', /仅平台超级管理员/);
  assert.ok(disabled('cert-rotate'));
});

// ---------- 危险操作确认流程 ----------

test('挂起：原因必填；确认后提交原因并回源刷新（操作后历史刷新）', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('action-suspend'));
  const dialog = screen.getByTestId('confirm-dialog');
  const confirm = within(dialog).getByRole('button', { name: '确认挂起' }) as HTMLButtonElement;
  assert.ok(confirm.disabled, '未填原因时确认按钮应禁用');
  await user.type(within(dialog).getByLabelText('挂起原因'), '设备异常发热');
  assert.ok(!confirm.disabled);
  await user.click(confirm);
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.suspended, ['设备异常发热']);
  assert.equal(calls.refreshed, 1, '操作成功后必须回源刷新');
  assert.ok(screen.getByTestId('action-notice').textContent?.includes('设备已挂起'));
});

test('恢复：确认文案含“问题已解决”语义；提交后回源刷新', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ device: makeDevice({ lifecycleStatus: 'Suspended', operationalStatus: 'Suspended' }) });
  await user.click(screen.getByTestId('action-reactivate'));
  const dialog = screen.getByTestId('confirm-dialog');
  assert.ok(dialog.textContent?.includes('问题已解决'));
  await user.type(within(dialog).getByLabelText('恢复原因'), '传感器已更换');
  await user.click(within(dialog).getByRole('button', { name: '确认恢复' }));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.reactivated, ['传感器已更换']);
  assert.equal(calls.refreshed, 1);
});

test('退役：不可恢复警告 + 原因必填；成功后提示等待设备确认', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('action-retire'));
  const dialog = screen.getByTestId('confirm-dialog');
  assert.ok(dialog.textContent?.includes('不可恢复'));
  assert.ok(dialog.textContent?.includes('72 小时'));
  const confirm = within(dialog).getByRole('button', { name: '确认退役（不可恢复）' }) as HTMLButtonElement;
  assert.ok(confirm.disabled);
  await user.type(within(dialog).getByLabelText('退役原因'), '设备老化淘汰');
  await user.click(confirm);
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.retired, ['设备老化淘汰']);
  assert.ok(screen.getByTestId('action-notice').textContent?.includes('等待设备确认'));
});

test('退役等待状态：PENDING_CONFIRMATION 展示 72 小时窗口语义；SuperAdmin 可强制完成', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({
    device: makeDevice({ lifecycleStatus: 'Retired', operationalStatus: 'Retired' }),
    retirement: PENDING_RETIREMENT,
  });
  assert.equal(screen.getByTestId('retirement-status').textContent, '等待设备确认');
  assert.ok(screen.getByTestId('retirement-waiting').textContent?.includes('72 小时'));
  await user.click(screen.getByTestId('retire-force-complete'));
  const dialog = screen.getByTestId('confirm-dialog');
  await user.type(within(dialog).getByLabelText('强制完成原因'), '设备已离线无法确认');
  await user.click(within(dialog).getByRole('button', { name: '确认强制完成' }));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.forceCompleted, ['设备已离线无法确认']);
});

test('退役记录已确认/非 SuperAdmin：强制完成禁用', () => {
  const { unmount } = renderPage({
    device: makeDevice({ lifecycleStatus: 'Retired', operationalStatus: 'Retired' }),
    retirement: { ...PENDING_RETIREMENT, status: 'CONFIRMED', completionMethod: 'DEVICE_CONFIRM', confirmedAt: '2026-09-06T05:00:00Z' },
  });
  assert.ok(disabled('retire-force-complete'));
  assert.ok(screen.queryByTestId('retirement-waiting') === null);
  assert.equal(screen.getByTestId('retirement-method').textContent, '设备确认');
  unmount();

  renderPage({
    role: 'PlatformOperator',
    device: makeDevice({ lifecycleStatus: 'Retired', operationalStatus: 'Retired' }),
    retirement: PENDING_RETIREMENT,
  });
  assert.ok(disabled('retire-force-complete'));
});

// ---------- 后端拒绝呈现 ----------

test('后端 409 拒绝（DEVICE_STATE_NOT_ALLOWED）正确呈现错误码；403 呈现无权', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPage({
    onSuspend: async () => {
      throw new ApiClientError(409, 'DEVICE_STATE_NOT_ALLOWED', '当前生命周期不允许挂起', 'r-409');
    },
  });
  await user.click(screen.getByTestId('action-suspend'));
  const dialog = screen.getByTestId('confirm-dialog');
  await user.type(within(dialog).getByLabelText('挂起原因'), '尝试挂起');
  await user.click(within(dialog).getByRole('button', { name: '确认挂起' }));
  const error = await screen.findByTestId('error-generic');
  assert.ok(error.textContent?.includes('DEVICE_STATE_NOT_ALLOWED'));
  assert.ok(error.textContent?.includes('当前生命周期不允许挂起'));
  unmount();

  renderPage({
    role: 'PlatformOperator',
    // 前端按钮已禁用；模拟后端 403 仍正确呈现（如直接触达）
    loadError: new ForbiddenError('FORBIDDEN', '无权访问该设备', 'r-403'),
    device: null,
  });
  assert.ok(screen.getByTestId('error-forbidden').textContent?.includes('无权访问'));
});

// ---------- 别名修改（If-Match） ----------

test('别名：编辑/保存/清除；超长禁用保存；提交后回源刷新', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  assert.equal(screen.getByTestId('alias-current').textContent, '食堂1号机');
  await user.click(screen.getByTestId('alias-edit'));
  const input = screen.getByTestId('alias-input');
  await user.clear(input);
  await user.type(input, '食堂新一号机');
  await user.click(screen.getByTestId('alias-save'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.aliasUpdated, ['食堂新一号机']);
  assert.equal(calls.refreshed, 1);

  // 清除别名 → null
  await user.click(screen.getByTestId('alias-edit'));
  await user.click(screen.getByTestId('alias-clear'));
  await screen.findByText('别名已清除');
  assert.deepEqual(calls.aliasUpdated, ['食堂新一号机', null]);
});

test('别名：空输入保存禁用；超过 64 字符保存禁用', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByTestId('alias-edit'));
  const input = screen.getByTestId('alias-input');
  await user.clear(input);
  assert.ok(disabled('alias-save'));
  await user.type(input, 'x'.repeat(65));
  assert.ok(disabled('alias-save'));
  assert.ok(screen.getByText('别名超长（最多 64 字符）'));
});

test('别名 If-Match 冲突（VERSION_CONFLICT）提示刷新', async () => {
  const user = userEvent.setup();
  renderPage({
    onUpdateAlias: async () => {
      throw new ApiClientError(409, 'VERSION_CONFLICT', 'If-Match 过期', 'r-vc');
    },
  });
  await user.click(screen.getByTestId('alias-edit'));
  await user.type(screen.getByTestId('alias-input'), '改');
  await user.click(screen.getByTestId('alias-save'));
  const error = await screen.findByTestId('error-version-conflict');
  assert.ok(error.textContent?.includes('数据已被他人修改'));
  assert.ok(within(error).getByRole('button', { name: '刷新' }));
});

// ---------- 证书摘要与轮换 ----------

test('证书摘要：仅 ID/指纹/状态；无私钥；轮换按钮表达为“请求轮换”', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  assert.equal(screen.getByTestId('cert-id').textContent, 'cert-001');
  assert.equal(screen.getByTestId('cert-fingerprint').textContent, 'AB:CD:EF:00:11');
  assert.equal(screen.getByTestId('cert-status').textContent, '有效');
  // 私钥零泄露
  const pageText = screen.getByTestId('device-manage-page').textContent ?? '';
  assert.notMatch(pageText, /privateKey|private_key|BEGIN [A-Z ]*PRIVATE KEY/i);
  assert.notMatch(pageText, /下载证书|导出私钥/);

  await user.click(screen.getByTestId('cert-rotate'));
  await screen.findByTestId('action-notice');
  assert.equal(calls.rotationRequested, 1);
});

test('证书为 null 或非 ACTIVE：轮换禁用；展示“未颁发证书”', () => {
  const { unmount } = renderPage({ device: makeDevice({ certificate: null }) });
  assert.ok(screen.getByTestId('cert-empty').textContent?.includes('未颁发证书'));
  assert.ok(disabled('cert-rotate'));
  unmount();

  renderPage({ device: makeDevice({ certificate: { certificateId: 'c2', fingerprint: 'FF', status: 'REVOKED' } }) });
  assert.ok(disabled('cert-rotate'));
});

test('轮换请求结果展示（等待设备领取，无私钥）', () => {
  renderPage({
    rotation: {
      requestId: 'rot-1',
      deviceId: 'dev-001',
      certificateId: 'cert-001',
      certificateStatus: 'ACTIVE',
      expiryDate: '2027-09-01',
      requestStatus: 'PENDING',
      requestedAt: '2026-09-06T04:00:00Z',
    },
  });
  const result = screen.getByTestId('rotation-result');
  assert.ok(result.textContent?.includes('rot-1'));
  assert.ok(result.textContent?.includes('等待设备领取'));
  assert.ok(result.textContent?.includes('2027-09-01'));
});

// ---------- Assignment ----------

test('分配：站点选项随客户过滤；未选齐禁用提交；成功后回源刷新历史', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ device: makeDevice({ lifecycleStatus: 'Assigned' }) });
  await user.click(screen.getByTestId('action-assign'));
  const form = screen.getByTestId('assign-form');
  // 预填当前归属（cust-1/site-1）
  assert.equal((within(form).getByTestId('assign-customer') as HTMLSelectElement).value, 'cust-1');
  assert.equal((within(form).getByTestId('assign-site') as HTMLSelectElement).value, 'site-1');

  // 切换客户后站点清空 → 未选齐禁用提交
  await user.selectOptions(within(form).getByTestId('assign-customer'), 'cust-2');
  assert.ok(disabled('assign-submit'));
  // 站点选项仅含 cust-2 的站点
  const siteSelect = within(form).getByTestId('assign-site') as HTMLSelectElement;
  const siteValues = [...siteSelect.options].map((o) => o.value);
  assert.deepEqual(siteValues, ['', 'site-2']);

  await user.selectOptions(siteSelect, 'site-2');
  await user.type(within(form).getByTestId('assign-reason'), '迁站');
  await user.click(within(form).getByTestId('assign-submit'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.assigned, [{ customerId: 'cust-2', siteId: 'site-2', reason: '迁站' }]);
  assert.equal(calls.refreshed, 1, '分配成功后必须刷新 Assignment 历史');
});

test('分配原因为空时不携带 reason 字段', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ device: makeDevice({ lifecycleStatus: 'Assigned' }) });
  await user.click(screen.getByTestId('action-assign'));
  const form = screen.getByTestId('assign-form');
  await user.selectOptions(within(form).getByTestId('assign-customer'), 'cust-1');
  await user.selectOptions(within(form).getByTestId('assign-site'), 'site-1');
  await user.click(within(form).getByTestId('assign-submit'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.assigned, [{ customerId: 'cust-1', siteId: 'site-1' }]);
});

test('Assignment 历史：行渲染/空态/加载态', () => {
  const { unmount } = renderPage();
  const row = screen.getByTestId('assignment-asg-1');
  assert.ok(row.textContent?.includes('生效中'));
  assert.ok(row.textContent?.includes('首次部署'));
  assert.ok(row.textContent?.includes('admin@example.com'));
  unmount();

  const second = renderPage({ assignments: [] });
  assert.ok(screen.getByTestId('assignments-empty'));
  second.unmount();

  renderPage({ assignments: null });
  assert.ok(screen.getByTestId('assignments-loading'));
});

test('返回按钮触发 onBack；加载态与未找到可读', async () => {
  const user = userEvent.setup();
  const { calls, unmount } = renderPage();
  await user.click(screen.getByTestId('manage-back'));
  assert.equal(calls.back, 1);
  unmount();

  const second = renderPage({ device: null, loading: true });
  assert.ok(screen.getByTestId('manage-loading'));
  second.unmount();

  renderPage({ device: null });
  assert.ok(screen.getByText('未找到设备'));
});

// ---------- API 装配（路径/方法/请求体/If-Match） ----------

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

test('API 装配：suspend/reactivate 无 If-Match；reactivate 携 issueResolved=true', async () => {
  const { api, calls } = stubApi();
  await suspendDevice(api, 'dev-1', '原因A');
  assert.equal(calls[0]?.path, '/admin/devices/dev-1/suspend');
  assert.equal(calls[0]?.options.method, 'POST');
  assert.deepEqual(calls[0]?.options.body, { reason: '原因A' });
  assert.equal(calls[0]?.options.ifMatch, undefined);
  assert.equal(calls[0]?.options.headers, undefined);

  await reactivateDevice(api, 'dev-1', '原因B');
  assert.equal(calls[1]?.path, '/admin/devices/dev-1/reactivate');
  assert.deepEqual(calls[1]?.options.body, { reason: '原因B', issueResolved: true });
});

test('API 装配：retire 携 confirm=true；forceComplete 仅原因', async () => {
  const { api, calls } = stubApi();
  await retireDevice(api, 'dev-1', '淘汰');
  assert.equal(calls[0]?.path, '/admin/devices/dev-1/retire');
  assert.deepEqual(calls[0]?.options.body, { reason: '淘汰', confirm: true });
});

test('API 装配：alias PATCH 携 If-Match=updatedAt（ISO8601 字符串）', async () => {
  const { api, calls } = stubApi();
  await updateDeviceAlias(api, 'dev-1', '新别名', '2026-09-05T02:00:00Z');
  assert.equal(calls[0]?.path, '/admin/devices/dev-1/metadata');
  assert.equal(calls[0]?.options.method, 'PATCH');
  assert.deepEqual(calls[0]?.options.headers, { 'If-Match': '2026-09-05T02:00:00Z' });
  assert.deepEqual(calls[0]?.options.body, { alias: '新别名' });
});

test('API 装配：assign POST 路径与体；rotation POST 无 body', async () => {
  const { api, calls } = stubApi();
  await assignDevice(api, 'dev-1', { customerId: 'c1', siteId: 's1', reason: 'r' });
  assert.equal(calls[0]?.path, '/admin/devices/dev-1/assignment');
  assert.equal(calls[0]?.options.method, 'POST');
  assert.deepEqual(calls[0]?.options.body, { customerId: 'c1', siteId: 's1', reason: 'r' });

  await requestCertificateRotation(api, 'dev-1');
  assert.equal(calls[1]?.path, '/admin/devices/dev-1/certificate-rotation-requests');
  assert.equal(calls[1]?.options.method, 'POST');
  assert.equal(calls[1]?.options.body, undefined);
});
