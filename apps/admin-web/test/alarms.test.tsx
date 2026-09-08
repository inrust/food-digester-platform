// @vitest-environment jsdom
/**
 * FE-10 告警/事件/防拆页测试：
 * - 状态更新：ACTIVE→确认→ACKNOWLEDGED→清除→CLEARED；矩阵按钮可用性；
 * - 重复操作幂等（replayed=true 提示“已幂等忽略”）；原因必填；
 * - 筛选参数与 URL 同步（replaceState + urlStateFromSearch 回读）；
 * - 跨 Customer 不可见：404 详情错误呈现；Customer 角色无客户筛选；
 * - CRITICAL 显著（severity-critical 行 + 徽标）；不混入 AWS 运维告警（边界断言）。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError, ForbiddenError } from '../src/api/errors.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { AlarmsPage } from '../src/pages/alarms/AlarmsPage.js';
import type { AlarmsPageProps } from '../src/pages/alarms/AlarmsPage.js';
import { acknowledgeAlarm, fetchAlarms, fetchTamperEvents } from '../src/pages/alarms/alarms-api.js';
import {
  DEFAULT_URL_STATE,
  EMPTY_ALARM_FILTER,
  urlStateFromSearch,
  urlStateToSearch,
} from '../src/pages/alarms/alarm-state.js';
import type { AlarmPageUrlState } from '../src/pages/alarms/alarm-state.js';
import type { AlarmHandleResultView, AlarmView } from '../src/pages/alarms/types.js';

afterEach(cleanup);

function makeAlarm(overrides: Partial<AlarmView> = {}): AlarmView {
  return {
    alarmId: 'alm-001',
    deviceId: 'dev-001',
    customerId: 'cust-1',
    code: 'TEMP_HIGH',
    category: 'temperature',
    severity: 'CRITICAL',
    status: 'ACTIVE',
    detectedTime: '2026-09-06T03:00:00Z',
    component: 'temperature',
    currentValue: '95',
    threshold: '80',
    unit: '°C',
    message: '筒仓温度超阈值',
    recommendedAction: '检查加热系统',
    acknowledgedBy: null,
    acknowledgedAt: null,
    acknowledgeReason: null,
    clearedBy: null,
    clearedAt: null,
    clearReason: null,
    createdAt: '2026-09-06T03:00:00Z',
    updatedAt: '2026-09-06T03:00:00Z',
    ...overrides,
  };
}

function renderPage(overrides: Partial<AlarmsPageProps> = {}) {
  const calls = {
    applied: [] as AlarmPageUrlState[],
    refreshed: 0,
    selected: [] as string[],
    acknowledged: [] as { alarmId: string; reason: string }[],
    cleared: [] as { alarmId: string; reason: string }[],
  };
  const props: AlarmsPageProps = {
    role: 'PlatformSuperAdmin',
    isCustomerRole: false,
    customerOptions: [{ value: 'cust-1', label: '示例客户' }],
    urlState: DEFAULT_URL_STATE,
    onApplyUrlState: (s) => calls.applied.push(s),
    alarms: { rows: [makeAlarm()], nextCursor: null },
    events: { rows: [], nextCursor: null },
    tampers: { rows: [], nextCursor: null },
    onLoadMore: () => {},
    onRefresh: () => {
      calls.refreshed += 1;
    },
    alarmDetail: { kind: 'none' },
    onSelectAlarm: (id) => calls.selected.push(id),
    onCloseAlarmDetail: () => {},
    onAcknowledge: async (alarmId, reason) => {
      calls.acknowledged.push({ alarmId, reason });
      return { ...makeAlarm({ status: 'ACKNOWLEDGED' }), replayed: false };
    },
    onClear: async (alarmId, reason) => {
      calls.cleared.push({ alarmId, reason });
      return { ...makeAlarm({ status: 'CLEARED' }), replayed: false };
    },
    ...overrides,
  };
  const utils = render(<AlarmsPage {...props} />);
  return { calls, unmount: utils.unmount };
}

function disabled(testid: string): boolean {
  return (screen.getByTestId(testid) as HTMLButtonElement).disabled;
}

// ---------- 状态更新与重复操作 ----------

test('状态更新：ACTIVE 可确认/清除 → ACKNOWLEDGED 仅清除 → CLEARED 无动作；每步原因必填', async () => {
  const user = userEvent.setup();
  const { calls, unmount } = renderPage({ alarmDetail: { kind: 'ready', alarm: makeAlarm() } });
  // ACTIVE：确认与清除均可用
  assert.ok(!disabled('alarm-acknowledge'));
  assert.ok(!disabled('alarm-clear'));
  await user.click(screen.getByTestId('alarm-acknowledge'));
  const dialog = screen.getByTestId('confirm-dialog');
  const confirm = within(dialog).getByRole('button', { name: '确认告警' }) as HTMLButtonElement;
  assert.ok(confirm.disabled, '原因必填');
  await user.type(within(dialog).getByLabelText('确认原因'), '已派单处理');
  await user.click(confirm);
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.acknowledged, [{ alarmId: 'alm-001', reason: '已派单处理' }]);
  assert.equal(calls.refreshed, 1);
  unmount();

  // ACKNOWLEDGED：仅清除
  const second = renderPage({ alarmDetail: { kind: 'ready', alarm: makeAlarm({ status: 'ACKNOWLEDGED' }) } });
  assert.ok(disabled('alarm-acknowledge'));
  assert.ok(!disabled('alarm-clear'));
  await user.click(screen.getByTestId('alarm-clear'));
  const clearDialog = screen.getByTestId('confirm-dialog');
  await user.type(within(clearDialog).getByLabelText('清除原因'), '温度恢复正常');
  await user.click(within(clearDialog).getByRole('button', { name: '确认清除' }));
  await screen.findByTestId('action-notice');
  assert.deepEqual(second.calls.cleared, [{ alarmId: 'alm-001', reason: '温度恢复正常' }]);
  second.unmount();

  // CLEARED：无动作
  renderPage({ alarmDetail: { kind: 'ready', alarm: makeAlarm({ status: 'CLEARED' }) } });
  assert.ok(disabled('alarm-acknowledge'));
  assert.ok(disabled('alarm-clear'));
});

test('重复操作幂等：replayed=true 提示已幂等忽略且不重复写入语义', async () => {
  const user = userEvent.setup();
  renderPage({
    alarmDetail: { kind: 'ready', alarm: makeAlarm() },
    onAcknowledge: async (): Promise<AlarmHandleResultView> => ({
      ...makeAlarm({ status: 'ACKNOWLEDGED' }),
      replayed: true,
    }),
  });
  await user.click(screen.getByTestId('alarm-acknowledge'));
  const dialog = screen.getByTestId('confirm-dialog');
  await user.type(within(dialog).getByLabelText('确认原因'), '重复点击');
  await user.click(within(dialog).getByRole('button', { name: '确认告警' }));
  const notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('幂等忽略'));
});

test('后端拒绝呈现：CLEARED 终态确认 → 409 CONFLICT；无 alarm:write → 403/按钮禁用', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPage({
    alarmDetail: { kind: 'ready', alarm: makeAlarm() },
    onAcknowledge: async () => {
      throw new ApiClientError(409, 'CONFLICT', '终态告警不可确认', 'r-409');
    },
  });
  await user.click(screen.getByTestId('alarm-acknowledge'));
  const dialog = screen.getByTestId('confirm-dialog');
  await user.type(within(dialog).getByLabelText('确认原因'), '尝试');
  await user.click(within(dialog).getByRole('button', { name: '确认告警' }));
  const error = await screen.findByTestId('error-generic');
  assert.ok(error.textContent?.includes('终态告警不可确认'));
  unmount();

  // Auditor（alarm:read 无 write）：按钮禁用
  renderPage({ role: 'Auditor', alarmDetail: { kind: 'ready', alarm: makeAlarm() } });
  assert.ok(disabled('alarm-acknowledge'));
  assert.ok(disabled('alarm-clear'));
});

// ---------- 筛选与 URL 同步 ----------

test('筛选参数与 URL 同步：应用后 replaceState；urlStateFromSearch 可回读', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.selectOptions(screen.getByTestId('filter-severity'), 'CRITICAL');
  await user.selectOptions(screen.getByTestId('filter-status'), 'ACTIVE');
  await user.type(screen.getByTestId('filter-device'), 'dev-001');
  await user.click(screen.getByTestId('filter-search'));

  assert.equal(calls.applied.length, 1);
  const applied = calls.applied[0];
  assert.ok(applied !== undefined);
  assert.equal(applied.alarm.severity, 'CRITICAL');
  assert.equal(applied.alarm.status, 'ACTIVE');
  assert.equal(applied.alarm.deviceId, 'dev-001');

  // 序列化 → URL 查询串 → 解析回读（URL 仅携带当前 Tab 的筛选）
  const search = urlStateToSearch(applied);
  assert.ok(search.includes('tab=alarm'));
  assert.ok(search.includes('severity=CRITICAL'));
  assert.ok(search.includes('status=ACTIVE'));
  assert.ok(search.includes('deviceId=dev-001'));
  const parsed = urlStateFromSearch(search);
  assert.equal(parsed.tab, applied.tab);
  assert.deepEqual(parsed.alarm, applied.alarm);
});

test('URL 同步副作用：urlState prop 变化时 replaceState 更新 location.search', () => {
  const state: AlarmPageUrlState = {
    ...DEFAULT_URL_STATE,
    alarm: { ...EMPTY_ALARM_FILTER, severity: 'MAJOR', deviceId: 'dev-9' },
  };
  renderPage({ urlState: state });
  assert.ok(window.location.search.includes('severity=MAJOR'));
  assert.ok(window.location.search.includes('deviceId=dev-9'));
  cleanup();
  window.history.replaceState(null, '', '/alarms');
});

test('非法/未知 URL 参数静默丢弃，回退默认 Tab', () => {
  const parsed = urlStateFromSearch('?tab=unknown&severity=HUGE&status=ACTIVE&deviceId=dev-1');
  assert.equal(parsed.tab, 'alarm');
  assert.equal(parsed.alarm.severity, null);
  assert.equal(parsed.alarm.status, 'ACTIVE');
  assert.equal(parsed.alarm.deviceId, 'dev-1');
});

// ---------- Tab 与租户 ----------

test('三个 Tab 切换；Event/Tamper 只读（无操作列）；Tamper details 原样 JSON 透传', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({
    tampers: {
      rows: [
        {
          tamperEventId: 'tmp-1',
          deviceId: 'dev-001',
          customerId: 'cust-1',
          eventType: 'COVER_OPEN',
          severity: 'MAJOR',
          component: 'cover',
          details: { sensor: 'hall', openSeconds: 12 },
          actionTaken: 'LOCKED',
          occurredAt: '2026-09-06T04:00:00Z',
        },
      ],
      nextCursor: null,
    },
  });
  await user.click(screen.getByTestId('tab-tamper'));
  assert.equal(calls.applied[0]?.tab, 'tamper');
  // 父级应用后重渲染（模拟）
  cleanup();
  renderPage({
    urlState: { ...DEFAULT_URL_STATE, tab: 'tamper' },
    tampers: {
      rows: [
        {
          tamperEventId: 'tmp-1',
          deviceId: 'dev-001',
          customerId: 'cust-1',
          eventType: 'COVER_OPEN',
          severity: 'MAJOR',
          component: 'cover',
          details: { sensor: 'hall', openSeconds: 12 },
          actionTaken: 'LOCKED',
          occurredAt: '2026-09-06T04:00:00Z',
        },
      ],
      nextCursor: null,
    },
  });
  const table = screen.getByRole('table', { name: '防拆事件列表' });
  assert.ok(table.textContent?.includes('COVER_OPEN'));
  assert.ok(table.textContent?.includes('"openSeconds":12'));
  // 只读：无操作按钮
  assert.equal(within(table).queryByRole('button'), null);
});

test('跨 Customer 不可见：详情 404 呈现 NOT_FOUND；Customer 角色无客户筛选', () => {
  const { unmount } = renderPage({
    alarmDetail: { kind: 'error', error: new ApiClientError(404, 'NOT_FOUND', '告警不存在或无权访问', 'r-404') },
  });
  const error = screen.getByTestId('error-generic');
  assert.ok(error.textContent?.includes('NOT_FOUND'));
  unmount();

  renderPage({
    role: 'CustomerAdmin',
    isCustomerRole: true,
    alarmDetail: { kind: 'error', error: new ForbiddenError('FORBIDDEN', '无 alarm:write', 'r-403') },
  });
  assert.equal(screen.queryByTestId('filter-customer'), null, 'Customer 角色不渲染客户筛选');
  assert.ok(screen.getByTestId('error-forbidden'));
});

// ---------- CRITICAL 显著与边界 ----------

test('CRITICAL 显著：行级 severity-critical + “严重”徽标；页面不含 AWS 运维告警字样', () => {
  renderPage();
  const badge = screen.getByTestId('severity-alm-001');
  assert.equal(badge.textContent, '严重');
  assert.ok(badge.className.includes('severity-critical'));
  const row = badge.closest('tr');
  assert.ok(row?.className.includes('severity-critical'), 'CRITICAL 行需显著样式');
  // 功能边界：不展示 CloudWatch/SQS/RDS 告警
  const pageText = screen.getByTestId('alarms-page').textContent ?? '';
  assert.notMatch(pageText, /CloudWatch|SQS|RDS/i);
});

// ---------- API 装配 ----------

function stubApi(): { api: ApiClient; calls: { path: string; options: ApiRequestOptions }[] } {
  const calls: { path: string; options: ApiRequestOptions }[] = [];
  const api: ApiClient = {
    request: async <T,>(path: string, options: ApiRequestOptions = {}) => {
      calls.push({ path, options });
      return { data: [], meta: { nextCursor: null } } as T;
    },
  };
  return { api, calls };
}

test('API 装配：列表筛选查询串 + 游标；确认/清除 POST 携强制原因', async () => {
  const { api, calls } = stubApi();
  await fetchAlarms(
    api,
    { customerId: 'c1', severity: 'CRITICAL', status: 'ACTIVE', from: '2026-09-01T00:00:00Z' },
    'cur-1',
  );
  assert.equal(
    calls[0]?.path,
    '/admin/alarms?customerId=c1&severity=CRITICAL&status=ACTIVE&from=2026-09-01T00%3A00%3A00Z&cursor=cur-1',
  );

  await fetchTamperEvents(api, { deviceId: 'dev-1', eventType: 'COVER_OPEN' });
  assert.equal(calls[1]?.path, '/admin/tamper-events?deviceId=dev-1&eventType=COVER_OPEN');

  await acknowledgeAlarm(api, 'alm-1', '已派单');
  assert.equal(calls[2]?.path, '/admin/alarms/alm-1/acknowledge');
  assert.equal(calls[2]?.options.method, 'POST');
  assert.deepEqual(calls[2]?.options.body, { reason: '已派单' });
});
