// @vitest-environment jsdom
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ForbiddenError } from '../src/api/errors.js';
import { DashboardPage } from '../src/pages/dashboard/DashboardPage.js';
import type { DashboardPageState } from '../src/pages/dashboard/DashboardPage.js';
import {
  consumablesOf,
  licenseDistributionText,
  quickActionsOf,
  signalText,
} from '../src/pages/dashboard/dashboard-state.js';
import type { CommandActionView, DashboardOverviewView, DeviceCardView } from '../src/pages/dashboard/types.js';

afterEach(cleanup);

const ALL_ALLOWED: CommandActionView[] = [
  { command: 'START', allowed: true, denyReason: null },
  { command: 'STOP', allowed: true, denyReason: null },
  { command: 'REBOOT', allowed: true, denyReason: null },
];

function makeCard(index: number, overrides: Partial<DeviceCardView> = {}): DeviceCardView {
  const id = `dev-${String(index).padStart(3, '0')}`;
  return {
    deviceId: id,
    serialNumber: `SN-2026-${String(index).padStart(3, '0')}`,
    alias: index % 2 === 0 ? null : `门店${index}号机`,
    model: 'FD-100',
    lifecycleStatus: 'Active',
    operationalStatus: 'Active',
    connectivity: index % 3 === 0 ? 'OFFLINE' : 'ONLINE',
    licenseStatus: 'Active',
    firmwareVersion: `v2.3.${index}`,
    signalStrength: -60 - index,
    networkType: '4G',
    consumables: [
      { consumableType: 'CARBON_FILTER', remainingPercent: 90 - index, stale: false },
      { consumableType: 'BIO_ADDITIVE', remainingPercent: index === 2 ? null : 50 + index, stale: index === 2 },
    ],
    actions: ALL_ALLOWED,
    ...overrides,
  };
}

function makeOverview(): DashboardOverviewView {
  return {
    generatedAt: '2026-09-06T04:00:00Z',
    contracts: { effectiveTotal: 3 },
    devices: {
      total: 10,
      online: 7,
      onlineRatePct: 70,
      licenseDistribution: { Active: 8, Expired: 1, NONE: 1 },
    },
    esgToday: { summaryDate: '2026-09-06', carbonReductionKg: 238.5, powerConsumptionKwh: 342, feedingWeightKg: 1240 },
    latestAlarms: [
      {
        alarmId: 'alm-1',
        deviceId: 'dev-002',
        customerId: 'cust-1',
        code: 'CONSUMABLE_LOW',
        severity: 'WARNING',
        status: 'ACTIVE',
        detectedTime: '2026-09-06T03:00:00Z',
      },
    ],
    deviceCards: Array.from({ length: 10 }, (_, i) => makeCard(i + 1)),
  };
}

function renderPage(state: DashboardPageState) {
  const submitted: [string, string][] = [];
  const navigated: string[] = [];
  const utils = render(
    <DashboardPage
      state={state}
      onRefresh={() => {}}
      onSubmitCommand={async (deviceId, command) => {
        submitted.push([deviceId, command]);
        return { commandId: 'cmd-1', status: 'AUTHORIZED' };
      }}
      onNavigate={(path) => navigated.push(path)}
    />,
  );
  return { ...utils, submitted, navigated };
}

test('10 设备 Fixture：全部指标与卡片值一致', () => {
  const overview = makeOverview();
  renderPage({ status: 'ready', overview });

  assert.equal(screen.getByTestId('metric-contracts').textContent?.includes('3'), true);
  const devices = screen.getByTestId('metric-devices');
  assert.ok(devices.textContent?.includes('10'));
  assert.ok(devices.textContent?.includes('授权有效 8'));
  assert.ok(devices.textContent?.includes('已到期 1'));
  assert.ok(devices.textContent?.includes('无状态 1'));
  assert.ok(screen.getByTestId('metric-online').textContent?.includes('在线率 70%'));
  assert.ok(screen.getByTestId('metric-carbon').textContent?.includes('238.5 kg'));
  assert.ok(screen.getByTestId('metric-energy').textContent?.includes('342 kWh'));
  assert.ok(screen.getByTestId('metric-feeding').textContent?.includes('1240 kg'));
  // 时间窗口/单位/数据时间可见
  assert.ok(screen.getByTestId('dashboard-baseline').textContent?.includes('2026-09-06'));

  // 10 张卡片，字段与 fixture 一致
  assert.equal(document.querySelectorAll('.device-card').length, 10);
  const card1 = screen.getByTestId('device-card-dev-001');
  assert.ok(card1.textContent?.includes('门店1号机'));
  assert.ok(card1.textContent?.includes('SN-2026-001'));
  assert.ok(card1.textContent?.includes('v2.3.1'));
  assert.ok(card1.textContent?.includes('4G · 信号 -61'));
  assert.equal(within(card1).getByTestId('consumable-value-CARBON_FILTER').textContent, '89%');

  // 无别名卡片回退 SN 显示
  const card4 = screen.getByTestId('device-card-dev-004');
  assert.ok(card4.querySelector('.name')?.textContent?.includes('SN-2026-004'));
});

