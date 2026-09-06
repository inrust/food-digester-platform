// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, assert, test, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError, ForbiddenError } from '../src/api/errors.js';
import { ConfirmDialog } from '../src/components/ConfirmDialog.js';
import { CursorTable } from '../src/components/CursorTable.js';
import { CustomerScope } from '../src/components/CustomerScope.js';
import { classifyError, ErrorNotice } from '../src/components/ErrorNotice.js';
import { applyScopeChange, EMPTY_SCOPE_FILTER } from '../src/components/filter-state.js';
import { FourAxisBadges } from '../src/components/FourAxisBadge.js';
import { ScopeFilter } from '../src/components/ScopeFilter.js';
import { formatInTimeZone, TimeText } from '../src/components/TimeText.js';
import { toastReducer } from '../src/components/toast-store.js';
import { ToastHost, useToastQueue } from '../src/components/Toast.js';

afterEach(cleanup);

// ---------- CursorTable：加载 / 空 / 错 / 403 / 409 / stale ----------

interface Row {
  id: string;
  name: string;
}

const COLUMNS = [{ key: 'name', header: '名称', render: (row: Row) => row.name }];

test('CursorTable：加载态（role=status）', () => {
  render(<CursorTable columns={COLUMNS} rows={null} rowKey={(r) => r.id} loading ariaLabel="设备列表" />);
  assert.equal(screen.getByRole('status').textContent, '加载中…');
});

test('CursorTable：空态文案', () => {
  render(<CursorTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} ariaLabel="设备列表" emptyText="暂无设备" />);
  assert.equal(screen.getByTestId('table-empty').textContent, '暂无设备');
});

