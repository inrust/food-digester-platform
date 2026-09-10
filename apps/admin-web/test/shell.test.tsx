// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { Role } from '@fdp/auth';
import { AppShell } from '../src/shell/AppShell.js';
import { TimeZoneProvider } from '../src/components/TimeText.js';
import type { SessionSnapshot } from '../src/session/session-manager.js';

afterEach(cleanup);

function sessionOf(role: Role): SessionSnapshot {
  const customerId = role === 'CustomerAdmin' || role === 'CustomerViewer' ? 'cust-1' : null;
  return { username: 'zhang@example.com', roles: [role], customerId };
}

function renderShell(options: { path?: string; role?: Role; notificationCount?: number } = {}) {
  const navigated: string[] = [];
  let loggedOut = 0;
  const utils = render(
    <TimeZoneProvider>
      <AppShell
        path={options.path ?? '/dashboard'}
        session={sessionOf(options.role ?? 'PlatformSuperAdmin')}
        {...(options.notificationCount !== undefined ? { notificationCount: options.notificationCount } : {})}
        onNavigate={(path) => navigated.push(path)}
        onLogout={() => {
          loggedOut += 1;
        }}
      >
        <div>页面内容</div>
      </AppShell>
    </TimeZoneProvider>,
  );
  return { ...utils, navigated, isLoggedOut: () => loggedOut > 0 };
}

test('菜单按角色过滤：PlatformSuperAdmin 见全部 15 项；CustomerViewer 不见受限项', () => {
  const { unmount } = renderShell({ role: 'PlatformSuperAdmin' });
  for (const label of [
    '概览',
    '查看设备',
    '操作设备',
    '设备群管理',
    '配置管理',
    '耗材查看',
    '告警与事件',
    'ESG概览',
    '设备ESG信息',
    '合约查询及修改',
    '授权管理',
    '用户管理',
    '客户管理',
    '站点管理',
    '设备用户',
  ]) {
    assert.ok(screen.getByRole('link', { name: label }), `缺少菜单项 ${label}`);
  }
  unmount();

  renderShell({ role: 'CustomerViewer' });
  for (const label of [
    '概览',
    '查看设备',
    '设备群管理',
    '耗材查看',
    '告警与事件',
    'ESG概览',
    '设备ESG信息',
    '站点管理',
  ]) {
    assert.ok(screen.getByRole('link', { name: label }));
  }
  for (const label of ['操作设备', '配置管理', '合约查询及修改', '授权管理', '用户管理', '客户管理', '设备用户']) {
    assert.equal(screen.queryByRole('link', { name: label }), null, `${label} 应对 CustomerViewer 隐藏`);
  }
  // 空分组（合约管理）整体隐藏
  assert.equal(screen.queryByRole('button', { name: /合约管理/ }), null);
});

test('分组可折叠：点击分组按钮切换 aria-expanded 与子菜单可见性', async () => {
  const user = userEvent.setup();
  renderShell({ role: 'PlatformSuperAdmin' });
  const toggle = screen.getByTestId('menu-group-device');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const subMenu = document.getElementById('submenu-device');
  assert.ok(subMenu !== null && !subMenu.hidden);

  await user.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(subMenu.hidden);

  await user.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
});

test('菜单展开/路由/面包屑一致：当前页 aria-current，面包屑含分组与页面', async () => {
  const user = userEvent.setup();
  const { navigated } = renderShell({ path: '/contracts', role: 'Auditor' });
  assert.equal(screen.getByRole('link', { name: '合约查询及修改' }).getAttribute('aria-current'), 'page');

  const breadcrumb = screen.getByRole('navigation', { name: '面包屑' });
  const text = breadcrumb.textContent ?? '';
  assert.ok(text.includes('合约管理'));
  assert.ok(text.includes('合约查询及修改'));
  // 当前页为纯文本（aria-current），无链接
  assert.equal(breadcrumb.querySelector('li[aria-current="page"]')?.textContent, '合约查询及修改');

  // 点击菜单导航
  await user.click(screen.getByRole('link', { name: 'ESG概览' }));
  assert.deepEqual(navigated, ['/esg/overview']);
});

test('子页面面包屑：分组 → 父菜单（可点回链）→ 当前页', async () => {
  const user = userEvent.setup();
  const { navigated } = renderShell({ path: '/contracts/new', role: 'PlatformSuperAdmin' });
  const breadcrumb = screen.getByRole('navigation', { name: '面包屑' });
  const items = [...breadcrumb.querySelectorAll('li')].map((li) => li.textContent);
  assert.deepEqual(items, ['合约管理', '合约查询及修改', '新建合约']);
  await user.click(within(breadcrumb).getByRole('link', { name: '合约查询及修改' }));
  assert.deepEqual(navigated, ['/contracts']);
});

test('通知徽标与用户区：未读数徽标、DEC-012 角色显示名、登出', async () => {
  const user = userEvent.setup();
  const { isLoggedOut } = renderShell({ role: 'PlatformOperator', notificationCount: 3 });
  assert.equal(screen.getByTestId('notification-badge').textContent, '3');
  assert.equal(screen.getByTestId('notification-button').getAttribute('aria-label'), '通知，3 条未读');
  assert.equal(screen.getByTestId('role-tag').textContent, '设备操作员');
  assert.ok(screen.getByText('zhang@example.com'));
  await user.click(screen.getByRole('button', { name: '登出' }));
  assert.ok(isLoggedOut());
});

test('用户时区：顶部栏选择后持久化偏好', async () => {
  window.localStorage.clear();
  const user = userEvent.setup();
  renderShell();
  const selector = screen.getByLabelText('显示时区') as HTMLSelectElement;
  assert.equal(selector.value, 'Asia/Shanghai');
  await user.selectOptions(selector, 'UTC');
  assert.equal(selector.value, 'UTC');
  assert.equal(window.localStorage.getItem('fdp.admin.time-zone.v1'), 'UTC');
});

test('移动端抽屉（≤768px）：汉堡打开、遮罩关闭并回收焦点、Esc 关闭', async () => {
  const user = userEvent.setup();
  renderShell({ role: 'PlatformSuperAdmin' });
  const openButton = screen.getByTestId('drawer-open');
  const sidebar = screen.getByTestId('sidebar');
  const overlay = screen.getByTestId('drawer-overlay');
  assert.ok(!sidebar.className.includes('open'));

  await user.click(openButton);
  assert.ok(sidebar.className.includes('open'));

  // 遮罩点击关闭 + 焦点回收至汉堡按钮
  await user.click(overlay);
  assert.ok(!sidebar.className.includes('open'));
  assert.equal(document.activeElement, openButton);

  // Esc 关闭
  await user.click(openButton);
  assert.ok(sidebar.className.includes('open'));
  await user.keyboard('{Escape}');
  assert.ok(!sidebar.className.includes('open'));
  assert.equal(document.activeElement, openButton);
});

test('布局契约：shell.css 含 ≤768px 媒体查询与抽屉/遮罩规则', () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/shell/shell.css');
  const css = readFileSync(cssPath, 'utf8');
  assert.ok(css.includes('@media (max-width: 768px)'));
  assert.ok(css.includes('.sidebar.open'));
  assert.ok(css.includes('.sidebar-overlay.active'));
});
