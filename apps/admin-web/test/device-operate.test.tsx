// @vitest-environment jsdom
/**
 * FE-12 操作设备页测试：
 * - 22 个命令白名单与原型 8 个快捷动作映射正确（文案可追溯到 command code）；
 * - 不存在无协议 command code 的提交（组按钮必须选定真实命令；未知 code 抛错）；
 * - DEC-023 高风险命令 confirmText 完全一致才能提交，客户端不提交确认时间；
 * - DEC-018 排除 M/N；温度阈值走 Configuration（不误走命令 API）；
 * - requestedBy 不可编辑；Suspended/Retired/离线/无 Entitlement 禁用且原因展示；
 * - 状态从创建（AUTHORIZED 受理）到最终结果 E2E；TimedOut + 迟到 ACK；
 * - 媒体面板仅最新 Media + 手动刷新（无播放/停止）；活动日志筛选/导出。
 */
import { afterEach, assert, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { DeviceOperatePage } from '../src/pages/device-operate/DeviceOperatePage.js';
import type { DeviceOperatePageProps } from '../src/pages/device-operate/DeviceOperatePage.js';
import { createDeviceCommand, fetchCommands } from '../src/pages/device-operate/commands-api.js';
import type { CommandCreateInput } from '../src/pages/device-operate/commands-api.js';
import {
  COMMAND_CATALOG,
  COMMAND_LABELS,
  COMMAND_STATUS_LABELS,
  QUICK_ACTIONS,
  SUBMITTABLE_COMMAND_CATALOG,
  commandSpecOf,
} from '../src/pages/device-operate/command-state.js';
import type { CommandDetailView, CommandListItemView, CommandName } from '../src/pages/device-operate/types.js';
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
    license: {
      licenseId: 'lic-001',
      status: 'Active',
      validFrom: '2026-01-01',
      validTo: '2027-01-01',
      entitlements: ['REMOTE_CONTROL'],
    },
    contract: null,
    createdAt: '2026-09-01T02:00:00Z',
    updatedAt: '2026-09-05T02:00:00Z',
    ...overrides,
  };
}

function makeListItem(overrides: Partial<CommandListItemView> = {}): CommandListItemView {
  return {
    commandId: 'cmd-001',
    deviceId: 'dev-001',
    customerId: 'cust-1',
    command: 'REBOOT',
    category: 'DEVICE',
    highRisk: false,
    status: 'AUTHORIZED',
    requestedBy: 'admin@example.com',
    requestTime: '2026-09-06T04:00:00Z',
    timeoutSec: 300,
    expiresAt: '2026-09-06T04:05:00Z',
    createdAt: '2026-09-06T04:00:00Z',
    updatedAt: '2026-09-06T04:00:00Z',
    ...overrides,
  };
}

