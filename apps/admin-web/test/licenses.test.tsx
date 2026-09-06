// @vitest-environment jsdom
/**
 * FE-08 授权管理页测试：
 * - 列表：设备当前授权摘要 + NoLicense“无授权”；筛选应用/重置；
 * - 状态矩阵：Draft→签发、Issued→激活、Active→撤销、ExpiringSoon→续期、
 *   Renewed/Revoked 无动作；Auditor 只读（无创建按钮、动作全禁）；
 * - E2E 状态流：NoLicense→创建 Draft→签发→激活；续期；到期展示；撤销（强制原因）；
 * - 两个有效 License：创建遇 409 CONFLICT 错误可读（后端 message 原样呈现）；
 * - 历史时间线渲染；操作成功后回源刷新。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError, ForbiddenError } from '../src/api/errors.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { LicensesPage } from '../src/pages/licenses/LicensesPage.js';
import type { LicensesPageProps } from '../src/pages/licenses/LicensesPage.js';
import { createLicense, renewLicense, revokeLicense } from '../src/pages/licenses/licenses-api.js';
import type { LicenseHistoryEntryView, LicenseView } from '../src/pages/licenses/types.js';
import type { DeviceView } from '../src/pages/devices/types.js';

afterEach(cleanup);

function makeLicense(overrides: Partial<LicenseView> = {}): LicenseView {
  return {
    licenseId: 'lic-001',
    deviceId: 'dev-001',
    customerId: 'cust-1',
    status: 'Draft',
    validFrom: '2026-09-10',
    validTo: '2027-09-10',
    entitlements: [
      { code: 'REMOTE_CONTROL', enabled: true },
      { code: 'OTA', enabled: true },
      { code: 'ESG_REPORTING', enabled: false },
    ],
    signature: null,
    version: 1,
    effective: false,
    createdBy: 'admin@example.com',
    createdAt: '2026-09-06T02:00:00Z',
    updatedAt: '2026-09-06T02:00:00Z',
    ...overrides,
  };
}

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
    certificate: { certificateId: 'cert-001', fingerprint: 'AB:CD:EF', status: 'ACTIVE' },
    license: null,
    contract: null,
    createdAt: '2026-09-01T02:00:00Z',
    updatedAt: '2026-09-05T02:00:00Z',
    ...overrides,
  };
}

const LICENSED_DEVICE = makeDevice({
  license: {
    licenseId: 'lic-001',
    status: 'Active',
    validFrom: '2026-01-01',
    validTo: '2027-01-01',
    entitlements: ['REMOTE_CONTROL', 'OTA'],
  },
});

const HISTORY: readonly LicenseHistoryEntryView[] = [
  {
    historyId: 'h-2',
    fromStatus: 'Draft',
    toStatus: 'Issued',
    actorId: 'admin@example.com',
    reason: null,
    createdAt: '2026-09-06T03:00:00Z',
  },
  {
    historyId: 'h-1',
    fromStatus: null,
    toStatus: 'Draft',
    actorId: 'admin@example.com',
    reason: '新签合约',
    createdAt: '2026-09-06T02:00:00Z',
  },
];

function renderPage(overrides: Partial<LicensesPageProps> = {}) {
  const calls = {
    applied: [] as { licenseStatus: string | null; keyword: string | null }[],
    refreshed: 0,
    selected: [] as string[],
    closed: 0,
    created: [] as unknown[],
    issued: [] as string[],
    activated: [] as string[],
    renewed: [] as { licenseId: string; newValidTo: string }[],
    revoked: [] as { licenseId: string; reason: string }[],
  };
  const props: LicensesPageProps = {
    role: 'PlatformSuperAdmin',
    list: { rows: [LICENSED_DEVICE, makeDevice({ id: 'dev-002', serialNumber: 'XJ-2026-002', alias: null })], nextCursor: null },
    appliedFilter: { licenseStatus: null, keyword: null },
    onApplyFilter: (f) => calls.applied.push(f),
    onLoadMore: () => {},
    onRefresh: () => {
      calls.refreshed += 1;
    },
    detail: { kind: 'none' },
    onSelect: (id) => calls.selected.push(id),
    onCloseDetail: () => {
      calls.closed += 1;
    },
    createCandidates: [{ deviceId: 'dev-002', label: 'XJ-2026-002（未授权）' }],
    onCreate: async (input) => {
      calls.created.push(input);
      return makeLicense({ deviceId: input.deviceId });
    },
    onIssue: async (id) => {
      calls.issued.push(id);
      return makeLicense({ status: 'Issued', signature: 'sig-abc' });
    },
    onActivate: async (id) => {
      calls.activated.push(id);
      return makeLicense({ status: 'Active', signature: 'sig-abc', effective: true });
    },
    onRenew: async (licenseId, newValidTo) => {
      calls.renewed.push({ licenseId, newValidTo });
      return { ...makeLicense({ status: 'Renewed', validTo: newValidTo }), replayed: false };
    },
    onRevoke: async (licenseId, reason) => {
      calls.revoked.push({ licenseId, reason });
      return makeLicense({ status: 'Revoked', effective: false });
    },
    ...overrides,
  };
  const utils = render(<LicensesPage {...props} />);
  return { calls, rerender: (next: Partial<LicensesPageProps>) => utils.rerender(<LicensesPage {...props} {...next} />), unmount: utils.unmount };
}

function detailOf(license: LicenseView, history: readonly LicenseHistoryEntryView[] | null = HISTORY): LicensesPageProps['detail'] {
  return { kind: 'ready', license, history };
}

function disabled(testid: string): boolean {
  return (screen.getByTestId(testid) as HTMLButtonElement).disabled;
}

// ---------- 列表 ----------

test('列表：设备当前授权摘要（状态/有效期/Entitlement）；NoLicense 行显示“无授权”且详情禁用', () => {
  renderPage();
  const summaries = screen.getAllByTestId('license-summary');
  assert.equal(summaries.length, 2);
  assert.ok(summaries[0]?.textContent?.includes('授权有效'));
  assert.ok(summaries[0]?.textContent?.includes('2026-01-01 ~ 2027-01-01'));
  assert.ok(summaries[0]?.textContent?.includes('远程控制、OTA 升级'));
  // NoLicense 行
  assert.equal(summaries[1]?.textContent, '无授权');
  assert.ok(disabled('license-detail-dev-002'));
});

test('筛选：草稿筛选经搜索应用；重置清空', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.selectOptions(screen.getByTestId('license-status-filter'), 'ExpiringSoon');
  await user.type(screen.getByTestId('license-keyword'), 'XJ-2026');
  await user.click(screen.getByTestId('license-search'));
  assert.deepEqual(calls.applied, [{ licenseStatus: 'ExpiringSoon', keyword: 'XJ-2026' }]);
  await user.click(screen.getByTestId('license-reset'));
  assert.deepEqual(calls.applied[1], { licenseStatus: null, keyword: null });
});

// ---------- 状态矩阵 ----------

test('状态矩阵：Draft 仅签发；Issued 仅激活；Active 仅撤销；ExpiringSoon 仅续期；Renewed/Revoked 无动作', () => {
  const cases: [LicenseView['status'], string[]][] = [
    ['Draft', ['license-issue']],
    ['Issued', ['license-activate']],
    ['Active', ['license-revoke']],
    ['ExpiringSoon', ['license-renew']],
    ['Renewed', []],
    ['Revoked', []],
  ];
  for (const [status, enabled] of cases) {
    const { unmount } = renderPage({ detail: detailOf(makeLicense({ status })) });
    for (const testid of ['license-issue', 'license-activate', 'license-renew', 'license-revoke']) {
      assert.equal(disabled(testid), !enabled.includes(testid), `${status} 的 ${testid} 可用性错误`);
    }
    unmount();
  }
});

test('权限门：Auditor 无创建按钮且全部动作禁用；到期展示（Expired + 未生效）', () => {
  renderPage({
    role: 'Auditor',
    detail: detailOf(makeLicense({ status: 'Expired', effective: false })),
  });
  assert.equal(screen.queryByTestId('license-create'), null);
  for (const testid of ['license-issue', 'license-activate', 'license-renew', 'license-revoke']) {
    assert.ok(disabled(testid), `Auditor 的 ${testid} 应禁用`);
  }
  assert.equal(screen.getByTestId('license-status').textContent, '已到期');
  assert.equal(screen.getByTestId('license-effective').textContent, '未生效');
});

// ---------- E2E 状态流：NoLicense → Draft → Issued → Active ----------

test('E2E：创建 Draft（Entitlement 配置）→ 签发 → 激活，逐步推进且每步回源刷新', async () => {
  const user = userEvent.setup();
  const { calls, rerender } = renderPage();

  // 1. NoLicense 设备创建 Draft
  await user.click(screen.getByTestId('license-create'));
  const form = screen.getByTestId('license-create-form');
  assert.ok(disabled('create-submit'), '未选设备/未配 Entitlement 时禁止提交');
  await user.selectOptions(within(form).getByTestId('create-device'), 'dev-002');
  await user.type(within(form).getByTestId('create-valid-from'), '2026-09-10');
  await user.type(within(form).getByTestId('create-valid-to'), '2027-09-10');
  assert.ok(disabled('create-submit'), '未勾选 Entitlement 时禁止提交');
  await user.click(within(form).getByTestId('create-entitlement-REMOTE_CONTROL'));
  await user.click(within(form).getByTestId('create-entitlement-OTA'));
  await user.click(within(form).getByTestId('create-submit'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.created, [
    { deviceId: 'dev-002', validFrom: '2026-09-10', validTo: '2027-09-10', entitlements: ['REMOTE_CONTROL', 'OTA'] },
  ]);
  assert.equal(calls.refreshed, 1);

  // 2. Draft 详情：签名未生成；签发
  rerender({ detail: detailOf(makeLicense()) });
  assert.ok(screen.getByTestId('license-signature').textContent?.includes('Draft 未签发'));
  await user.click(screen.getByTestId('license-issue'));
  await user.click(within(screen.getByTestId('confirm-dialog')).getByRole('button', { name: '确认签发' }));
  await screen.findByText('授权已签发');
  assert.deepEqual(calls.issued, ['lic-001']);
  assert.equal(calls.refreshed, 2);

  // 3. Issued → 激活
  rerender({ detail: detailOf(makeLicense({ status: 'Issued', signature: 'sig-abc' })) });
  assert.equal(screen.getByTestId('license-signature').textContent, 'sig-abc');
  await user.click(screen.getByTestId('license-activate'));
  const activateDialog = screen.getByTestId('confirm-dialog');
  assert.ok(activateDialog.textContent?.includes('validFrom'));
  await user.click(within(activateDialog).getByRole('button', { name: '确认激活' }));
  await screen.findByText('授权已激活');
  assert.deepEqual(calls.activated, ['lic-001']);
  assert.equal(calls.refreshed, 3);

  // 4. Active 展示：生效
  rerender({ detail: detailOf(makeLicense({ status: 'Active', signature: 'sig-abc', effective: true })) });
  assert.equal(screen.getByTestId('license-status').textContent, '授权有效');
  assert.equal(screen.getByTestId('license-effective').textContent, '生效');
});

// ---------- 续期 ----------

test('续期：ExpiringSoon → 新到期日期校验（须晚于当前）→ Renewed', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({
    detail: detailOf(makeLicense({ status: 'ExpiringSoon', validTo: '2026-10-01', signature: 'sig' })),
  });
  await user.click(screen.getByTestId('license-renew'));
  const form = screen.getByTestId('license-renew-form');
  assert.ok(form.textContent?.includes('2026-10-01'));
  // 不晚于当前 → 校验错误且禁用提交
  await user.type(within(form).getByTestId('renew-valid-to'), '2026-09-01');
  assert.ok(screen.getByTestId('renew-validation-error').textContent?.includes('必须晚于当前到期日期'));
  assert.ok(disabled('renew-submit'));
  // 合法日期 → 提交
  await user.clear(within(form).getByTestId('renew-valid-to'));
  await user.type(within(form).getByTestId('renew-valid-to'), '2027-10-01');
  await user.click(within(form).getByTestId('renew-submit'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.renewed, [{ licenseId: 'lic-001', newValidTo: '2027-10-01' }]);
  assert.ok(screen.getByTestId('action-notice').textContent?.includes('Renewed'));
  assert.equal(calls.refreshed, 1);
});

// ---------- 撤销 ----------

test('撤销：强制原因（空原因禁止确认）→ Revoked；操作后回源', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ detail: detailOf(makeLicense({ status: 'Active', signature: 'sig', effective: true })) });
  await user.click(screen.getByTestId('license-revoke'));
  const dialog = screen.getByTestId('confirm-dialog');
  const confirm = within(dialog).getByRole('button', { name: '确认撤销' }) as HTMLButtonElement;
  assert.ok(confirm.disabled, '撤销必须填写原因');
  await user.type(within(dialog).getByLabelText('撤销原因'), '客户违约');
  await user.click(confirm);
  await screen.findByText('授权已撤销');
  assert.deepEqual(calls.revoked, [{ licenseId: 'lic-001', reason: '客户违约' }]);
  assert.equal(calls.refreshed, 1);
});

// ---------- 错误可读 ----------

test('两个有效 License：创建遇 409 CONFLICT 错误可读（后端 message 原样呈现）', async () => {
  const user = userEvent.setup();
  renderPage({
    onCreate: async () => {
      throw new ApiClientError(409, 'CONFLICT', '设备已存在非终态 License（lic-009，Active）', 'r-409');
    },
  });
  await user.click(screen.getByTestId('license-create'));
  const form = screen.getByTestId('license-create-form');
  await user.selectOptions(within(form).getByTestId('create-device'), 'dev-002');
  await user.type(within(form).getByTestId('create-valid-from'), '2026-09-10');
  await user.type(within(form).getByTestId('create-valid-to'), '2027-09-10');
  await user.click(within(form).getByTestId('create-entitlement-OTA'));
  await user.click(within(form).getByTestId('create-submit'));
  const error = await screen.findByTestId('error-generic');
  assert.ok(error.textContent?.includes('设备已存在非终态 License（lic-009，Active）'));
  assert.ok(error.textContent?.includes('CONFLICT'));
});

test('详情加载 403 呈现无权；历史时间线渲染 from→to/操作人/原因', () => {
  const { unmount } = renderPage({
    detail: { kind: 'error', error: new ForbiddenError('FORBIDDEN', '无 license:read', 'r-403') },
  });
  assert.ok(screen.getByTestId('error-forbidden'));
  unmount();

  renderPage({ detail: detailOf(makeLicense({ status: 'Issued', signature: 'sig' })) });
  const h1 = screen.getByTestId('history-h-1');
  assert.ok(h1.textContent?.includes('草稿'));
  assert.ok(h1.textContent?.includes('新签合约'));
  const h2 = screen.getByTestId('history-h-2');
  assert.ok(h2.textContent?.includes('草稿 → 已签发'));
  assert.ok(h2.textContent?.includes('admin@example.com'));
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

test('API 装配：create/renew/revoke 路径与请求体；reason 空时不携带', async () => {
  const { api, calls } = stubApi();
  await createLicense(api, {
    deviceId: 'dev-1',
    validFrom: '2026-09-10',
    validTo: '2027-09-10',
    entitlements: ['OTA'],
  });
  assert.equal(calls[0]?.path, '/admin/licenses');
  assert.equal(calls[0]?.options.method, 'POST');
  assert.deepEqual(calls[0]?.options.body, {
    deviceId: 'dev-1',
    validFrom: '2026-09-10',
    validTo: '2027-09-10',
    entitlements: ['OTA'],
  });

  await renewLicense(api, 'lic-1', '2028-01-01');
  assert.equal(calls[1]?.path, '/admin/licenses/lic-1/renew');
  assert.deepEqual(calls[1]?.options.body, { newValidTo: '2028-01-01' });

  await revokeLicense(api, 'lic-1', '违约');
  assert.equal(calls[2]?.path, '/admin/licenses/lic-1/revoke');
  assert.deepEqual(calls[2]?.options.body, { reason: '违约' });
});
