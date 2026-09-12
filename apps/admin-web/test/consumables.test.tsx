// @vitest-environment jsdom
/**
 * FE-18 耗材状态与更换申请页测试：
 * - 列表：Region/Subregion/Site/连接/关键字/阈值筛选；标准耗材名称；unknown 仅文本不画进度条；
 *   stale 徽标；阈值颜色（暂定阈值 prop 驱动）；
 * - 联系方式：点击后按权限展示；无权限（contact=null）页面与响应均不含号码；
 * - 申请：三段状态流程（PENDING→PROCESSING→COMPLETED/CANCELLED）；操作携带 version + 备注
 *   （complete/cancel 强制）；跳级不渲染按钮；重复创建幂等（replayed 提示）。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError } from '../src/api/errors.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { ConsumablesPage } from '../src/pages/consumables/ConsumablesPage.js';
import type { ConsumablesPageProps } from '../src/pages/consumables/ConsumablesPage.js';
import {
  completeConsumableRequest,
  createConsumableRequest,
  listConsumableStatus,
  processConsumableRequest,
} from '../src/pages/consumables/consumables-api.js';
import { gateRequestAction, thresholdLevel, validateRequestNote } from '../src/pages/consumables/consumable-state.js';
import type {
  ConsumableRequestCreateResult,
  ConsumableRequestView,
  ConsumableStatusView,
  ConsumableValueView,
} from '../src/pages/consumables/types.js';

afterEach(cleanup);

function makeValue(overrides: Partial<ConsumableValueView> = {}): ConsumableValueView {
  return {
    remainingPercent: 45,
    remainingDisplay: '45%',
    stale: false,
    observedAt: '2026-09-06T03:00:00Z',
    sourceMessageId: 'msg-1',
    ...overrides,
  };
}

function makeStatus(overrides: Partial<ConsumableStatusView> = {}): ConsumableStatusView {
  return {
    deviceId: 'dev-001',
    serialNumber: 'SN-001',
    model: 'FD-100',
    alias: '厨房一号',
    lifecycleStatus: 'Active',
    site: { siteId: 'site-1', name: '总店', region: '华东', subregion: '上海' },
    connectivity: 'ONLINE',
    consumables: {
      CARBON_FILTER: makeValue({ remainingPercent: 8, remainingDisplay: '8%' }),
      BIO_ADDITIVE: makeValue({ remainingPercent: null, remainingDisplay: 'unknown', stale: true, observedAt: null }),
    },
    contact: { name: '张经理', phone: '138****0000', email: 'zhang@example.com' },
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ConsumableRequestView> = {}): ConsumableRequestView {
  return {
    requestId: 'req-001',
    customerId: 'cust-1',
    deviceId: 'dev-001',
    consumableType: 'CARBON_FILTER',
    status: 'PENDING',
    source: 'ADMIN',
    requestedBy: 'admin@example.com',
    requestedAt: '2026-09-06T02:00:00Z',
    processedBy: null,
    processNote: null,
    completedAt: null,
    version: 2,
    createdAt: '2026-09-06T02:00:00Z',
    updatedAt: '2026-09-06T02:00:00Z',
    ...overrides,
  };
}

function renderPage(overrides: Partial<ConsumablesPageProps> = {}) {
  const calls = {
    statusFilters: [] as unknown[],
    requestFilters: [] as unknown[],
    created: [] as { deviceId: string; type: string; note?: string }[],
    processed: [] as { id: string; note: string | null; version: number }[],
    completed: [] as { id: string; note: string; version: number }[],
    cancelled: [] as { id: string; note: string; version: number }[],
    refreshed: 0,
  };
  const props: ConsumablesPageProps = {
    role: 'PlatformSuperAdmin',
    status: { rows: [makeStatus()] },
    statusFilter: {},
    onApplyStatusFilter: (f) => calls.statusFilters.push(f),
    requests: {
      rows: [
        makeRequest(),
        makeRequest({ requestId: 'req-002', status: 'PROCESSING', processedBy: 'op@example.com', version: 3 }),
        makeRequest({ requestId: 'req-003', status: 'COMPLETED', completedAt: '2026-09-06T05:00:00Z', processNote: '已更换' }),
      ],
    },
    requestFilter: {},
    onApplyRequestFilter: (f) => calls.requestFilters.push(f),
    onCreateRequest: async (deviceId, consumableType, note) => {
      calls.created.push({ deviceId, type: consumableType, ...(note !== undefined ? { note } : {}) });
      const result: ConsumableRequestCreateResult = { request: makeRequest({ requestId: 'req-new', deviceId }), replayed: false };
      return result;
    },
    onProcess: async (id, note, version) => {
      calls.processed.push({ id, note, version });
      return makeRequest({ requestId: id, status: 'PROCESSING' });
    },
    onComplete: async (id, note, version) => {
      calls.completed.push({ id, note, version });
      return makeRequest({ requestId: id, status: 'COMPLETED' });
    },
    onCancel: async (id, note, version) => {
      calls.cancelled.push({ id, note, version });
      return makeRequest({ requestId: id, status: 'CANCELLED' });
    },
    onRefresh: () => {
      calls.refreshed += 1;
    },
    ...overrides,
  };
  const utils = render(<ConsumablesPage {...props} />);
  return { calls, unmount: utils.unmount };
}

// ---------- 耗材列表 ----------

test('列表：列与筛选覆盖（Region/Subregion/Site/连接/关键字/阈值/类型）', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  assert.ok(screen.getByText('华东'));
  assert.ok(screen.getByText('上海'));
  assert.ok(screen.getByText('总店'));
  // dev-001 同时出现在耗材表与申请表 → getAllByText
  assert.ok(screen.getAllByText('dev-001').length >= 2);
  assert.ok(screen.getByText('厨房一号'));

  await user.type(screen.getByTestId('consumable-filter-region'), '华东');
  await user.type(screen.getByTestId('consumable-filter-subregion'), '上海');
  await user.type(screen.getByTestId('consumable-filter-site'), 'site-1');
  await user.selectOptions(screen.getByTestId('consumable-filter-connectivity'), 'OFFLINE');
  await user.type(screen.getByTestId('consumable-filter-keyword'), '厨房');
  await user.type(screen.getByTestId('consumable-filter-max'), '30');
  await user.selectOptions(screen.getByTestId('consumable-filter-type'), 'CARBON_FILTER');
  await user.type(screen.getByTestId('consumable-filter-customer'), 'cust-1');
  await user.click(screen.getByTestId('consumable-search'));
  assert.deepEqual(calls.statusFilters[0], {
    region: '华东',
    subregion: '上海',
    siteId: 'site-1',
    connectivity: 'OFFLINE',
    keyword: '厨房',
    maxRemainingPercent: 30,
    consumableType: 'CARBON_FILTER',
    customerId: 'cust-1',
  });

  // 重置
  await user.click(screen.getByTestId('consumable-reset'));
  assert.deepEqual(calls.statusFilters[1], {});
});

test('unknown 不画正常进度条；stale 徽标清晰；阈值分级（暂定阈值 prop 驱动）', () => {
  renderPage();
  const carbon = screen.getByTestId('consumable-carbon-dev-001');
  // 8% < 10 → low
  assert.equal(carbon.querySelector('.consumable-bar')?.getAttribute('data-level'), 'low');
  const bio = screen.getByTestId('consumable-bio-dev-001');
  assert.ok(bio.textContent?.includes('unknown'));
  assert.equal(bio.querySelector('.consumable-bar'), null);
  assert.ok(bio.textContent?.includes('数据过期'));
  // 纯逻辑：分级边界 + prop 覆盖
  assert.equal(thresholdLevel(9), 'low');
  assert.equal(thresholdLevel(10), 'mid');
  assert.equal(thresholdLevel(30), 'mid');
  assert.equal(thresholdLevel(31), 'ok');
  assert.equal(thresholdLevel(null), null);
  assert.equal(thresholdLevel(5, { low: 3, mid: 50 }), 'mid');
});

test('联系方式：点击后按权限展示；无权限（contact=null）页面与响应均不含号码', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPage();
  // 初始不显示号码
  assert.ok(!(document.body.textContent ?? '').includes('138****0000'));
  await user.click(screen.getByTestId('consumable-contact-dev-001'));
  assert.ok(screen.getByTestId('consumable-contact-info-dev-001').textContent?.includes('138****0000'));
  unmount();

  // 无权限角色：contact 为 null（网络响应即不含号码），点击后显示无权限提示
  renderPage({ role: 'CustomerViewer', status: { rows: [makeStatus({ contact: null })] } });
  await user.click(screen.getByTestId('consumable-contact-dev-001'));
  assert.ok(screen.getByTestId('consumable-contact-info-dev-001').textContent?.includes('无权限查看'));
  assert.ok(!(document.body.textContent ?? '').includes('138****0000'));
});

// ---------- 更换申请 ----------

test('申请列表：申请时间/状态列；三段状态流程动作按矩阵渲染（终态无按钮）', () => {
  renderPage();
  assert.ok(screen.getByTestId('consumable-request-status-req-001').textContent?.includes('待处理'));
  assert.ok(screen.getByTestId('consumable-request-status-req-002').textContent?.includes('处理中'));
  assert.ok(screen.getByTestId('consumable-request-status-req-003').textContent?.includes('已完成'));
  // PENDING：处理/取消（无完成——跳级不渲染）
  assert.ok(screen.getByTestId('consumable-process-req-001'));
  assert.equal(screen.queryByTestId('consumable-complete-req-001'), null);
  // PROCESSING：完成/取消
  assert.ok(screen.getByTestId('consumable-complete-req-002'));
  assert.equal(screen.queryByTestId('consumable-process-req-002'), null);
  // COMPLETED：终态无动作
  assert.equal(screen.queryByTestId('consumable-process-req-003'), null);
  assert.equal(screen.queryByTestId('consumable-complete-req-003'), null);
  assert.equal(screen.queryByTestId('consumable-cancel-req-003'), null);
  assert.ok(gateRequestAction('complete', 'PENDING', 'PlatformOperator')?.includes('不允许'));
});

test('处理→完成全流程：操作携带 version + 备注（complete 强制备注）', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  // 处理（备注可选）
  await user.click(screen.getByTestId('consumable-process-req-001'));
  await user.click(screen.getByTestId('consumable-action-submit'));
  assert.deepEqual(calls.processed, [{ id: 'req-001', note: null, version: 2 }]);

  // 完成（备注强制）
  await user.click(screen.getByTestId('consumable-complete-req-002'));
  const submit = screen.getByTestId('consumable-action-submit') as HTMLButtonElement;
  assert.equal(submit.disabled, true);
  assert.ok(screen.getByTestId('consumable-action-note-error').textContent?.includes('必填'));
  await user.type(screen.getByTestId('consumable-action-note'), '已更换碳包');
  await user.click(screen.getByTestId('consumable-action-submit'));
  assert.deepEqual(calls.completed, [{ id: 'req-002', note: '已更换碳包', version: 3 }]);
  assert.equal(validateRequestNote('', true)?.includes('必填'), true);
  assert.equal(validateRequestNote('ok', false), null);
});

test('创建申请：成功提示；开放申请重复创建幂等（replayed 提示）', async () => {
  const user = userEvent.setup();
  let replay = false;
  const { calls } = renderPage({
    onCreateRequest: async (deviceId, consumableType, note) => {
      calls.created.push({ deviceId, type: consumableType, ...(note !== undefined ? { note } : {}) });
      return { request: makeRequest({ requestId: 'req-open', deviceId }), replayed: replay };
    },
  });
  await user.click(screen.getByTestId('consumable-request-create-open'));
  await user.type(screen.getByTestId('consumable-create-device'), 'dev-001');
  await user.selectOptions(screen.getByTestId('consumable-create-type'), 'CARBON_FILTER');
  await user.click(screen.getByTestId('consumable-create-submit'));
  let notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('已创建'));

  replay = true;
  await user.click(screen.getByTestId('consumable-request-create-open'));
  await user.type(screen.getByTestId('consumable-create-device'), 'dev-001');
  await user.selectOptions(screen.getByTestId('consumable-create-type'), 'CARBON_FILTER');
  await user.click(screen.getByTestId('consumable-create-submit'));
  notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('幂等返回现有记录'));
});

test('非法跳级/漂移：409 错误呈现；写权限门控（Viewer 按钮禁用）', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPage({
    onProcess: async () => {
      throw new ApiClientError(409, 'CONFLICT', '非法状态迁移（跳级/重复处理）', 'req-x');
    },
  });
  await user.click(screen.getByTestId('consumable-process-req-001'));
  await user.click(screen.getByTestId('consumable-action-submit'));
  const error = await screen.findByTestId('error-generic');
  assert.ok(error.textContent?.includes('非法状态迁移'));
  unmount();

  renderPage({ role: 'CustomerViewer' });
  const button = screen.getByTestId('consumable-process-req-001') as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.ok(button.title.includes('device:write'));
});

// ---------- API 装配 ----------

function stubApi(): { api: ApiClient; calls: { path: string; options: ApiRequestOptions }[] } {
  const calls: { path: string; options: ApiRequestOptions }[] = [];
  const api: ApiClient = {
    request: async <T,>(path: string, options: ApiRequestOptions = {}) => {
      calls.push({ path, options });
      return { data: { replayed: true }, meta: {} } as T;
    },
  };
  return { api, calls };
}

test('API 装配：查询串；状态迁移 If-Match 与请求体', async () => {
  const { api, calls } = stubApi();
  await listConsumableStatus(api, { region: '华东', connectivity: 'ONLINE', maxRemainingPercent: 30, consumableType: 'CARBON_FILTER' });
  assert.equal(calls[0]?.path, '/admin/consumables?region=%E5%8D%8E%E4%B8%9C&connectivity=ONLINE&maxRemainingPercent=30&consumableType=CARBON_FILTER');

  await createConsumableRequest(api, 'dev-1', 'BIO_ADDITIVE', '备注');
  assert.equal(calls[1]?.path, '/admin/consumable-requests');
  assert.deepEqual(calls[1]?.options.body, { deviceId: 'dev-1', consumableType: 'BIO_ADDITIVE', note: '备注' });

  await processConsumableRequest(api, 'req-1', null, 2);
  assert.equal(calls[2]?.path, '/admin/consumable-requests/req-1/process');
  assert.equal(calls[2]?.options.ifMatch, 2);
  assert.deepEqual(calls[2]?.options.body, {});

  await completeConsumableRequest(api, 'req-1', '已更换', 3);
  assert.equal(calls[3]?.options.ifMatch, 3);
  assert.deepEqual(calls[3]?.options.body, { note: '已更换' });
});