function renderPage(overrides: Partial<DeviceOperatePageProps> = {}) {
  const calls = {
    submitted: [] as { deviceId: string; input: CommandCreateInput }[],
    navigated: [] as string[],
    refreshed: 0,
    selectedCommand: [] as string[],
    activityFilterApplied: [] as unknown[],
    activityExported: [] as unknown[],
    mediaRefreshed: 0,
    deviceSelected: [] as (string | null)[],
  };
  const props: DeviceOperatePageProps = {
    role: 'PlatformSuperAdmin',
    scopeOptions: {
      regions: [{ value: '华东', label: '华东' }],
      subregions: [{ value: '上海', label: '上海', region: '华东' }],
      sites: [{ value: 'site-1', label: '一号站', subregion: '上海' }],
      devices: [{ value: 'dev-001', label: 'XJ-2026-001 食堂1号机', siteId: 'site-1' }],
    },
    selectedDeviceId: 'dev-001',
    onSelectDevice: (id) => calls.deviceSelected.push(id),
    selectedDevice: makeDevice(),
    onSubmitCommand: async (deviceId, input) => {
      calls.submitted.push({ deviceId, input });
      return { commandId: 'cmd-new-1', status: 'AUTHORIZED', replayed: false, requestedBy: 'admin@example.com' };
    },
    commands: { rows: [makeListItem()], nextCursor: null },
    commandFilter: {},
    onApplyCommandFilter: () => {},
    onLoadMoreCommands: () => {},
    commandDetail: { kind: 'none' },
    onSelectCommand: (id) => calls.selectedCommand.push(id),
    onCloseCommandDetail: () => {},
    activities: {
      rows: [
        {
          activityId: 'act-1',
          kind: 'ALARM',
          level: 'CRITICAL',
          occurredAt: '2026-09-06T03:00:00Z',
          summary: 'TEMP_HIGH',
          detail: { code: 'TEMP_HIGH', severity: 'CRITICAL' },
        },
      ],
      nextCursor: null,
    },
    activityFilter: {},
    onApplyActivityFilter: (f) => calls.activityFilterApplied.push(f),
    onLoadMoreActivities: () => {},
    activityExport: null,
    onExportActivities: async (f) => {
      calls.activityExported.push(f);
    },
    onCheckActivityExport: () => {},
    latestMedia: { mediaId: 'media-1', mediaType: 'IMAGE', captureTime: '2026-09-06T03:50:00Z' },
    onRefreshMedia: () => {
      calls.mediaRefreshed += 1;
    },
    onNavigate: (path) => calls.navigated.push(path),
    onRefresh: () => {
      calls.refreshed += 1;
    },
    ...overrides,
  };
  const utils = render(<DeviceOperatePage {...props} />);
  return {
    calls,
    rerender: (next: Partial<DeviceOperatePageProps>) => utils.rerender(<DeviceOperatePage {...props} {...next} />),
    unmount: utils.unmount,
  };
}

// ---------- 22 命令与 8 快捷动作映射 ----------

test('命令目录：22 个命令且每个有中文名；快捷动作 8 个且映射到目录内 code', () => {
  assert.equal(COMMAND_CATALOG.length, 22);
  for (const spec of COMMAND_CATALOG) {
    assert.ok(COMMAND_LABELS[spec.command] !== undefined, `${spec.command} 缺少中文名`);
  }
  assert.equal(QUICK_ACTIONS.length, 8);
  const expected: Record<string, CommandName | readonly CommandName[]> = {
    agitatorForward: 'AGITATOR_FORWARD',
    agitatorReverse: 'AGITATOR_REVERSE',
    heating: ['HEATING_ON', 'HEATING_OFF'],
    exhaust: ['EXHAUST_ON', 'EXHAUST_OFF'],
    reboot: 'REBOOT',
    shutdown: 'SHUTDOWN',
    modeSwitch: ['START', 'STOP', 'PAUSE', 'RESUME', 'EMERGENCY_STOP'],
    factoryReset: 'FACTORY_RESET',
  };
  for (const action of QUICK_ACTIONS) {
    const mapped = expected[action.key];
    assert.ok(mapped !== undefined, `未知快捷动作 ${action.key}`);
    if (action.command !== undefined) {
      assert.equal(action.command, mapped);
      assert.ok(
        COMMAND_CATALOG.some((c) => c.command === action.command),
        `${action.command} 不在目录`,
      );
    } else {
      assert.deepEqual(action.commandGroup, mapped);
      for (const code of action.commandGroup ?? []) {
        assert.ok(
          COMMAND_CATALOG.some((c) => c.command === code),
          `${code} 不在目录`,
        );
      }
    }
  }
});

test('PUBLISH_FAILED 可筛选展示；温度命令仅保留协议 parity、不可由后台提交', async () => {
  assert.equal(COMMAND_STATUS_LABELS.PUBLISH_FAILED, '发布失败');
  assert.ok(COMMAND_CATALOG.some((item) => item.command === 'SET_TARGET_TEMPERATURE'));
  assert.ok(!SUBMITTABLE_COMMAND_CATALOG.some((item) => item.command === 'SET_TARGET_TEMPERATURE'));
  renderPage({ commands: { rows: [makeListItem({ status: 'PUBLISH_FAILED' })], nextCursor: null } });
  assert.ok(screen.getAllByText('发布失败').length > 0);

  const { api, calls } = stubApi();
  await expect(
    createDeviceCommand(api, 'dev-1', { command: 'SET_TARGET_TEMPERATURE', timeoutSec: 300 }),
  ).rejects.toThrow(/Configuration/);
  assert.equal(calls.length, 0);
});