test('耗材：unknown 显示“—”不画进度条；stale 标记数据过期', () => {
  const overview = makeOverview();
  renderPage({ status: 'ready', overview });
  const card2 = screen.getByTestId('device-card-dev-002');
  // dev-002 的 BIO_ADDITIVE percent=null 且 stale
  const bio = card2.querySelector('[data-testid="consumable-BIO_ADDITIVE"]');
  assert.ok(bio?.textContent?.includes('—'));
  assert.equal(bio?.querySelector('[role="progressbar"]'), null);
  assert.ok(bio?.textContent?.includes('数据过期'));
});

test('denyReason 展示：状态门拒绝的动作禁用且原因可见', () => {
  const overview = makeOverview();
  const denied: CommandActionView[] = [
    { command: 'START', allowed: false, denyReason: 'DEVICE_SUSPENDED_RESTRICTED' },
    { command: 'STOP', allowed: true, denyReason: null },
    { command: 'REBOOT', allowed: false, denyReason: 'FORBIDDEN' },
  ];
  const modified: DashboardOverviewView = {
    ...overview,
    deviceCards: overview.deviceCards.map((card, i) => (i === 2 ? { ...card, actions: denied } : card)),
  };
  renderPage({ status: 'ready', overview: modified });

  const startButton = screen.getByTestId('action-START-dev-003') as HTMLButtonElement;
  assert.ok(startButton.disabled);
  assert.equal(screen.getByTestId('deny-START-dev-003').textContent, '设备已停用（受限）');
  assert.equal(screen.getByTestId('deny-REBOOT-dev-003').textContent, '无操作权限');
  assert.ok(!(screen.getByTestId('action-STOP-dev-003') as HTMLButtonElement).disabled);
});

test('命令提交：确认后调用提交器并显示 Pending（非“成功”）', async () => {
  const user = userEvent.setup();
  const { submitted } = renderPage({ status: 'ready', overview: makeOverview() });

  await user.click(screen.getByTestId('action-START-dev-001'));
  // 确认对话框出现（非原生 confirm）
  const dialog = screen.getByRole('dialog', { name: '确认启动' });
  assert.ok(dialog.textContent?.includes('不代表设备已执行成功'));
  await user.click(screen.getByRole('button', { name: '确认下发' }));

  await waitFor(() => {
    assert.deepEqual(submitted, [['dev-001', 'START']]);
  });
  const result = screen.getByTestId('command-result-dev-001');
  assert.ok(result.textContent?.includes('Pending'));
  assert.ok(!result.textContent?.includes('成功'));
});

test('OTA 升级入口跳转 /ota/campaigns（不直接推送单设备）', async () => {
  const user = userEvent.setup();
  const { navigated } = renderPage({ status: 'ready', overview: makeOverview() });
  await user.click(screen.getByTestId('action-upgrade-dev-001'));
  assert.deepEqual(navigated, ['/ota/campaigns']);
});

test('空数据可读：0 指标与空列表均有明确空态', () => {
  const empty: DashboardOverviewView = {
    generatedAt: '2026-09-06T04:00:00Z',
    contracts: { effectiveTotal: 0 },
    devices: { total: 0, online: 0, onlineRatePct: 0, licenseDistribution: {} },
    esgToday: { summaryDate: '2026-09-06', carbonReductionKg: 0, powerConsumptionKwh: 0, feedingWeightKg: 0 },
    latestAlarms: [],
    deviceCards: [],
  };
  renderPage({ status: 'ready', overview: empty });
  assert.ok(screen.getByTestId('metric-contracts').textContent?.includes('0'));
  assert.ok(screen.getByTestId('metric-devices').textContent?.includes('—'));
  assert.equal(screen.getByTestId('alarms-empty').textContent, '暂无活动告警');
  assert.equal(screen.getByTestId('devices-empty').textContent, '暂无设备');
});

test('加载态与错误态（403 无权）', () => {
  const { unmount } = renderPage({ status: 'loading' });
  assert.equal(screen.getByRole('status').textContent, '加载中…');
  unmount();

  renderPage({ status: 'error', error: new ForbiddenError('FORBIDDEN', 'denied', 'req-1') });
  assert.ok(screen.getByTestId('error-forbidden').textContent?.includes('无权访问'));
});

// ---------- 纯逻辑 ----------

test('quickActionsOf：服务端目录缺失按 UNKNOWN_COMMAND 失败关闭', () => {
  const models = quickActionsOf([{ command: 'START', allowed: true, denyReason: null }]);
  assert.deepEqual(
    models.map((m) => [m.command, m.allowed, m.denyReason]),
    [
      ['START', true, null],
      ['STOP', false, 'UNKNOWN_COMMAND'],
      ['REBOOT', false, 'UNKNOWN_COMMAND'],
    ],
  );
});

test('consumablesOf：固定两类顺序；缺失类型按 unknown；低于阈值 low', () => {
  const models = consumablesOf([{ consumableType: 'BIO_ADDITIVE', remainingPercent: 10, stale: false }]);
  assert.deepEqual(
    models.map((m) => [m.name, m.percent, m.low]),
    [
      ['碳滤网', null, false],
      ['生物添加剂', 10, true],
    ],
  );
});

test('licenseDistributionText / signalText', () => {
  assert.equal(licenseDistributionText({ Active: 2, NONE: 1 }), '授权有效 2 · 无状态 1');
  assert.equal(licenseDistributionText({}), '—');
  assert.equal(signalText('4G', -75), '4G · 信号 -75');
  assert.equal(signalText(null, null), '— · 信号 —');
});
