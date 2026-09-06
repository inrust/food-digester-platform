// @vitest-environment jsdom
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError } from '../src/api/errors.js';
import { DeviceViewPage } from '../src/pages/devices/DeviceViewPage.js';
import type { DeviceViewPageProps } from '../src/pages/devices/DeviceViewPage.js';
import { SENSOR_METRICS } from '../src/pages/devices/device-state.js';
import type { DeviceConsoleView, DeviceView } from '../src/pages/devices/types.js';

afterEach(cleanup);

const DEVICE: DeviceView = {
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
  license: { status: 'Active' },
  contract: null,
  createdAt: '2026-09-01T02:00:00Z',
  updatedAt: '2026-09-05T02:00:00Z',
};

function makeConsole(deviceId: string, overrides: Partial<DeviceConsoleView> = {}): DeviceConsoleView {
  return {
    generatedAt: '2026-09-06T04:00:00Z',
    device: {
      deviceId,
      serialNumber: `XJ-2026-${deviceId === 'dev-001' ? '001' : '002'}`,
      alias: deviceId === 'dev-001' ? '食堂1号机' : '食堂2号机',
      model: 'FD-100',
      lifecycleStatus: 'Active',
      operationalStatus: 'Active',
      connectivity: 'ONLINE',
      licenseStatus: 'Active',
      firmwareVersion: 'v2.3.1',
    },
    components: {
      observedAt: '2026-09-06T03:50:00Z',
      stale: false,
      status: { overall: 'NORMAL', temperature: 'NORMAL', humidity: 'WARNING', weight: null, gas: 'NORMAL' },
    },
    metrics: {
      observedAt: '2026-09-06T03:00:00Z',
      stale: false,
      metrics: {
        powerConsumptionKw: { avg: 0.342, min: 0.3, max: 0.4, unit: 'kW' },
        humidityPct: { avg: 68, min: 60, max: 75, unit: '%' },
        chamberWeightKg: { avg: 12.4, min: 10, max: 15, unit: 'kg' },
      },
    },
    network: {
      observedAt: '2026-09-06T03:50:00Z',
      stale: false,
      signalStrength: -75,
      networkType: '4G',
      networkStatus: 'CONNECTED',
    },
    consumables: [
      { consumableType: 'CARBON_FILTER', remainingPercent: 78, stale: false, observedAt: '2026-09-06T03:00:00Z' },
    ],
    recentAlarms: [
      {
        alarmId: 'a-1',
        code: 'TEMP_SENSOR_FAULT',
        severity: 'MAJOR',
        status: 'CLEARED',
        detectedTime: '2026-08-02T15:40:00Z',
      },
    ],
    contract: {
      contractId: 'ct-1',
      contractNumber: 'HT-2026-001',
      name: '年度服务合约',
      status: 'EFFECTIVE',
      endAt: '2027-08-31T16:00:00Z',
    },
    esgLast7Days: [
      { summaryDate: '2026-09-05', carbonReductionKg: 23.8, powerConsumptionKwh: 34.2, feedingWeightKg: 124 },
      { summaryDate: '2026-09-06', carbonReductionKg: null, powerConsumptionKwh: null, feedingWeightKg: null },
    ],
    latestMedia: { mediaId: 'm-1', mediaType: 'IMAGE', captureTime: '2026-09-06T01:00:00Z' },
    ...overrides,
  };
}

const FILTER_OPTIONS = {
  regions: [{ value: '华东', label: '华东' }],
  subregions: [{ value: '上海', label: '上海', region: '华东' }],
  sites: [{ value: 'site-1', label: '一号站', subregion: '上海' }],
  devices: [
    { value: 'dev-001', label: '食堂1号机', siteId: 'site-1' },
    { value: 'dev-002', label: '食堂2号机', siteId: 'site-1' },
  ],
};

function renderPage(overrides: Partial<DeviceViewPageProps> = {}) {
  const calls = { applied: [] as string[], refreshed: 0 };
  const props: DeviceViewPageProps = {
    device: DEVICE,
    consoleState: { status: 'ready', console: makeConsole('dev-001') },
    filterOptions: FILTER_OPTIONS,
    onApply: (id) => calls.applied.push(id),
    onRefreshConsole: () => {
      calls.refreshed += 1;
    },
    ...overrides,
  };
  const utils = render(<DeviceViewPage {...props} />);
  return { calls, rerender: utils.rerender, unmount: utils.unmount };
}

