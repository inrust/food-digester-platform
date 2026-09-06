// @vitest-environment jsdom
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError } from '../src/api/errors.js';
import { CustomersPage } from '../src/pages/customers/CustomersPage.js';
import type { CustomersPageProps } from '../src/pages/customers/CustomersPage.js';
import type { CustomerView } from '../src/pages/customers/types.js';

afterEach(cleanup);

const CUSTOMER: CustomerView = {
  id: 'cust-1',
  name: '示例客户',
  status: 'ACTIVE',
  version: 3,
  createdAt: '2026-09-01T02:00:00Z',
  updatedAt: '2026-09-05T02:00:00Z',
};

function renderPage(overrides: Partial<CustomersPageProps> = {}) {
  const calls = {
    created: [] as { name: string }[],
    updated: [] as { customer: CustomerView; name: string }[],
    deactivated: [] as { customer: CustomerView; reason: string }[],
    refreshed: [] as null[],
  };
  const props: CustomersPageProps = {
    list: { rows: [CUSTOMER], nextCursor: null },
    statusFilter: null,
    onFilterStatus: () => {},
    onLoadMore: () => {},
    onRefresh: () => {
      calls.refreshed.push(null);
    },
    canWrite: true,
    onCreate: async (input) => {
      calls.created.push(input);
      return { ...CUSTOMER, id: 'cust-2', name: input.name };
    },
    onUpdate: async (customer, input) => {
      calls.updated.push({ customer, name: input.name });
      return { ...customer, name: input.name, version: customer.version + 1 };
    },
    onDeactivate: async (customer, reason) => {
      calls.deactivated.push({ customer, reason });
      return { ...customer, status: 'SUSPENDED' };
    },
    ...overrides,
  };
  const utils = render(<CustomersPage {...props} />);
  return { ...calls, unmount: utils.unmount };
}

test('列表与状态筛选；详情展示版本相关字段', async () => {
  const user = userEvent.setup();
  const filters: (string | null)[] = [];
  renderPage({ onFilterStatus: (s) => filters.push(s) });
  assert.ok(screen.getByRole('table', { name: '客户列表' }));
  assert.ok(screen.getByText('示例客户'));
  await user.click(screen.getByTestId('filter-SUSPENDED'));
  assert.deepEqual(filters, ['SUSPENDED']);

  await user.click(screen.getByTestId('detail-cust-1'));
  const detail = screen.getByTestId('customer-detail');
  assert.ok(detail.textContent?.includes('cust-1'));
  assert.ok(detail.textContent?.includes('正常'));
});

test('创建：名称为空禁用；提交成功后刷新', async () => {
  const user = userEvent.setup();
  const calls = renderPage();
  await user.click(screen.getByTestId('create-customer'));
  const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
  assert.ok(save.disabled);
  await user.type(screen.getByLabelText('客户名称'), '新客户公司');
  await user.click(save);
  await waitFor(() => assert.deepEqual(calls.created, [{ name: '新客户公司' }]));
  assert.equal(calls.refreshed.length, 1);
});

test('编辑：携带当前 version（If-Match 乐观锁）', async () => {
  const user = userEvent.setup();
  const calls = renderPage();
  await user.click(screen.getByTestId('detail-cust-1'));
  await user.click(screen.getByTestId('edit-customer'));
  const input = screen.getByLabelText('客户名称');
  await user.clear(input);
  await user.type(input, '改名后的客户');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(calls.updated.length, 1));
  assert.equal(calls.updated[0]?.customer.version, 3);
  assert.equal(calls.updated[0]?.name, '改名后的客户');
});

test('停用：原因必填（写审计）；成功后刷新', async () => {
  const user = userEvent.setup();
  const calls = renderPage();
  await user.click(screen.getByTestId('detail-cust-1'));
  await user.click(screen.getByTestId('deactivate-customer'));
  const confirm = screen.getByRole('button', { name: '确认停用' }) as HTMLButtonElement;
  assert.ok(confirm.disabled);
  await user.type(screen.getByLabelText('停用原因'), '合约到期');
  await user.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => assert.equal(calls.deactivated.length, 1));
  assert.equal(calls.deactivated[0]?.reason, '合约到期');
  assert.equal(calls.deactivated[0]?.customer.version, 3);
});

test('并发冲突：409 VERSION_CONFLICT 提示刷新；409 CONFLICT 展示后端原因', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPage({
    onUpdate: async () => {
      throw new ApiClientError(409, 'VERSION_CONFLICT', 'modified', 'req-409');
    },
  });
  await user.click(screen.getByTestId('detail-cust-1'));
  await user.click(screen.getByTestId('edit-customer'));
  const input = screen.getByLabelText('客户名称');
  await user.clear(input);
  await user.type(input, '并发修改');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => assert.ok(screen.getByTestId('error-version-conflict')));
  unmount();

  renderPage({
    onDeactivate: async () => {
      throw new ApiClientError(409, 'CONFLICT', '客户已是停用状态', 'req-409b');
    },
  });
  await user.click(screen.getByTestId('detail-cust-1'));
  await user.click(screen.getByTestId('deactivate-customer'));
  await user.type(screen.getByLabelText('停用原因'), '重复停用测试');
  await user.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => assert.ok(screen.getByText(/客户已是停用状态/)));
});

test('只读角色（canWrite=false）：不显示新建/编辑/停用；列表 403 显示无权', () => {
  const { unmount } = renderPage({ canWrite: false });
  assert.equal(screen.queryByTestId('create-customer'), null);
  unmount();

  renderPage({ canWrite: false, list: { rows: null, error: new ApiClientError(403, 'FORBIDDEN', 'denied', 'r-403') } });
  assert.ok(screen.getByTestId('error-forbidden'));
});
