// @vitest-environment jsdom
/**
 * FE-17 Contract 管理页面测试：
 * - 列表：客户/状态筛选、客户名按目录解析、设备确定性计数、服务期限、派生状态标签；
 * - 新建：字段校验（编号/结束日早于开始日/Customer 必选）、创建 DRAFT（不自动激活 License）、
 *   两步 eligible 设备关联；编号重复 409 呈现；
 * - 详情：动作矩阵（DRAFT/TERMINATED/非写角色门控）、编辑/激活/续约/终止（version + 强制原因）、
 *   绑定（eligible）/解绑（不撤销 License）、四轴状态与 License 并列展示；
 * - API 装配：If-Match 乐观锁与请求体快照。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError } from '../src/api/errors.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { ContractsPage, resolveCustomerName } from '../src/pages/contracts/ContractsPage.js';
import type { ContractsPageProps } from '../src/pages/contracts/ContractsPage.js';
import { ContractNewPage } from '../src/pages/contracts/ContractNewPage.js';
import type { ContractNewPageProps } from '../src/pages/contracts/ContractNewPage.js';
import { ContractDetailPage } from '../src/pages/contracts/ContractDetailPage.js';
import type { ContractDetailPageProps } from '../src/pages/contracts/ContractDetailPage.js';
import {
  bindContractDevices,
  listContracts,
  renewContract,
  unbindContractDevices,
  updateContract,
} from '../src/pages/contracts/contracts-api.js';
import type { ContractCreateInput, ContractUpdateInput } from '../src/pages/contracts/contracts-api.js';
import { gateContractAction, validateContractForm, validateRenew } from '../src/pages/contracts/contract-state.js';
import type {
  AvailableDeviceView,
  ContractDeviceAssociationView,
  ContractDeviceDetailView,
  ContractView,
} from '../src/pages/contracts/types.js';

afterEach(cleanup);

const CUSTOMERS = [
  { customerId: 'cust-1', name: '绿洲酒店集团' },
  { customerId: 'cust-2', name: '海蓝物业' },
];

function makeContract(overrides: Partial<ContractView> = {}): ContractView {
  return {
    contractId: 'con-001',
    contractNumber: 'HT-2026-001',
    name: '绿洲年度服务合约',
    customerId: 'cust-1',
    contact: 'ops@oasis.example.com',
    startAt: '2026-01-01T00:00:00Z',
    endAt: '2027-01-01T00:00:00Z',
    status: 'EFFECTIVE',
    derivedStatus: 'EFFECTIVE',
    version: 3,
    createdBy: 'admin@example.com',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function makeDeviceDetail(deviceId = 'dev-001'): ContractDeviceDetailView {
  return {
    association: {
      associationId: 'assoc-001',
      deviceId,
      customerId: 'cust-1',
      validFrom: '2026-01-01T00:00:00Z',
      validTo: '2027-01-01T00:00:00Z',
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00Z',
      endedAt: null,
    },
    device: {
      deviceId,
      serialNumber: 'SN-001',
      model: 'FD-100',
      alias: '厨房一号',
      firmwareVersion: '1.2.3',
      site: { name: '总店', region: '华东', subregion: '上海' },
      lifecycleStatus: 'Active',
      operationalStatus: 'Active',
      connectivity: 'ONLINE',
      licenseStatus: 'Active',
      lastHeartbeatAt: '2026-09-06T03:00:00Z',
    },
  };
}

function makeAvailable(deviceId = 'dev-100'): AvailableDeviceView {
  return {
    deviceId,
    serialNumber: 'SN-100',
    model: 'FD-100',
    alias: '备用机',
    lifecycleStatus: 'Onboarded',
    site: { name: '总店', region: '华东', subregion: '上海' },
  };
}

// ---------- 列表 ----------

function renderList(overrides: Partial<ContractsPageProps> = {}) {
  const calls = { filterApplied: [] as unknown[], opened: [] as string[], newOpened: 0 };
  const props: ContractsPageProps = {
    role: 'PlatformSuperAdmin',
    contracts: {
      rows: [
        makeContract(),
        makeContract({
          contractId: 'con-002',
          contractNumber: 'HT-2026-002',
          customerId: 'cust-2',
          derivedStatus: 'EXPIRING_SOON',
        }),
      ],
    },
    filter: {},
    onApplyFilter: (f) => calls.filterApplied.push(f),
    customerOptions: CUSTOMERS,
    deviceCounts: { 'con-001': 2 },
    onOpenNew: () => {
      calls.newOpened += 1;
    },
    onOpenDetail: (id) => calls.opened.push(id),
    onRefresh: () => {},
    ...overrides,
  };
  const utils = render(<ContractsPage {...props} />);
  return { calls, unmount: utils.unmount };
}

test('列表：客户名解析、设备计数、服务期限、派生状态标签、筛选回调', async () => {
  const user = userEvent.setup();
  const { calls } = renderList();
  assert.ok(screen.getByText('HT-2026-001'));
  // 客户名按目录解析（筛选下拉与表格单元格同名，用 getAllByText 确认出现）
  assert.ok(screen.getAllByText('绿洲酒店集团').length >= 2);
  assert.ok(screen.getAllByText('海蓝物业').length >= 2);
  assert.equal(screen.getByTestId('contract-device-count-con-001').textContent, '2');
  assert.equal(screen.getByTestId('contract-device-count-con-002').textContent, '—');
  // 两行合约服务期限相同 → 用 getAllByText
  assert.equal(screen.getAllByText('2026-01-01 ~ 2027-01-01').length, 2);
  assert.equal(screen.getByTestId('contract-status-con-002').textContent, '即将到期');
  assert.equal(resolveCustomerName(CUSTOMERS, 'cust-x'), 'cust-x');

  await user.selectOptions(screen.getByTestId('contract-filter-status'), 'EXPIRED');
  await user.selectOptions(screen.getByTestId('contract-filter-customer'), 'cust-1');
  await user.click(screen.getByTestId('contract-filter-search'));
  assert.deepEqual(calls.filterApplied, [{ status: 'EXPIRED', customerId: 'cust-1' }]);

  await user.click(screen.getByTestId('contract-open-con-001'));
  assert.deepEqual(calls.opened, ['con-001']);
});

test('列表：新建按钮按 contract:write 门控（Operator 禁用）', () => {
  const { unmount } = renderList();
  assert.equal((screen.getByTestId('contract-new-open') as HTMLButtonElement).disabled, false);
  unmount();
  renderList({ role: 'PlatformOperator' });
  const button = screen.getByTestId('contract-new-open') as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.ok(button.title.includes('contract:write'));
});

// ---------- 新建 ----------

function renderNew(overrides: Partial<ContractNewPageProps> = {}) {
  const calls = {
    created: [] as ContractCreateInput[],
    listed: [] as string[],
    bound: [] as { contractId: string; deviceIds: readonly string[]; reason: string }[],
    done: 0,
    cancelled: 0,
  };
  const props: ContractNewPageProps = {
    customerOptions: CUSTOMERS,
    onCreate: async (input) => {
      calls.created.push(input);
      return makeContract({
        contractId: 'con-new',
        contractNumber: input.contractNumber,
        status: 'DRAFT',
        derivedStatus: 'DRAFT',
      });
    },
    onListAvailable: async (contractId) => {
      calls.listed.push(contractId);
      return [makeAvailable()];
    },
    onBind: async (contractId, deviceIds, reason) => {
      calls.bound.push({ contractId, deviceIds, reason });
      return [...deviceIds];
    },
    onCancel: () => {
      calls.cancelled += 1;
    },
    onDone: () => {
      calls.done += 1;
    },
    ...overrides,
  };
  const utils = render(<ContractNewPage {...props} />);
  return { calls, unmount: utils.unmount };
}

test('新建：字段校验（编号必填/结束日早于开始日/Customer 必选）阻断提交', () => {
  renderNew();
  assert.ok(screen.getByTestId('contract-error-contractNumber'));
  assert.ok(screen.getByTestId('contract-error-customerId'));
  assert.ok(screen.getByTestId('contract-error-period'));
  assert.equal((screen.getByTestId('contract-create-submit') as HTMLButtonElement).disabled, true);
  // 结束日早于开始日
  assert.ok(
    validateContractForm({
      contractNumber: 'HT-1',
      name: 'x',
      customerId: 'cust-1',
      contact: '',
      startAt: '2027-01-01T00:00:00Z',
      endAt: '2026-01-01T00:00:00Z',
    })?.['period']?.includes('晚于'),
  );
});

test('新建：创建 DRAFT（不自动激活 License）→ eligible 设备两步关联', async () => {
  const user = userEvent.setup();
  const { calls } = renderNew();
  await user.type(screen.getByTestId('contract-number-input'), 'HT-2026-100');
  await user.type(screen.getByTestId('contract-name-input'), '新合约');
  await user.selectOptions(screen.getByTestId('contract-customer-select'), 'cust-1');
  fireEvent.change(screen.getByTestId('contract-start-input'), { target: { value: '2026-10-01T00:00' } });
  fireEvent.change(screen.getByTestId('contract-end-input'), { target: { value: '2027-10-01T00:00' } });
  await user.click(screen.getByTestId('contract-create-submit'));

  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0]?.contractNumber, 'HT-2026-100');
  assert.equal(calls.created[0]?.customerId, 'cust-1');
  const notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('草稿'));
  assert.ok(notice.textContent?.includes('不自动激活 License'));
  assert.ok((screen.getByTestId('contract-new-done') as HTMLButtonElement).disabled, '零设备不得完成');
  assert.ok((screen.getByTestId('contract-create-cancel') as HTMLButtonElement).disabled, '草稿阶段不得绕过关联离开');
  assert.ok(screen.getByTestId('contract-new-device-required').textContent?.includes('至少关联一台'));

  // 第二步：eligible 列表选择并关联
  assert.deepEqual(calls.listed, ['con-new']);
  await user.click(screen.getByTestId('contract-new-device-dev-100'));
  await user.type(screen.getByTestId('contract-bind-reason'), '交付安装');
  await user.click(screen.getByTestId('contract-bind-submit'));
  assert.deepEqual(calls.bound, [{ contractId: 'con-new', deviceIds: ['dev-100'], reason: '交付安装' }]);
  assert.equal((screen.getByTestId('contract-new-done') as HTMLButtonElement).disabled, false);
  await user.click(screen.getByTestId('contract-new-done'));
  assert.equal(calls.done, 1);
});

test('新建：编号重复 409 → 明确错误呈现', async () => {
  const user = userEvent.setup();
  renderNew({
    onCreate: async () => {
      throw new ApiClientError(409, 'CONFLICT', 'contractNumber 已存在', 'req-dup');
    },
  });
  await user.type(screen.getByTestId('contract-number-input'), 'HT-2026-001');
  await user.type(screen.getByTestId('contract-name-input'), '重复编号');
  await user.selectOptions(screen.getByTestId('contract-customer-select'), 'cust-1');
  fireEvent.change(screen.getByTestId('contract-start-input'), { target: { value: '2026-10-01T00:00' } });
  fireEvent.change(screen.getByTestId('contract-end-input'), { target: { value: '2027-10-01T00:00' } });
  await user.click(screen.getByTestId('contract-create-submit'));
  const error = await screen.findByTestId('error-generic');
  assert.ok(error.textContent?.includes('contractNumber 已存在'));
  assert.ok(screen.getByText('requestId：req-dup'));
});

// ---------- 详情 ----------

function renderDetail(overrides: Partial<ContractDetailPageProps> = {}) {
  const calls = {
    edited: [] as { input: ContractUpdateInput; version: number }[],
    activated: [] as { reason: string; version: number }[],
    renewed: [] as { newEndAt: string; reason: string; version: number }[],
    terminated: [] as { reason: string; version: number }[],
    bound: [] as { deviceIds: readonly string[]; reason: string }[],
    unbound: [] as { deviceIds: readonly string[]; reason: string }[],
    listedAvailable: 0,
    refreshed: 0,
  };
  const contract = makeContract();
  const props: ContractDetailPageProps = {
    role: 'PlatformSuperAdmin',
    contract,
    customerName: '绿洲酒店集团',
    devices: { rows: [makeDeviceDetail()] },
    associations: [makeDeviceDetail().association as ContractDeviceAssociationView],
    licenses: {
      'dev-001': {
        licenseId: 'lic-1',
        status: 'Active',
        validFrom: '2026-01-01',
        validTo: '2027-01-01',
        entitlements: ['REMOTE_CONTROL'],
      },
    },
    onListAvailable: async () => {
      calls.listedAvailable += 1;
      return [makeAvailable()];
    },
    onEdit: async (input, version) => {
      calls.edited.push({ input, version });
      return { ...contract, version: version + 1 };
    },
    onActivate: async (reason, version) => {
      calls.activated.push({ reason, version });
      return { ...contract, status: 'EFFECTIVE', derivedStatus: 'EFFECTIVE' };
    },
    onRenew: async (newEndAt, reason, version) => {
      calls.renewed.push({ newEndAt, reason, version });
      return { ...contract, endAt: newEndAt, version: version + 1 };
    },
    onTerminate: async (reason, version) => {
      calls.terminated.push({ reason, version });
      return { ...contract, status: 'TERMINATED', derivedStatus: 'TERMINATED' };
    },
    onBind: async (deviceIds, reason) => {
      calls.bound.push({ deviceIds, reason });
      return [...deviceIds];
    },
    onUnbind: async (deviceIds, reason) => {
      calls.unbound.push({ deviceIds, reason });
      return [...deviceIds];
    },
    onBack: () => {},
    onRefresh: () => {
      calls.refreshed += 1;
    },
    ...overrides,
  };
  const utils = render(<ContractDetailPage {...props} />);
  return { calls, contract, unmount: utils.unmount };
}

test('详情：信息渲染（contact 最小权限）、设备表四轴与 License 并列（标签不同）', () => {
  const { unmount } = renderDetail();
  assert.ok(screen.getByText('绿洲酒店集团'));
  assert.ok(screen.getByText('ops@oasis.example.com'));
  assert.equal(screen.getByTestId('contract-detail-status').textContent, '生效中');
  assert.ok(screen.getByTestId('contract-detail-version').textContent?.includes('v3'));
  // 设备表：区域/子区域/站点/固件/别名/四轴
  assert.ok(screen.getByText('华东'));
  assert.ok(screen.getByText('上海'));
  assert.ok(screen.getByText('1.2.3'));
  assert.ok(screen.getByText('厨房一号'));
  assert.ok(screen.getByTestId('contract-device-axes-dev-001'));
  // License 独立展示（授权状态 ≠ 合约状态标签）
  assert.ok(screen.getByTestId('license-summary').textContent?.includes('授权有效'));
  unmount();

  // Auditor 视角：contact 为 null → 最小权限提示，不伪造
  renderDetail({ role: 'Auditor', contract: makeContract({ contact: null }) });
  assert.ok(screen.getByTestId('contract-detail-contact').textContent?.includes('最小权限不可见'));
});

test('详情：动作矩阵门控（DRAFT 无续约；TERMINATED 全禁；Operator 无写权限）', () => {
  const { unmount } = renderDetail({ contract: makeContract({ status: 'DRAFT', derivedStatus: 'DRAFT' }) });
  assert.equal((screen.getByTestId('contract-edit-open') as HTMLButtonElement).disabled, false);
  assert.equal((screen.getByTestId('contract-activate-open') as HTMLButtonElement).disabled, false);
  assert.equal((screen.getByTestId('contract-renew-open') as HTMLButtonElement).disabled, true);
  unmount();

  const { unmount: unmount2 } = renderDetail({
    contract: makeContract({ status: 'TERMINATED', derivedStatus: 'TERMINATED' }),
  });
  for (const id of [
    'contract-edit-open',
    'contract-activate-open',
    'contract-renew-open',
    'contract-terminate-open',
    'contract-bind-open',
  ]) {
    assert.equal((screen.getByTestId(id) as HTMLButtonElement).disabled, true, id);
  }
  unmount2();

  renderDetail({ role: 'PlatformOperator' });
  const edit = screen.getByTestId('contract-edit-open') as HTMLButtonElement;
  assert.equal(edit.disabled, true);
  assert.ok(edit.title.includes('contract:write'));
  assert.equal(gateContractAction('edit', 'EFFECTIVE', 'Auditor'), '需要合约写权限（contract:write：仅平台管理员）');
});

test('详情：编辑携带 version（If-Match）+ 强制原因；EFFECTIVE 不可改有效期', async () => {
  const user = userEvent.setup();
  const { calls } = renderDetail();
  await user.click(screen.getByTestId('contract-edit-open'));
  const form = screen.getByTestId('contract-edit-form');
  // 非 DRAFT：有效期字段不渲染
  assert.equal(within(form).queryByTestId('contract-edit-start'), null);
  await user.clear(within(form).getByTestId('contract-edit-name'));
  await user.type(within(form).getByTestId('contract-edit-name'), '改名合约');
  await user.type(within(form).getByTestId('contract-edit-reason'), '客户要求更名');
  await user.click(within(form).getByTestId('contract-edit-submit'));
  assert.equal(calls.edited.length, 1);
  assert.equal(calls.edited[0]?.version, 3);
  assert.equal(calls.edited[0]?.input.name, '改名合约');
  assert.equal(calls.edited[0]?.input.reason, '客户要求更名');
  assert.equal('startAt' in calls.edited[0]!.input, false);
});

test('详情：续约校验（newEndAt 须晚于当前）+ 提交；激活/终止强制原因确认', async () => {
  const user = userEvent.setup();
  const { calls } = renderDetail();
  // 续约：不晚于当前 → 字段错误
  await user.click(screen.getByTestId('contract-renew-open'));
  const form = screen.getByTestId('contract-renew-form');
  await user.type(within(form).getByTestId('contract-renew-end'), '2026-06-01T00:00:00Z');
  assert.ok(within(form).getByTestId('contract-renew-error').textContent?.includes('晚于'));
  assert.equal((within(form).getByTestId('contract-renew-submit') as HTMLButtonElement).disabled, true);
  assert.ok(validateRenew('2026-06-01T00:00:00Z', '2027-01-01T00:00:00Z')?.includes('晚于'));
  await user.clear(within(form).getByTestId('contract-renew-end'));
  await user.click(within(form).getByTestId('contract-renew-end'));
  await user.paste('2028-01-01T00:00:00Z');
  await user.type(within(form).getByTestId('contract-renew-reason'), '客户续约两年');
  await user.click(within(form).getByTestId('contract-renew-submit'));
  assert.deepEqual(calls.renewed, [{ newEndAt: '2028-01-01T00:00:00Z', reason: '客户续约两年', version: 3 }]);
  const notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('不自动续期 License'));

  // 激活（DRAFT 合约）：强制原因
  cleanup();
  const { calls: calls2 } = renderDetail({ contract: makeContract({ status: 'DRAFT', derivedStatus: 'DRAFT' }) });
  await user.click(screen.getByTestId('contract-activate-open'));
  const dialog = screen.getByTestId('confirm-dialog');
  await user.type(within(dialog).getByRole('textbox', { name: '操作原因' }), '审核通过');
  await user.click(within(dialog).getByText('确认激活'));
  assert.deepEqual(calls2.activated, [{ reason: '审核通过', version: 3 }]);
});

test('详情：绑定 eligible 设备（重叠租期 409 呈现）；解绑不撤销 License（License 展示不变）', async () => {
  const user = userEvent.setup();
  const { calls } = renderDetail();
  // 绑定
  await user.click(screen.getByTestId('contract-bind-open'));
  assert.equal(calls.listedAvailable, 1);
  await user.click(await screen.findByTestId('contract-bind-check-dev-100'));
  await user.type(screen.getByTestId('contract-bind-reason'), '扩容');
  await user.click(screen.getByTestId('contract-bind-submit'));
  assert.deepEqual(calls.bound, [{ deviceIds: ['dev-100'], reason: '扩容' }]);

  // 解绑：License 摘要保持 Active（前端不擅自变更）
  await user.click(screen.getByTestId('contract-unbind-check-dev-001'));
  await user.click(screen.getByTestId('contract-unbind-open'));
  const dialog = screen.getByTestId('confirm-dialog');
  assert.ok(dialog.textContent?.includes('不撤销 License'));
  await user.type(within(dialog).getByRole('textbox', { name: '操作原因' }), '设备迁移');
  await user.click(within(dialog).getByText('确认解绑'));
  assert.deepEqual(calls.unbound, [{ deviceIds: ['dev-001'], reason: '设备迁移' }]);
  const notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('不撤销 License'));
  assert.ok(screen.getByTestId('license-summary').textContent?.includes('授权有效'));

  // 绑定 409（重叠租期）→ 错误呈现
  cleanup();
  renderDetail({
    onBind: async () => {
      throw new ApiClientError(409, 'CONFLICT', '设备存在重叠租期的有效关联', 'req-ov');
    },
  });
  await user.click(screen.getByTestId('contract-bind-open'));
  await user.click(await screen.findByTestId('contract-bind-check-dev-100'));
  await user.type(screen.getByTestId('contract-bind-reason'), '扩容');
  await user.click(screen.getByTestId('contract-bind-submit'));
  const error = await screen.findByTestId('error-generic');
  assert.ok(error.textContent?.includes('重叠租期'));
});

// ---------- API 装配 ----------

function stubApi(): { api: ApiClient; calls: { path: string; options: ApiRequestOptions }[] } {
  const calls: { path: string; options: ApiRequestOptions }[] = [];
  const api: ApiClient = {
    request: async <T,>(path: string, options: ApiRequestOptions = {}) => {
      calls.push({ path, options });
      return { data: { bound: [], unbound: [] }, meta: {} } as T;
    },
  };
  return { api, calls };
}

test('API 装配：If-Match 乐观锁与请求体快照', async () => {
  const { api, calls } = stubApi();
  await listContracts(api, { status: 'EXPIRED', customerId: 'cust-1' });
  assert.equal(calls[0]?.path, '/admin/contracts?status=EXPIRED&customerId=cust-1');

  await updateContract(api, 'con-1', { name: 'x', reason: 'r' }, 3);
  assert.equal(calls[1]?.path, '/admin/contracts/con-1');
  assert.equal(calls[1]?.options.method, 'PATCH');
  assert.equal(calls[1]?.options.ifMatch, 3);
  assert.deepEqual(calls[1]?.options.body, { name: 'x', reason: 'r' });

  await renewContract(api, 'con-1', '2028-01-01T00:00:00Z', '续约', 4);
  assert.equal(calls[2]?.path, '/admin/contracts/con-1/renew');
  assert.equal(calls[2]?.options.ifMatch, 4);
  assert.deepEqual(calls[2]?.options.body, { newEndAt: '2028-01-01T00:00:00Z', reason: '续约' });

  await bindContractDevices(api, 'con-1', ['d1', 'd2'], '扩容');
  assert.equal(calls[3]?.path, '/admin/contracts/con-1/devices/bind');
  assert.deepEqual(calls[3]?.options.body, { deviceIds: ['d1', 'd2'], reason: '扩容' });

  await unbindContractDevices(api, 'con-1', ['d1'], '迁移');
  assert.equal(calls[4]?.path, '/admin/contracts/con-1/devices/unbind');
  assert.deepEqual(calls[4]?.options.body, { deviceIds: ['d1'], reason: '迁移' });
});