test('无协议 command code 禁止提交：未知 code 抛错；模式切换表单只能选组内真实命令', async () => {
  assert.throws(() => commandSpecOf('MODE_SWITCH' as CommandName), /无协议 command code/);
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByTestId('quick-modeSwitch'));
  const form = screen.getByTestId('command-form');
  const select = within(form).getByTestId('command-select') as HTMLSelectElement;
  const options = [...select.options].map((o) => o.value);
  // 组内只有 MACHINE 类真实命令，没有 MODE_SWITCH 伪 code
  assert.deepEqual(options, ['START', 'STOP', 'PAUSE', 'RESUME', 'EMERGENCY_STOP']);
  assert.ok(!options.includes('MODE_SWITCH'));
});

// ---------- 高风险确认 ----------

test('高风险命令：confirmText 必须与命令名完全一致；客户端不提交确认时间', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('quick-factoryReset'));
  const form = screen.getByTestId('command-form');
  assert.ok((within(form).getByTestId('command-submit') as HTMLButtonElement).disabled, '未确认不得提交');
  const confirmInput = within(form).getByTestId('command-confirm-text');
  await user.type(confirmInput, 'factory_reset');
  assert.ok((within(form).getByTestId('command-submit') as HTMLButtonElement).disabled, '不一致不得提交');
  await user.clear(confirmInput);
  await user.type(confirmInput, 'FACTORY_RESET');
  assert.ok(!(within(form).getByTestId('command-submit') as HTMLButtonElement).disabled);
  await user.click(within(form).getByTestId('command-submit'));
  await screen.findByTestId('action-notice');
  assert.equal(calls.submitted.length, 1);
  const input = calls.submitted[0]?.input;
  assert.equal(input?.command, 'FACTORY_RESET');
  assert.equal(input?.confirmation?.confirmText, 'FACTORY_RESET');
  assert.deepEqual(Object.keys(input?.confirmation ?? {}), ['confirmText']);
});

test('低风险命令无需确认凭证；timeoutSec 越界禁止提交', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('quick-reboot'));
  const form = screen.getByTestId('command-form');
  assert.equal(within(form).queryByTestId('command-confirm-text'), null, 'REBOOT 非高风险');
  // timeoutSec 越界
  await user.clear(within(form).getByTestId('command-timeout'));
  await user.type(within(form).getByTestId('command-timeout'), '5000');
  assert.ok(within(form).getByTestId('command-timeout-error'));
  assert.ok((within(form).getByTestId('command-submit') as HTMLButtonElement).disabled);
  await user.clear(within(form).getByTestId('command-timeout'));
  await user.type(within(form).getByTestId('command-timeout'), '120');
  await user.type(within(form).getByTestId('command-remarks'), '现场重启');
  await user.click(within(form).getByTestId('command-submit'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.submitted[0]?.input, { command: 'REBOOT', timeoutSec: 120, remarks: '现场重启' });
});

// ---------- 配置更新不走命令 API ----------

test('DEC-018 排除 M/N 入口；温度阈值跳转 Configuration 且不产生命令提交', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  assert.equal(screen.queryByTestId('goto-config-strategy'), null);
  assert.notMatch(screen.getByTestId('device-operate-page').textContent ?? '', /更新策略|M\/N/);
  await user.click(screen.getByTestId('goto-config-threshold'));
  assert.deepEqual(calls.navigated, ['/configurations']);
  assert.equal(calls.submitted.length, 0, '配置更新不得走命令 API');
});

// ---------- 门控 ----------

