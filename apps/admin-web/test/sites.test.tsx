// @vitest-environment jsdom
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError } from '../src/api/errors.js';
import { SitesPage } from '../src/pages/sites/SitesPage.js';
import type { SitesPageProps } from '../src/pages/sites/SitesPage.js';
import { isValidTimeZone, validateSiteInput } from '../src/pages/sites/sites-state.js';
import type { SiteInput, SiteView } from '../src/pages/sites/types.js';

afterEach(cleanup);

const SITE: SiteView = {
  id: 'site-1',
  customerId: 'cust-1',
  name: '一号站点',
  status: 'ACTIVE',
  region: '华东',
  subregion: '上海',
  address: '浦东新区 100 号',
  timezone: 'Asia/Shanghai',
  contactName: '张三',
  contactPhone: '13800000000',
  contactEmail: 'zhang@example.com',
  deviceCount: 5,
  version: 2,
  createdAt: '2026-09-01T02:00:00Z',
  updatedAt: '2026-09-05T02:00:00Z',
};

function renderPage(overrides: Partial<SitesPageProps> = {}) {
  const calls = {
    created: [] as { customerId: string; input: SiteInput }[],
    updated: [] as { site: SiteView; input: SiteInput }[],
    deactivated: [] as { site: SiteView; reason: string }[],
    refreshed: [] as null[],
    filters: [] as SitesPageProps['filters'][],
  };
  const props: SitesPageProps = {
    list: { rows: [SITE], nextCursor: null },
    filters: { customerId: null, region: null, subregion: null, status: null },
    onFilterChange: (f) => calls.filters.push(f),
    onLoadMore: () => {},
    onRefresh: () => {
      calls.refreshed.push(null);
    },
    customerOptions: [{ value: 'cust-1', label: '示例客户' }],
    canWrite: true,
    onCreate: async (customerId, input) => {
      calls.created.push({ customerId, input });
      return { ...SITE, id: 'site-2', customerId, name: input.name };
    },
    onUpdate: async (site, input) => {
      calls.updated.push({ site, input });
      return { ...site, name: input.name, version: site.version + 1 };
    },
    onDeactivate: async (site, reason) => {
      calls.deactivated.push({ site, reason });
      return { ...site, status: 'SUSPENDED' };
    },
    ...overrides,
  };
  const utils = render(<SitesPage {...props} />);
  return { ...calls, unmount: utils.unmount };
}

test('列表：Region/Subregion/时区/联系人/设备数/状态列完整；筛选可变更', async () => {
  const user = userEvent.setup();
  const calls = renderPage();
  const table = screen.getByRole('table', { name: '站点列表' });
  for (const text of ['一号站点', '华东', '上海', 'Asia/Shanghai', '张三', '5', '正常']) {
    assert.ok(table.textContent?.includes(text), `列表缺少 ${text}`);
  }
  await user.selectOptions(screen.getByLabelText('所属客户'), 'cust-1');
  assert.equal(calls.filters[0]?.customerId, 'cust-1');
});

test('详情：地址/时区/联系人/设备数完整展示', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByTestId('detail-site-1'));
  const detail = screen.getByTestId('site-detail');
  for (const text of ['浦东新区 100 号', 'Asia/Shanghai', '13800000000', 'zhang@example.com']) {
    assert.ok(detail.textContent?.includes(text), `详情缺少 ${text}`);
  }
  assert.equal(screen.getByTestId('site-device-count').textContent, '5');
});

test('创建：非法时区客户端拦截不提交；合法输入提交成功', async () => {
  const user = userEvent.setup();
  const calls = renderPage();
  await user.click(screen.getByTestId('create-site'));
  const form = screen.getByTestId('site-form');
  await user.selectOptions(within(form).getByLabelText('所属客户'), 'cust-1');
  await user.type(screen.getByLabelText('站点名称'), '二号站点');
  const tz = screen.getByLabelText('时区（IANA）');
  await user.clear(tz);
  await user.type(tz, 'Mars/Olympus');
  await user.click(screen.getByRole('button', { name: '保存' }));
  // 非法时区：内联错误且不调用后端
  assert.ok(screen.getByTestId('error-timezone').textContent?.includes('非法时区'));
  assert.equal(calls.created.length, 0);

  await user.clear(tz);
  await user.type(tz, 'Asia/Shanghai');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(calls.created.length, 1));
  assert.equal(calls.created[0]?.customerId, 'cust-1');
  assert.equal(calls.created[0]?.input.timezone, 'Asia/Shanghai');
});

test('编辑：customerId 不可变（只读展示）；提交携带当前 version', async () => {
  const user = userEvent.setup();
  const calls = renderPage();
  await user.click(screen.getByTestId('detail-site-1'));
  await user.click(screen.getByTestId('edit-site'));
  assert.ok(screen.getByTestId('site-customer-readonly').textContent?.includes('创建后不可变'));
  assert.equal(within(screen.getByTestId('site-form')).queryByLabelText('所属客户'), null);
  const name = screen.getByLabelText('站点名称');
  await user.clear(name);
  await user.type(name, '一号站点（改）');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(calls.updated.length, 1));
  assert.equal(calls.updated[0]?.site.version, 2);
  assert.equal(calls.updated[0]?.input.name, '一号站点（改）');
});

test('停用：展示关联设备数提示；原因必填；409 版本冲突提示刷新', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPage();
  await user.click(screen.getByTestId('detail-site-1'));
  await user.click(screen.getByTestId('deactivate-site'));
  const dialog = screen.getByRole('dialog', { name: '停用站点' });
  assert.ok(dialog.textContent?.includes('关联设备 5 台'));
  assert.ok((screen.getByRole('button', { name: '确认停用' }) as HTMLButtonElement).disabled);
  unmount();

  renderPage({
    onDeactivate: async () => {
      throw new ApiClientError(409, 'VERSION_CONFLICT', 'modified', 'req-409');
    },
  });
  await user.click(screen.getByTestId('detail-site-1'));
  await user.click(screen.getByTestId('deactivate-site'));
  await user.type(screen.getByLabelText('停用原因'), '合同终止');
  await user.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => assert.ok(screen.getByTestId('error-version-conflict')));
});

test('只读角色：写操作隐藏；403 展示无权', () => {
  const { unmount } = renderPage({ canWrite: false });
  assert.equal(screen.queryByTestId('create-site'), null);
  unmount();

  renderPage({ list: { rows: null, error: new ApiClientError(403, 'FORBIDDEN', 'denied', 'r-403') } });
  assert.ok(screen.getByTestId('error-forbidden'));
});

test('sites-state：IANA 时区与邮箱校验', () => {
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);

  const base: SiteInput = {
    name: '站点',
    region: null,
    subregion: null,
    address: null,
    timezone: 'UTC',
    contactName: null,
    contactPhone: null,
    contactEmail: null,
  };
  assert.deepEqual(validateSiteInput(base), {});
  assert.ok(validateSiteInput({ ...base, name: '' }).name !== undefined);
  assert.ok(validateSiteInput({ ...base, timezone: 'Bad/Zone' }).timezone !== undefined);
  assert.ok(validateSiteInput({ ...base, contactEmail: 'not-an-email' }).contactEmail !== undefined);
  assert.deepEqual(validateSiteInput({ ...base, contactEmail: 'a@b.co' }), {});
});