test('选择设备并应用：四级联动；未选设备禁用应用', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ consoleState: { status: 'idle' } });
  assert.ok((screen.getByTestId('view-apply') as HTMLButtonElement).disabled);
  await user.selectOptions(screen.getByLabelText('设备区域'), '华东');
  await user.selectOptions(screen.getByLabelText('设备子区域'), '上海');
  await user.selectOptions(screen.getByLabelText('站点'), 'site-1');
  await user.selectOptions(screen.getByLabelText('设备'), 'dev-001');
  await user.click(screen.getByTestId('view-apply'));
  assert.deepEqual(calls.applied, ['dev-001']);
});

test('控制台六区块 + 静态信息 + 合约；单位/observedAt/stale 可见', () => {
  renderPage();
  // 10 类传感器槽位全部渲染（值缺失为 —）
  assert.equal(SENSOR_METRICS.length, 10);
  for (const { key } of SENSOR_METRICS) {
    assert.ok(screen.getByTestId(`sensor-${key}`), `缺少传感器槽位 ${key}`);
  }
  assert.ok(screen.getByTestId('sensor-powerConsumptionKw').textContent?.includes('0.342 kW'));
  assert.ok(screen.getByTestId('sensor-humidityPct').textContent?.includes('68 %'));
  assert.ok(screen.getByTestId('sensor-co2Ppm').textContent?.includes('—'));

  // 部件状态：WARNING 可见、null → —
  assert.ok(screen.getByTestId('component-humidity').textContent?.includes('警告'));
  assert.ok(screen.getByTestId('component-weight').textContent?.includes('—'));

  // observedAt 可见
  assert.ok(screen.getByTestId('console-sensors').textContent?.includes('观测时间'));

  // 网络/耗材/告警/ESG/静态/合约/媒体
  assert.ok(screen.getByTestId('network-summary').textContent?.includes('4G'));
  assert.ok(screen.getByTestId('console-consumables').textContent?.includes('78%'));
  assert.ok(screen.getByTestId('alarm-a-1').textContent?.includes('已恢复'));
  assert.ok(screen.getByTestId('esg-2026-09-06').textContent?.includes('—'));
  assert.ok(screen.getByTestId('console-static').textContent?.includes('BioNexa'));
  assert.ok(screen.getByTestId('contract-brief').textContent?.includes('年度服务合约'));
  assert.ok(screen.getByTestId('media-latest').textContent?.includes('IMAGE'));
});

test('stale 标记明确；observedAt=null 显示“无观测数据”', () => {
  const consoleView = makeConsole('dev-001');
  renderPage({
    consoleState: {
      status: 'ready',
      console: { ...consoleView, metrics: { ...consoleView.metrics, stale: true, observedAt: null } },
    },
  });
  const sensors = screen.getByTestId('console-sensors');
  assert.ok(sensors.textContent?.includes('数据过期'));
  assert.ok(sensors.textContent?.includes('无观测数据'));
});

test('媒体区：手动刷新语义；无播放按钮；不出现“实时”字样', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  const media = screen.getByTestId('console-media');
  assert.ok(media.textContent?.includes('非实时画面'));
  assert.equal(within(media).queryByRole('button', { name: /播放|停止/ }), null);
  // 不得出现“实时画面”字样（“非实时画面”除外）
  assert.notMatch(media.textContent ?? '', /(?<!非)实时画面/);
  await user.click(screen.getByTestId('media-refresh'));
  assert.equal(calls.refreshed, 1);
});

test('不同设备切换无数据残留：内容容器按 deviceId 重建', () => {
  const { calls, rerender } = renderPage();
  assert.ok(screen.getByTestId('device-console').textContent?.includes('食堂1号机'));
  const props: DeviceViewPageProps = {
    device: { ...DEVICE, id: 'dev-002', alias: '食堂2号机', serialNumber: 'XJ-2026-002' },
    consoleState: { status: 'ready', console: makeConsole('dev-002') },
    filterOptions: FILTER_OPTIONS,
    onApply: (id) => calls.applied.push(id),
    onRefreshConsole: () => {},
  };
  rerender(<DeviceViewPage {...props} />);
  const consoleEl = screen.getByTestId('device-console');
  assert.ok(consoleEl.textContent?.includes('食堂2号机'));
  assert.ok(!consoleEl.textContent?.includes('食堂1号机'));
});

test('403 无权设备返回明确状态；加载与空选择可读', () => {
  const { unmount } = renderPage({
    consoleState: { status: 'error', error: new ApiClientError(403, 'FORBIDDEN', '无权访问该设备', 'r-403') },
  });
  assert.ok(screen.getByTestId('error-forbidden').textContent?.includes('无权访问'));
  unmount();

  renderPage({ consoleState: { status: 'idle' } });
  assert.ok(screen.getByText('请选择设备后点击“应用”'));
});