test('门控：Suspended/Retired/离线/无 Entitlement/无 command:send 均禁用且原因展示', () => {
  const cases: [string, Partial<DeviceView>, DeviceOperatePageProps['role'], RegExp][] = [
    ['Suspended 状态拒绝启动类命令', { operationalStatus: 'Suspended' }, 'PlatformSuperAdmin', /当前运行状态/],
    [
      'Retired 拒绝全部命令',
      { lifecycleStatus: 'Retired', operationalStatus: 'Retired' },
      'PlatformSuperAdmin',
      /已退役/,
    ],
    ['离线禁止下发', { connectivity: 'OFFLINE' }, 'PlatformSuperAdmin', /离线/],
    [
      '无 REMOTE_CONTROL 禁止',
      {
        license: {
          licenseId: 'l',
          status: 'Active',
          validFrom: '2026-01-01',
          validTo: '2027-01-01',
          entitlements: ['OTA'],
        },
      },
      'PlatformSuperAdmin',
      /REMOTE_CONTROL/,
    ],
    ['无 command:send 禁止', {}, 'Auditor', /command:send/],
  ];
  for (const [name, deviceOverrides, role, pattern] of cases) {
    const { unmount } = renderPage({ role, selectedDevice: makeDevice(deviceOverrides) });
    const button = screen.getByTestId('quick-agitatorForward') as HTMLButtonElement;
    assert.ok(button.disabled, `${name}：按钮应禁用`);
    assert.match(screen.getByTestId('quick-deny-agitatorForward').textContent ?? '', pattern, name);
    unmount();
  }
});

test('Suspended 设备仍允许安全停止类命令（STOP/REBOOT 等 catalog allowedStatuses）', () => {
  renderPage({ selectedDevice: makeDevice({ operationalStatus: 'Suspended' }) });
  assert.ok((screen.getByTestId('quick-reboot') as HTMLButtonElement).disabled === false, 'REBOOT 在 Suspended 允许');
  assert.ok(
    (screen.getByTestId('quick-shutdown') as HTMLButtonElement).disabled === false,
    'SHUTDOWN 在 Suspended 允许',
  );
  assert.ok((screen.getByTestId('quick-agitatorForward') as HTMLButtonElement).disabled, '搅拌在 Suspended 拒绝');
});

// ---------- 状态 E2E 与迟到 ACK ----------

test('状态 E2E：提交受理（AUTHORIZED，requestedBy 身份上下文）→ 下发 → ACK → 成功；表单无 requestedBy 输入', async () => {
  const user = userEvent.setup();
  const { calls, rerender } = renderPage();
  // 表单不含 requestedBy 字段（不可编辑）
  await user.click(screen.getByTestId('quick-reboot'));
  const form = screen.getByTestId('command-form');
  assert.equal(within(form).queryByLabelText(/requestedBy|提交人/), null);
  await user.click(within(form).getByTestId('command-submit'));
  const notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('已受理（cmd-new-1）'));
  assert.ok(notice.textContent?.includes('等待设备执行'));
  assert.ok(notice.textContent?.includes('admin@example.com'));
  assert.notMatch(notice.textContent, /执行成功/);
  assert.equal(calls.refreshed, 1);

  // 列表 → 详情：PUBLISHED → ACKNOWLEDGED → SUCCEEDED
  const detail: CommandDetailView = {
    ...makeListItem({ status: 'SUCCEEDED' }),
    remarks: '现场重启',
    confirmedBy: null,
    attempts: [
      {
        attemptNo: 1,
        publishedAt: '2026-09-06T04:00:05Z',
        outcome: 'PUBLISHED',
        errorCode: null,
        providerMessageId: 'iot-request-1',
        finishedAt: '2026-09-06T04:00:06Z',
      },
    ],
    acks: [
      {
        result: 'SUCCESS',
        executeTimeMs: 820,
        errorCode: null,
        message: 'rebooted',
        ackAt: '2026-09-06T04:01:00Z',
        sourceMessageId: 'msg-ack-1',
      },
    ],
  };
  rerender({ commandDetail: { kind: 'ready', command: detail } });
  assert.equal(screen.getByTestId('command-detail-status').textContent, '执行成功');
  assert.ok(screen.getByTestId('command-attempts').textContent?.includes('第 1 次'));
  assert.ok(screen.getByTestId('command-attempts').textContent?.includes('发布成功'));
  assert.ok(screen.getByTestId('command-attempts').textContent?.includes('iot-request-1'));
  assert.ok(screen.getByTestId('command-ack-0').textContent?.includes('成功'));
  assert.ok(screen.getByTestId('command-ack-0').textContent?.includes('msg-ack-1'));
});