test('CursorTable：数据行渲染与游标分页（下一页携 nextCursor，无下一页时禁用）', async () => {
  const user = userEvent.setup();
  const pages: string[] = [];
  render(
    <CursorTable
      columns={COLUMNS}
      rows={[{ id: 'd1', name: '设备一' }]}
      rowKey={(r) => r.id}
      ariaLabel="设备列表"
      nextCursor="cursor-2"
      onNextPage={(cursor) => pages.push(cursor)}
      hasPrevPage={false}
    />,
  );
  assert.ok(screen.getByRole('table', { name: '设备列表' }));
  assert.ok(screen.getByText('设备一'));
  assert.equal(screen.getByRole('columnheader', { name: '名称' }).tagName, 'TH');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  assert.deepEqual(pages, ['cursor-2']);
  assert.ok((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled);
});

test('CursorTable：403 → 无权提示；409 VERSION_CONFLICT → 刷新提示（If-Match 冲突）', async () => {
  const user = userEvent.setup();
  const { unmount } = render(
    <CursorTable
      columns={COLUMNS}
      rows={null}
      rowKey={(r) => r.id}
      ariaLabel="设备列表"
      error={new ForbiddenError('FORBIDDEN', 'denied', 'req-403')}
    />,
  );
  const forbidden = screen.getByTestId('error-forbidden');
  assert.ok(forbidden.textContent?.includes('无权访问'));
  assert.ok(forbidden.textContent?.includes('req-403'));
  unmount();

  let refreshed = 0;
  render(
    <CursorTable
      columns={COLUMNS}
      rows={null}
      rowKey={(r) => r.id}
      ariaLabel="设备列表"
      error={new ApiClientError(409, 'VERSION_CONFLICT', 'modified', 'req-409')}
      onRefresh={() => {
        refreshed += 1;
      }}
    />,
  );
  const conflict = screen.getByTestId('error-version-conflict');
  assert.ok(conflict.textContent?.includes('数据已被他人修改'));
  await user.click(screen.getByRole('button', { name: '刷新' }));
  assert.equal(refreshed, 1);
});

test('CursorTable：stale 徽标 + 数据时间 + 刷新', async () => {
  const user = userEvent.setup();
  let refreshed = 0;
  render(
    <CursorTable
      columns={COLUMNS}
      rows={[{ id: 'd1', name: '设备一' }]}
      rowKey={(r) => r.id}
      ariaLabel="设备列表"
      stale
      dataUpdatedAt="2026-09-06T04:00:00Z"
      onRefresh={() => {
        refreshed += 1;
      }}
    />,
  );
  const banner = screen.getByTestId('table-stale');
  assert.ok(banner.textContent?.includes('数据可能已过期'));
  assert.ok(banner.textContent?.includes('数据时间'));
  await user.click(screen.getByRole('button', { name: '刷新' }));
  assert.equal(refreshed, 1);
});

// ---------- ConfirmDialog：标签 / Esc / 原因必填 / 焦点回收 ----------

function DialogHarness({ requireReason = true }: { requireReason?: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  return (
    <div>
      <button data-testid="trigger" onClick={() => setOpen(true)}>
        删除
      </button>
      <span data-testid="confirmed">{confirmed ?? '未确认'}</span>
      <ConfirmDialog
        open={open}
        title="删除设备用户"
        description="该操作不可恢复"
        danger
        requireReason={requireReason}
        onConfirm={(reason) => {
          setConfirmed(reason);
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

test('ConfirmDialog：原因必填（标签关联 + 确认门控）+ 确认回传原因', async () => {
  const user = userEvent.setup();
  render(<DialogHarness />);
  await user.click(screen.getByTestId('trigger'));

  const dialog = screen.getByRole('dialog', { name: '删除设备用户' });
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const reasonInput = screen.getByLabelText('操作原因');
  const confirmButton = screen.getByRole('button', { name: '确认' }) as HTMLButtonElement;
  assert.ok(confirmButton.disabled);

  await user.type(reasonInput, '离职回收权限');
  assert.ok(!confirmButton.disabled);
  await user.click(confirmButton);
  assert.equal(screen.getByTestId('confirmed').textContent, '离职回收权限');
});

test('ConfirmDialog：打开时焦点进入对话框；Esc 取消并回收焦点到触发按钮', async () => {
  const user = userEvent.setup();
  render(<DialogHarness requireReason={false} />);
  const trigger = screen.getByTestId('trigger');
  trigger.focus();
  await user.click(trigger);
  assert.equal(document.activeElement, screen.getByRole('button', { name: '确认' }));

  await user.keyboard('{Escape}');
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(document.activeElement, trigger);
});

// ---------- ScopeFilter：联动与标签 ----------

const REGIONS = [{ value: 'cn-east', label: '华东' }];
const SUBREGIONS = [
  { value: 'sh', label: '上海', region: 'cn-east' },
  { value: 'hz', label: '杭州', region: 'cn-east' },
];
const SITES = [{ value: 'site-1', label: '一号站', subregion: 'sh' }];

function FilterHarness() {
  const [value, setValue] = useState(EMPTY_SCOPE_FILTER);
  return (
    <div>
      <output data-testid="filter-value">{JSON.stringify(value)}</output>
      <ScopeFilter regions={REGIONS} subregions={SUBREGIONS} sites={SITES} value={value} onChange={setValue} />
    </div>
  );
}

test('ScopeFilter：三级联动（上游变更清空下游），标签均可用', async () => {
  const user = userEvent.setup();
  render(<FilterHarness />);
  const region = screen.getByLabelText('设备区域') as HTMLSelectElement;
  const subregion = screen.getByLabelText('设备子区域') as HTMLSelectElement;
  const site = screen.getByLabelText('站点') as HTMLSelectElement;
  assert.ok(subregion.disabled);
  assert.ok(site.disabled);

  await user.selectOptions(region, 'cn-east');
  assert.ok(!subregion.disabled);
  await user.selectOptions(subregion, 'sh');
  assert.ok(!site.disabled);
  await user.selectOptions(site, 'site-1');
  assert.equal(
    screen.getByTestId('filter-value').textContent,
    JSON.stringify({ region: 'cn-east', subregion: 'sh', siteId: 'site-1' }),
  );

  // 上游变更 → 下游清空
  await user.selectOptions(region, '');
  assert.equal(screen.getByTestId('filter-value').textContent, JSON.stringify(EMPTY_SCOPE_FILTER));
});

test('filter-state 纯逻辑：region/subregion 变更清空下游；site 变更不影响上游', () => {
  const full = { region: 'cn-east', subregion: 'sh', siteId: 'site-1' };
  assert.deepEqual(applyScopeChange(full, 'region', 'cn-north'), { region: 'cn-north', subregion: null, siteId: null });
  assert.deepEqual(applyScopeChange(full, 'subregion', 'hz'), { region: 'cn-east', subregion: 'hz', siteId: null });
  assert.deepEqual(applyScopeChange(full, 'siteId', 'site-2'), {
    region: 'cn-east',
    subregion: 'sh',
    siteId: 'site-2',
  });
});

// ---------- CustomerScope ----------

test('CustomerScope：Customer 角色只读；平台角色可切换', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<CustomerScope mode="fixed" fixedLabel="示例客户" />);
  assert.equal(screen.getByTestId('customer-scope-fixed').textContent, '所属客户：示例客户');
  unmount();

  const selected: (string | null)[] = [];
  render(
    <CustomerScope
      mode="select"
      options={[{ value: 'cust-1', label: '示例客户' }]}
      value={null}
      onChange={(id) => selected.push(id)}
    />,
  );
  await user.selectOptions(screen.getByLabelText('客户范围'), 'cust-1');
  assert.deepEqual(selected, ['cust-1']);
});

// ---------- TimeText：UTC 按用户时区显示 ----------

test('TimeText：UTC 按 Asia/Shanghai 渲染，title 保留 UTC；非法输入安全回退', () => {
  const { unmount } = render(<TimeText iso="2026-09-06T04:00:00Z" />);
  const time = screen.getByText(/12:00:00/);
  assert.equal(time.getAttribute('datetime'), '2026-09-06T04:00:00.000Z');
  assert.ok(time.getAttribute('title')?.startsWith('UTC：'));
  unmount();

  assert.equal(formatInTimeZone('not-a-date'), '—');
  assert.equal(
    formatInTimeZone('2026-09-06T04:00:00Z', 'Invalid/Zone'),
    formatInTimeZone('2026-09-06T04:00:00Z', 'UTC'),
  );
});

// ---------- FourAxisBadges：DEC-010 四轴分离 ----------

test('FourAxisBadges：四轴中文标签；未知值显示“—”不伪造', () => {
  render(
    <FourAxisBadges
      status={{ connectivity: 'ONLINE', lifecycle: 'Active', operational: 'Maintenance', license: 'Expired' }}
    />,
  );
  const host = screen.getByTestId('four-axis-badges');
  assert.ok(host.textContent?.includes('连接：在线'));
  assert.ok(host.textContent?.includes('生命周期：已激活'));
  assert.ok(host.textContent?.includes('运行：维护'));
  assert.ok(host.textContent?.includes('授权：已到期'));

  cleanup();
  render(
    <FourAxisBadges status={{ connectivity: null, lifecycle: 'SomethingNew', operational: null, license: null }} />,
  );
  const badges = screen.getAllByText(/：—/);
  assert.equal(badges.length, 4);
});

// ---------- Toast / ErrorNotice ----------

test('Toast：error 常驻（role=alert）且可手动关闭；info 到时自动消失', () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useToastQueue({ durationMs: 1000 }));
    act(() => {
      result.current.push('info', '已保存');
      result.current.push('error', '操作失败', { code: 'CONFLICT', requestId: 'r-1' });
    });
    assert.equal(result.current.toasts.length, 2);

    act(() => {
      vi.advanceTimersByTime(1100);
    });
    assert.equal(result.current.toasts.length, 1);
    assert.equal(result.current.toasts[0]?.kind, 'error');
  } finally {
    vi.useRealTimers();
  }
});

test('ToastHost：渲染 code/requestId 与关闭按钮', async () => {
  const user = userEvent.setup();
  const dismissed: number[] = [];
  render(
    <ToastHost
      toasts={[{ id: 1, kind: 'error', message: '删除失败', code: 'CONFLICT', requestId: 'r-9' }]}
      onDismiss={(id) => dismissed.push(id)}
    />,
  );
  const toast = screen.getByRole('alert');
  assert.ok(toast.textContent?.includes('CONFLICT'));
  assert.ok(toast.textContent?.includes('r-9'));
  await user.click(screen.getByRole('button', { name: '关闭提示：删除失败' }));
  assert.deepEqual(dismissed, [1]);
});

test('toastReducer：push 追加 / dismiss 移除', () => {
  const one = toastReducer([], { type: 'push', toast: { id: 1, kind: 'info', message: 'a' } });
  const two = toastReducer(one, { type: 'push', toast: { id: 2, kind: 'success', message: 'b' } });
  assert.equal(two.length, 2);
  assert.deepEqual(
    toastReducer(two, { type: 'dismiss', id: 1 }).map((t) => t.id),
    [2],
  );
});

test('ErrorNotice：分类（403/409/通用），统一展示 code/requestId', () => {
  assert.equal(classifyError(new ForbiddenError('FORBIDDEN', 'denied', 'r1')).variant, 'forbidden');
  assert.equal(classifyError(new ApiClientError(409, 'VERSION_CONFLICT', 'm', 'r2')).variant, 'version-conflict');
  assert.equal(classifyError(new ApiClientError(500, 'INTERNAL_ERROR', 'boom', 'r3')).variant, 'generic');
  assert.equal(classifyError(new Error('network')).variant, 'generic');

  render(<ErrorNotice error={new ApiClientError(500, 'INTERNAL_ERROR', '服务异常', 'r-500')} />);
  const notice = screen.getByRole('alert');
  assert.ok(notice.textContent?.includes('INTERNAL_ERROR'));
  assert.ok(notice.textContent?.includes('r-500'));
});
