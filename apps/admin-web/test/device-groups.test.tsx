// @vitest-environment jsdom
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError } from '../src/api/errors.js';
import { DeviceGroupsPage, EMPTY_DEVICE_FILTERS } from '../src/pages/devices/DeviceGroupsPage.js';
import type { DeviceGroupsPageProps } from '../src/pages/devices/DeviceGroupsPage.js';
import type { OnboardingReviewPanelProps } from '../src/pages/onboarding/OnboardingReviewPanel.js';
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
    certificate: { certificateId: 'cert-001', fingerprint: 'AB:CD:EF', status: 'ACTIVE' },
    license: { status: 'Active' },
    contract: {
      contractId: 'ct-1',
      contractNumber: 'HT-2026-001',
      name: '年度服务合约',
      status: 'EFFECTIVE',
      endAt: '2027-08-31T16:00:00Z',
    },
    createdAt: '2026-09-01T02:00:00Z',
    updatedAt: '2026-09-05T02:00:00Z',
    ...overrides,
  };
}

const ONBOARDING_STUB: OnboardingReviewPanelProps = {
  activeStatus: 'PENDING',
  onFilterStatus: () => {},
  list: { rows: [], nextCursor: null },
  onLoadMore: () => {},
  onRefresh: () => {},
  detail: { kind: 'none' },
  onSelect: () => {},
  onCloseDetail: () => {},
  canReview: false,
  onApprove: async (r) => r,
  onReject: async (r) => r,
  onNavigate: () => {},
};

function renderPage(overrides: Partial<DeviceGroupsPageProps> = {}) {
  const calls = { applied: [] as DeviceGroupsPageProps['filters'][], navigated: [] as string[] };
  const props: DeviceGroupsPageProps = {
    list: { rows: [makeDevice()], nextCursor: null },
    filters: EMPTY_DEVICE_FILTERS,
    onApplyFilters: (f) => calls.applied.push(f),
    onLoadMore: () => {},
    onRefresh: () => {},
    filterOptions: {
      regions: [{ value: '华东', label: '华东' }],
      subregions: [{ value: '上海', label: '上海', region: '华东' }],
      sites: [{ value: 'site-1', label: '一号站', subregion: '上海' }],
    },
    onNavigate: (path) => calls.navigated.push(path),
    onboarding: ONBOARDING_STUB,
    ...overrides,
  };
  const utils = render(<DeviceGroupsPage {...props} />);
  return { ...calls, unmount: utils.unmount };
}

test('列表字段覆盖矩阵：序号/区域/子区域/ID/别名/合约/租期/固件/四轴/操作', () => {
  renderPage();
  const table = screen.getByRole('table', { name: '设备群列表' });
  for (const header of [
    '序号',
    '设备区域',
    '设备子区域',
    '设备唯一ID',
    '设备别名',
    '关联合约名称',
    '租期期限',
    '软件版本',
    '状态',
    '操作',
  ]) {
    assert.ok(screen.getByRole('columnheader', { name: header }), `缺少列 ${header}`);
  }
  assert.ok(table.textContent?.includes('华东'));
  assert.ok(table.textContent?.includes('上海'));
  assert.ok(table.textContent?.includes('XJ-2026-001'));
  assert.ok(table.textContent?.includes('食堂1号机'));
  assert.ok(table.textContent?.includes('年度服务合约'));
  assert.ok(table.textContent?.includes('至 2027-08-31'));
  assert.ok(table.textContent?.includes('v2.3.1'));
  // 四轴状态徽标（视觉上可区分：每轴独立徽标）
  const badges = table.querySelector('[data-testid="four-axis-badges"]');
  assert.ok(badges?.textContent?.includes('连接：在线'));
  assert.ok(badges?.textContent?.includes('生命周期：已激活'));
  assert.ok(badges?.textContent?.includes('授权：授权有效'));
});

test('缺失值显示“—”（无合约/无别名/无固件/无站点）', () => {
  renderPage({
    list: {
      rows: [makeDevice({ alias: null, firmwareVersion: null, contract: null, site: null, license: null })],
      nextCursor: null,
    },
  });
  const table = screen.getByRole('table', { name: '设备群列表' });
  const dashCount = (table.textContent?.match(/—/g) ?? []).length;
  assert.ok(dashCount >= 4, `应至少 4 处“—”，实际 ${dashCount}`);
});

test('筛选：搜索应用草稿（关键字+四轴+授权），重置清空', async () => {
  const user = userEvent.setup();
  const calls = renderPage();
  await user.type(screen.getByTestId('device-keyword'), 'XJ-2026');
  await user.selectOptions(screen.getByTestId('filter-lifecycle'), 'Active');
  await user.selectOptions(screen.getByTestId('filter-license'), 'Expired');
  await user.click(screen.getByTestId('device-search'));
  assert.equal(calls.applied.length, 1);
  assert.equal(calls.applied[0]?.keyword, 'XJ-2026');
  assert.equal(calls.applied[0]?.lifecycleStatus, 'Active');
  assert.equal(calls.applied[0]?.licenseStatus, 'Expired');

  await user.click(screen.getByTestId('device-reset'));
  assert.deepEqual(calls.applied[1], EMPTY_DEVICE_FILTERS);
});

test('Region/Subregion/Site 联动筛选进入查询条件', async () => {
  const user = userEvent.setup();
  const calls = renderPage();
  await user.selectOptions(screen.getByLabelText('设备区域'), '华东');
  await user.selectOptions(screen.getByLabelText('设备子区域'), '上海');
  await user.selectOptions(screen.getByLabelText('站点'), 'site-1');
  await user.click(screen.getByTestId('device-search'));
  assert.equal(calls.applied[0]?.region, '华东');
  assert.equal(calls.applied[0]?.subregion, '上海');
  assert.equal(calls.applied[0]?.siteId, 'site-1');
});

test('操作列“管理”跳转设备管理详情（状态操作由 FE-07 提供）', async () => {
  const user = userEvent.setup();
  const calls = renderPage();
  await user.click(screen.getByTestId('manage-dev-001'));
  assert.deepEqual(calls.navigated, ['/devices/manage?deviceId=dev-001']);
});

test('嵌入 FE-04 新增设备请求面板；403 显示无权', () => {
  const { unmount } = renderPage();
  assert.ok(screen.getByTestId('onboarding-review'));
  unmount();

  renderPage({ list: { rows: null, error: new ApiClientError(403, 'FORBIDDEN', 'denied', 'r-403') } });
  assert.ok(screen.getByTestId('error-forbidden'));
});