test('TIMED_OUT 展示；超时后收到的 ACK 标注“迟到 ACK”', () => {
  renderPage({
    commandDetail: {
      kind: 'ready',
      command: {
        ...makeListItem({ status: 'TIMED_OUT' }),
        remarks: null,
        confirmedBy: null,
        attempts: [
          {
            attemptNo: 1,
            publishedAt: '2026-09-06T04:00:05Z',
            outcome: 'PUBLISH_FAILED',
            errorCode: 'ThrottlingException',
            providerMessageId: null,
            finishedAt: '2026-09-06T04:00:06Z',
          },
        ],
        acks: [
          {
            result: 'RECEIVED',
            executeTimeMs: null,
            errorCode: null,
            message: null,
            ackAt: '2026-09-06T04:06:00Z',
            sourceMessageId: null,
          },
        ],
      },
    },
  });
  assert.equal(screen.getByTestId('command-detail-status').textContent, '已超时');
  assert.ok(screen.getByTestId('late-ack').textContent?.includes('迟到 ACK'));
  assert.ok(screen.getByTestId('command-ack-0').textContent?.includes('已收到（无执行结果）'));
});

// ---------- 媒体面板（DEC-009）与活动日志 ----------

test('媒体面板：仅最新 Media + 手动刷新；无播放/停止按钮（DEC-009）', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  const panel = screen.getByTestId('media-panel');
  assert.ok(panel.textContent?.includes('最新授权媒体（非实时画面）'));
  assert.ok(panel.textContent?.includes('media-1'));
  assert.equal(within(panel).queryByRole('button', { name: /播放/ }), null);
  assert.equal(within(panel).queryByRole('button', { name: /停止/ }), null);
  assert.notMatch(panel.innerHTML, /<video|<audio|rtsp|webrtc/i);
  await user.click(within(panel).getByTestId('media-refresh'));
  assert.equal(calls.mediaRefreshed, 1);
});

test('活动日志：级别/类型筛选应用；导出快照与当前筛选一致；表格渲染', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  const table = screen.getByRole('table', { name: '操作日志' });
  assert.ok(table.textContent?.includes('TEMP_HIGH'));
  assert.ok(table.textContent?.includes('严重'));

  await user.selectOptions(screen.getByTestId('activity-filter-level'), 'CRITICAL');
  await user.selectOptions(screen.getByTestId('activity-filter-kind'), 'ALARM');
  await user.click(screen.getByTestId('activity-filter-search'));
  assert.deepEqual(calls.activityFilterApplied, [{ level: 'CRITICAL', kind: 'ALARM' }]);

  await user.click(screen.getByTestId('activity-export-csv'));
  assert.deepEqual(calls.activityExported, [{}], '导出快照 = 当前已应用筛选');
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

test('API 装配：命令创建请求体（不含 requestedBy；confirmation 仅高风险）；列表筛选查询串', async () => {
  const { api, calls } = stubApi();
  await createDeviceCommand(api, 'dev-1', {
    command: 'SHUTDOWN',
    timeoutSec: 300,
    remarks: 'r',
    confirmation: { confirmText: 'SHUTDOWN' },
  });
  assert.equal(calls[0]?.path, '/admin/devices/dev-1/commands');
  assert.equal(calls[0]?.options.method, 'POST');
  const body = calls[0]?.options.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['command', 'confirmation', 'remarks', 'timeoutSec']);
  assert.ok(!('requestedBy' in body), 'requestedBy 不信任客户端声明');

  await fetchCommands(api, { deviceId: 'dev-1', status: 'TIMED_OUT', command: 'REBOOT' }, 'cur-1');
  assert.equal(calls[1]?.path, '/admin/commands?deviceId=dev-1&status=TIMED_OUT&command=REBOOT&cursor=cur-1');
});
