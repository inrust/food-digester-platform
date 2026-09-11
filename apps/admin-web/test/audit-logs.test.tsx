// @vitest-environment jsdom
/**
 * FE-15 审计日志页测试：
 * - 筛选（actor/Customer/对象/动作/结果/时间）+ 游标分页正确；
 * - 详情显示脱敏前后值与 requestId；敏感字段前端兜底脱敏（DOM 无明文）；
 * - 只读性：页面无编辑/删除入口，API 装配仅 GET；
 * - Customer 角色无 customerId 筛选；403 → 无权界面。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ForbiddenError } from '../src/api/errors.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { AuditLogsPage } from '../src/pages/audit/AuditLogsPage.js';
import type { AuditLogsPageProps } from '../src/pages/audit/AuditLogsPage.js';
import { getAuditLogDetail, listAuditLogs } from '../src/pages/audit/audit-api.js';
import type { AuditLogListFilter } from '../src/pages/audit/audit-api.js';
import { REDACTED, formatAuditValue, sanitizeForDisplay } from '../src/pages/audit/audit-state.js';
import type { AuditLogDetailView, AuditLogView } from '../src/pages/audit/types.js';

afterEach(cleanup);

function makeLog(overrides: Partial<AuditLogView> = {}): AuditLogView {
  return {
    auditId: 'aud-001',
    actorId: 'admin@example.com',
    actorRole: 'PlatformSuperAdmin',
    customerId: 'cust-1',
    objectType: 'device',
    objectId: 'dev-001',
    action: 'device.suspend',
    result: 'SUCCESS',
    createdAt: '2026-09-06T04:00:00Z',
    ...overrides,
  };
}

function makeDetail(overrides: Partial<AuditLogDetailView> = {}): AuditLogDetailView {
  return {
    ...makeLog(),
    reason: '现场维护',
    requestId: 'req-123',
    ip: '203.0.113.10',
    userAgent: 'Mozilla/5.0',
    beforeValue: { status: 'ACTIVE' },
    afterValue: { status: 'SUSPENDED' },
    ...overrides,
  };
}

function renderPage(overrides: Partial<AuditLogsPageProps> = {}) {
  const calls = {
    filterApplied: [] as AuditLogListFilter[],
    loadMore: [] as string[],
    selected: [] as string[],
    closed: 0,
    refreshed: 0,
  };
  const props: AuditLogsPageProps = {
    role: 'PlatformSuperAdmin',
    logs: { rows: [makeLog(), makeLog({ auditId: 'aud-002', result: 'FAILURE', action: 'license.issue' })], nextCursor: 'cur-2' },
    filter: {},
    onApplyFilter: (f) => calls.filterApplied.push(f),
    onLoadMore: (cursor) => calls.loadMore.push(cursor),
    detail: { kind: 'none' },
    onSelectLog: (id) => calls.selected.push(id),
    onCloseDetail: () => {
      calls.closed += 1;
    },
    onRefresh: () => {
      calls.refreshed += 1;
    },
    ...overrides,
  };
  const utils = render(<AuditLogsPage {...props} />);
  return { calls, unmount: utils.unmount };
}

test('筛选：actor/Customer/对象/动作/结果/时间全字段回调（时间转 UTC ISO）', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.type(screen.getByTestId('audit-filter-actor'), 'admin@example.com');
  await user.type(screen.getByTestId('audit-filter-customer'), 'cust-1');
  await user.type(screen.getByTestId('audit-filter-object-type'), 'device');
  await user.type(screen.getByTestId('audit-filter-object-id'), 'dev-001');
  await user.type(screen.getByTestId('audit-filter-action'), 'device.suspend');
  await user.selectOptions(screen.getByTestId('audit-filter-result'), 'FAILURE');
  fireEvent.change(screen.getByTestId('audit-filter-from'), { target: { value: '2026-09-01T10:00' } });
  fireEvent.change(screen.getByTestId('audit-filter-to'), { target: { value: '2026-09-02T10:00' } });
  await user.click(screen.getByTestId('audit-filter-search'));

  const applied = calls.filterApplied[0];
  assert.equal(applied?.actorId, 'admin@example.com');
  assert.equal(applied?.customerId, 'cust-1');
  assert.equal(applied?.objectType, 'device');
  assert.equal(applied?.objectId, 'dev-001');
  assert.equal(applied?.action, 'device.suspend');
  assert.equal(applied?.result, 'FAILURE');
  assert.equal(applied?.from, new Date('2026-09-01T10:00').toISOString());
  assert.equal(applied?.to, new Date('2026-09-02T10:00').toISOString());
});

test('分页正确：下一页携带 nextCursor', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByRole('button', { name: '下一页' }));
  assert.deepEqual(calls.loadMore, ['cur-2']);
});

test('详情：显示脱敏前后值、requestId、原因与 IP/UA', () => {
  renderPage({ detail: { kind: 'ready', detail: makeDetail() } });
  assert.ok(screen.getByTestId('audit-detail-id').textContent?.includes('aud-001'));
  assert.ok(screen.getByTestId('audit-detail-request-id').textContent?.includes('req-123'));
  assert.ok(screen.getByTestId('audit-detail-reason').textContent?.includes('现场维护'));
  assert.ok(screen.getByTestId('audit-detail').textContent?.includes('203.0.113.10'));
  assert.ok(screen.getByTestId('audit-detail-before').textContent?.includes('ACTIVE'));
  assert.ok(screen.getByTestId('audit-detail-after').textContent?.includes('SUSPENDED'));
});

test('敏感字段不可见：明文 password/privateKey/token 前端兜底脱敏为 [REDACTED]', () => {
  renderPage({
    detail: {
      kind: 'ready',
      detail: makeDetail({
        beforeValue: { username: 'op1', password: 'plain-secret-1', nested: { privateKey: 'KEY-MATERIAL' } },
        afterValue: { apiToken: 'tok-plain-2', note: 'ok' },
      }),
    },
  });
  const before = screen.getByTestId('audit-detail-before').textContent ?? '';
  const after = screen.getByTestId('audit-detail-after').textContent ?? '';
  assert.ok(before.includes(REDACTED));
  assert.ok(after.includes(REDACTED));
  // 非敏感字段原样
  assert.ok(before.includes('op1'));
  assert.ok(after.includes('ok'));
  // 全文不含任何明文秘密
  const all = document.body.textContent ?? '';
  assert.ok(!all.includes('plain-secret-1'));
  assert.ok(!all.includes('KEY-MATERIAL'));
  assert.ok(!all.includes('tok-plain-2'));
});

test('只读性：页面无编辑/删除/修改入口；API 装配仅 GET', async () => {
  renderPage({ detail: { kind: 'ready', detail: makeDetail() } });
  const page = screen.getByTestId('audit-logs-page');
  for (const name of [/编辑/, /删除/, /修改/, /新建/, /创建/]) {
    assert.equal(
      Array.from(page.querySelectorAll('button')).some((b) => name.test(b.textContent ?? '')),
      false,
      `不应存在 ${String(name)} 按钮`,
    );
  }
  // 详情 Modal 同样无写入口
  const modal = screen.getByTestId('audit-detail-modal');
  assert.equal(modal.querySelectorAll('button').length, 0);

  const { api, calls } = stubApi();
  await listAuditLogs(api, { actorId: 'a1', result: 'SUCCESS' });
  await getAuditLogDetail(api, 'aud-1');
  assert.equal(calls[0]?.options.method, undefined);
  assert.equal(calls[1]?.options.method, undefined);
});

test('Customer 角色无 customerId 筛选；列表 403 → 无权界面', () => {
  const { unmount } = renderPage({ role: 'CustomerAdmin' });
  assert.equal(screen.queryByTestId('audit-filter-customer'), null);
  unmount();
  renderPage({ logs: { rows: null, error: new ForbiddenError('FORBIDDEN', 'denied', 'req-9') } });
  assert.ok(screen.getByTestId('error-forbidden'));
});

test('脱敏纯逻辑：嵌套对象/数组/非敏感原样', () => {
  const sanitized = sanitizeForDisplay({
    password: 'x',
    list: [{ token: 'y', ok: 1 }],
    deep: { access_key: 'z', plain: 'v' },
  }) as Record<string, unknown>;
  assert.equal(sanitized['password'], REDACTED);
  assert.equal((sanitized['list'] as Record<string, unknown>[])[0]?.['token'], REDACTED);
  assert.equal((sanitized['list'] as Record<string, unknown>[])[0]?.['ok'], 1);
  assert.equal((sanitized['deep'] as Record<string, unknown>)['access_key'], REDACTED);
  assert.equal((sanitized['deep'] as Record<string, unknown>)['plain'], 'v');
  assert.equal(formatAuditValue(null), '无');
  assert.ok(formatAuditValue({ secret: 's' }).includes(REDACTED));
});

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

test('API 装配：listAuditLogs 查询串；detail 路径', async () => {
  const { api, calls } = stubApi();
  await listAuditLogs(
    api,
    { actorId: 'a1', customerId: 'c1', objectType: 'device', objectId: 'd1', action: 'device.suspend', result: 'FAILURE', from: '2026-09-01T00:00:00Z', to: null },
    'cur-1',
  );
  assert.equal(
    calls[0]?.path,
    '/admin/audit-logs?actorId=a1&customerId=c1&objectType=device&objectId=d1&action=device.suspend&result=FAILURE&from=2026-09-01T00%3A00%3A00Z&cursor=cur-1',
  );
  await getAuditLogDetail(api, 'aud-1');
  assert.equal(calls[1]?.path, '/admin/audit-logs/aud-1');
});
