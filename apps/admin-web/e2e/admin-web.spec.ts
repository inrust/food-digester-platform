import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import {
  seedSession,
  layoutViolations,
  dashboard,
  p0Device,
  p0Alarm,
  routeP0Apis,
  routeFe11To15Apis,
  json,
} from './qa05-api-fixtures.js';
import type { Role } from './qa05-api-fixtures.js';

test('H-01 API 拒绝停用会话后清除浏览器会话并返回登录', async ({ page }) => {
  await seedSession(page, 'CustomerViewer', { customerId: 'cust-a' });
  let refreshAttempts = 0;
  await page.route('https://cognito-idp.us-east-1.amazonaws.com/', (route) => {
    refreshAttempts += 1;
    return json(route, { __type: 'NotAuthorizedException' }, 400);
  });
  await page.route('**/api/v1/admin/dashboard/overview', (route) =>
    json(
      route,
      {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication is required or the credential is invalid',
          requestId: 'req-disabled',
        },
      },
      401,
    ),
  );
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => sessionStorage.getItem('fdp.admin.session.v1'))).toBeNull();
  expect(refreshAttempts).toBe(1);
});

test('M-01 CustomerViewer 从菜单查询设备用户详情，全部写入口隐藏', async ({ page }) => {
  await seedSession(page, 'CustomerViewer', { customerId: 'cust-a' });
  await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard, meta: {} }));
  await page.route('**/api/v1/admin/devices**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  const row = {
    deviceUserId: 'du-viewer',
    customerId: 'cust-a',
    username: 'own-device-user',
    displayName: '本租户设备用户',
    status: 'ACTIVE',
    version: 1,
    activeDeviceCount: 0,
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
  };
  const requests: { method: string; customerId: string | null }[] = [];
  await page.route('**/api/v1/admin/device-users**', (route) => {
    const url = new URL(route.request().url());
    requests.push({ method: route.request().method(), customerId: url.searchParams.get('customerId') });
    return json(route, {
      data: url.pathname.endsWith('/du-viewer') ? { ...row, assignments: [], syncStates: [] } : [row],
      meta: { nextCursor: null },
    });
  });
  await page.goto('/dashboard');
  await page.getByRole('link', { name: '设备用户', exact: true }).click();
  await expect(page).toHaveURL(/\/device-users$/);
  await expect(page.getByTestId('device-user-row-du-viewer')).toContainText('本租户设备用户');
  await page.getByTestId('device-user-detail-du-viewer').click();
  await expect(page.getByTestId('detail-version')).toHaveText('v1');
  for (const id of [
    'device-user-create',
    'device-user-edit',
    'device-user-password-reset',
    'device-user-disable',
    'device-user-assign',
    'device-user-revoke',
  ]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  expect(requests.some((request) => request.customerId === 'cust-a')).toBe(true);
  expect(requests.every((request) => request.method === 'GET')).toBe(true);
});

test('无 Token 安全回登录；五角色菜单和受限路由均由组合根守卫', async ({ qa05 }) => {
  const anonymous = await qa05.newPage();
  await anonymous.goto('/customers');
  await expect(anonymous).toHaveURL(/\/login\?returnTo=/);
  await expect(anonymous.getByRole('heading', { name: '厨余机云平台' })).toBeVisible();
  await anonymous.close();

  const cases: { role: Role; visible: string; forbidden: string }[] = [
    { role: 'PlatformSuperAdmin', visible: '客户管理', forbidden: '/not-a-route' },
    { role: 'PlatformOperator', visible: '客户管理', forbidden: '/settings' },
    { role: 'Auditor', visible: '客户管理', forbidden: '/settings' },
    { role: 'CustomerAdmin', visible: '用户管理', forbidden: '/customers' },
    { role: 'CustomerViewer', visible: '站点管理', forbidden: '/customers' },
  ];
  for (const item of cases) {
    const page = await qa05.newPage();
    await seedSession(page, item.role);
    await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard, meta: {} }));
    await page.goto('/dashboard');
    await expect(page.getByText(item.visible, { exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('redacted-refresh-token');
    await page.goto(item.forbidden);
    if (item.forbidden === '/not-a-route') await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    else await expect(page.getByRole('heading', { name: '403' })).toBeVisible();
    await page.close();
  }
});

test('刷新失败清会话，API 403 保留会话并呈现无权', async ({ qa05 }) => {
  const expiredPage = await qa05.newPage();
  await seedSession(expiredPage, 'PlatformSuperAdmin', { expired: true });
  await expiredPage.route('https://cognito-idp.us-east-1.amazonaws.com/', (route) =>
    json(route, { __type: 'NotAuthorizedException' }, 400),
  );
  await expiredPage.goto('/dashboard');
  await expect(expiredPage).toHaveURL(/\/login/);
  expect(await expiredPage.evaluate(() => sessionStorage.getItem('fdp.admin.session.v1'))).toBeNull();
  await expiredPage.close();

  const forbiddenPage = await qa05.newPage();
  await seedSession(forbiddenPage, 'PlatformSuperAdmin');
  await forbiddenPage.route('**/api/v1/admin/dashboard/overview', (route) =>
    json(route, { error: { code: 'FORBIDDEN', message: 'denied', requestId: 'req-403' } }, 403),
  );
  await forbiddenPage.goto('/dashboard');
  await expect(forbiddenPage.getByTestId('error-forbidden')).toContainText('无权访问');
  expect(await forbiddenPage.evaluate(() => sessionStorage.getItem('fdp.admin.session.v1'))).not.toBeNull();
  await forbiddenPage.close();
});

test('Customer scope 与 Dashboard 离线/无 entitlement 动作在真实浏览器失败关闭', async ({ page }) => {
  await seedSession(page, 'CustomerViewer', { customerId: 'cust-a' });
  await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard, meta: {} }));
  await page.route('**/api/v1/admin/sites**', (route) =>
    json(route, {
      data: [
        {
          id: 'site-a',
          customerId: 'cust-a',
          name: 'A 租户站点',
          region: null,
          subregion: null,
          address: null,
          timezone: 'Asia/Shanghai',
          contactName: null,
          contactPhone: null,
          contactEmail: null,
          status: 'ACTIVE',
          deviceCount: 0,
          version: 1,
          createdAt: '2026-09-10T00:00:00Z',
          updatedAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  await page.goto('/dashboard');
  await expect(page.getByTestId('action-START-dev-offline')).toBeDisabled();
  await expect(page.getByTestId('deny-START-dev-offline')).toContainText('设备离线');
  await expect(page.getByTestId('action-upgrade-dev-offline')).toBeDisabled();
  await page.goto('/sites');
  await expect(page.getByText('A 租户站点')).toBeVisible();
  await expect(page.getByTestId('create-site')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('cust-b');
});

test('Onboarding 审批双击只提交一次，展示录入来源和证书状态', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  const request = {
    requestId: 'onb-1',
    serialNumber: 'SN-1',
    submittedBy: 'DEVICE:SN-1',
    model: 'FD-100',
    hardwareVersion: 'HW-1',
    manufacturer: 'BioNexa',
    manufactureDate: '2026-09-01',
    status: 'PENDING',
    rejectReason: null,
    reviewedBy: null,
    reviewedAt: null,
    version: 1,
    createdAt: '2026-09-10T00:00:00Z',
    certificateProvisioningStatus: 'NOT_STARTED',
  };
  let approvals = 0;
  await page.route('**/api/v1/admin/devices**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/onboarding/requests**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/approve')) {
      approvals += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return json(route, {
        data: { ...request, status: 'APPROVED', version: 2, certificateProvisioningStatus: 'QUEUED' },
        meta: {},
      });
    }
    if (url.includes('?')) return json(route, { data: [request], meta: { nextCursor: null } });
    return json(route, { data: request, meta: {} });
  });
  await page.goto('/devices/groups');
  await page.getByTestId('detail-onb-1').click();
  await expect(page.getByTestId('detail-submitted-by')).toHaveText('DEVICE:SN-1');
  await expect(page.getByTestId('detail-certificate-status')).toHaveText('NOT_STARTED');
  await page.getByTestId('approve-button').click();
  await page.getByRole('button', { name: '确认批准' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => approvals).toBe(1);
});

test('Customer/Site CRUD 关键路径：创建、非法时区、关联停用提示与 409', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  const customer = {
    id: 'cust-a',
    name: '租户 A',
    status: 'ACTIVE',
    version: 1,
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  };
  let customers = [customer];
  await page.route('**/api/v1/admin/customers**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/deactivate')) {
      const updated = { ...customers.find((item) => item.id === 'cust-new')!, status: 'SUSPENDED', version: 3 };
      customers = customers.map((item) => (item.id === updated.id ? updated : item));
      return json(route, { data: updated, meta: {} });
    }
    if (route.request().method() === 'PATCH') {
      const updated = {
        ...customers.find((item) => item.id === 'cust-new')!,
        name: '新客户（已更新）',
        version: 2,
      };
      customers = customers.map((item) => (item.id === updated.id ? updated : item));
      return json(route, { data: updated, meta: {} });
    }
    if (route.request().method() === 'POST') {
      const created = { ...customer, id: 'cust-new', name: '新客户' };
      customers = [...customers, created];
      return json(route, { data: created, meta: {} }, 201);
    }
    return json(route, { data: customers, meta: { nextCursor: null } });
  });
  const site = {
    id: 'site-a',
    customerId: 'cust-a',
    name: '有关联设备站点',
    region: 'CN',
    subregion: 'SH',
    address: null,
    timezone: 'Asia/Shanghai',
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    status: 'ACTIVE',
    deviceCount: 3,
    version: 1,
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  };
  let sites = [site];
  let siteCreates = 0;
  await page.route('**/api/v1/admin/sites**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/deactivate')) {
      const updated = { ...sites.find((item) => item.id === 'site-a')!, status: 'SUSPENDED', version: 3 };
      sites = sites.map((item) => (item.id === updated.id ? updated : item));
      return json(route, { data: updated, meta: {} });
    }
    if (route.request().method() === 'PATCH') {
      const updated = { ...sites.find((item) => item.id === 'site-new')!, name: '新站点（已更新）', version: 2 };
      sites = sites.map((item) => (item.id === updated.id ? updated : item));
      return json(route, { data: updated, meta: {} });
    }
    if (route.request().method() === 'POST') {
      siteCreates += 1;
      if (siteCreates > 1) {
        return json(route, { error: { code: 'CONFLICT', message: 'Site already exists', requestId: 'req-409' } }, 409);
      }
      const created = { ...site, id: 'site-new', name: '冲突站点', deviceCount: 0 };
      sites = [...sites, created];
      return json(route, { data: created, meta: {} }, 201);
    }
    return json(route, { data: sites, meta: { nextCursor: null } });
  });

  await page.goto('/customers');
  await page.getByTestId('create-customer').click();
  await page.getByLabel('客户名称').fill('新客户');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('cell', { name: '新客户' })).toBeVisible();
  await page.getByTestId('edit-customer').click();
  await page.getByLabel('客户名称').fill('新客户（已更新）');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('customer-detail')).toContainText('新客户（已更新）');
  await page.getByTestId('deactivate-customer').click();
  await page.getByLabel('停用原因').fill('E2E deactivation');
  await page.getByRole('button', { name: '确认停用' }).click();
  await expect(page.getByTestId('customer-status')).toHaveText('已停用');

  await page.goto('/sites');
  await page.getByTestId('create-site').click();
  const siteForm = page.getByTestId('site-form');
  await siteForm.getByLabel('所属客户').selectOption('cust-a');
  await siteForm.getByLabel('站点名称').fill('冲突站点');
  await siteForm.getByLabel('时区（IANA）').fill('Mars/Olympus');
  await siteForm.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('error-timezone')).toBeVisible();
  await siteForm.getByLabel('时区（IANA）').fill('Asia/Shanghai');
  await siteForm.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('site-detail')).toContainText('冲突站点');
  await page.getByTestId('edit-site').click();
  const editSiteForm = page.getByTestId('site-form');
  await editSiteForm.getByLabel('站点名称').fill('新站点（已更新）');
  await editSiteForm.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('site-detail')).toContainText('新站点（已更新）');
  await page.getByTestId('site-detail').getByRole('button', { name: '关闭' }).click();
  await page.getByTestId('detail-site-a').click();
  await page.getByTestId('deactivate-site').click();
  await expect(page.getByRole('dialog')).toContainText('关联设备 3 台');
  await page.getByLabel('停用原因').fill('linked device review complete');
  await page.getByRole('button', { name: '确认停用' }).click();
  await expect(page.getByTestId('site-status')).toHaveText('已停用');

  await page.getByTestId('create-site').click();
  const conflictingSiteForm = page.getByTestId('site-form');
  await conflictingSiteForm.getByLabel('所属客户').selectOption('cust-a');
  await conflictingSiteForm.getByLabel('站点名称').fill('重复站点');
  await conflictingSiteForm.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('Site already exists')).toBeVisible();
});

test('1440/768/375 响应式布局、横向表格和对话框键盘边界', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  const responsiveDashboard = {
    ...dashboard,
    deviceCards: [
      {
        ...dashboard.deviceCards[0],
        deviceId: 'dev-responsive',
        serialNumber: 'SN-RESPONSIVE',
        connectivity: 'ONLINE',
        capabilities: {
          ...dashboard.deviceCards[0].capabilities,
          commands: dashboard.deviceCards[0].capabilities.commands.map((item) => ({
            ...item,
            allowed: item.command === 'START',
            denyReason: item.command === 'START' ? null : item.denyReason,
          })),
        },
      },
    ],
  };
  await page.route('**/api/v1/admin/dashboard/overview', (route) =>
    json(route, { data: responsiveDashboard, meta: {} }),
  );
  await page.route('**/api/v1/admin/customers**', (route) =>
    json(route, {
      data: [
        {
          id: 'responsive-customer',
          name: '响应式布局验证客户',
          status: 'ACTIVE',
          version: 1,
          createdAt: '2026-09-10T00:00:00Z',
          updatedAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');
  await expect(page.getByTestId('sidebar')).toBeInViewport();
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId('dashboard-baseline')).toContainText('08:00:00');
  await page.getByLabel('显示时区').selectOption('UTC');
  await expect(page.getByTestId('dashboard-baseline')).toContainText('00:00:00');
  expect(await page.evaluate(() => localStorage.getItem('fdp.admin.time-zone.v1'))).toBe('UTC');
  const desktopCards = await page.locator('.stats-grid .stat-card').count();
  expect(desktopCards).toBeGreaterThan(1);

  await page.setViewportSize({ width: 768, height: 900 });
  await expect.poll(async () => (await page.getByTestId('sidebar').boundingBox())?.x ?? 0).toBeLessThan(-200);
  await page.getByTestId('drawer-open').click();
  await expect(page.getByTestId('sidebar')).toHaveClass(/open/);
  await expect
    .poll(async () => (await page.getByTestId('sidebar').boundingBox())?.x ?? -240)
    .toBeGreaterThanOrEqual(-1);
  await page.getByTestId('drawer-overlay').click({ position: { x: 700, y: 400 } });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/customers');
  const table = page.getByTestId('cursor-table').locator('.table-scroll');
  await expect(table).toBeVisible();
  expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto('/dashboard');
  await page.getByTestId('action-START-dev-responsive').click();
  const dialog = page.getByRole('dialog', { name: '确认启动' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
  expect(
    await page
      .locator('#root')
      .evaluate((root) => root instanceof HTMLElement && root.inert && root.getAttribute('aria-hidden') === 'true'),
  ).toBe(true);
  await expect(page.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '确认下发' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '取消' })).toBeFocused();
});

test('FE-06 至 FE-10 六个生产路由可运行，并覆盖成功、空态、分页入口、时区与响应式', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/devices/view?deviceId=dev-p0');
  await expect(page.getByTestId('device-view-page')).toBeVisible();
  await expect(page.getByTestId('device-console')).toContainText('P0 设备');
  await expect(page.getByTestId('media-image')).toHaveAttribute('src', 'https://media.example.test/latest.png');
  await expect(page.getByTestId('activity-activity-p1')).toContainText('SYNC');
  await expect(page.getByTestId('device-console')).toContainText('08:00:00');
  await page.getByLabel('显示时区').selectOption('UTC');
  await expect(page.getByTestId('device-console')).toContainText('00:00:00');

  await page.goto('/devices/manage?deviceId=dev-p0');
  await expect(page.getByTestId('device-manage-page')).toContainText('P0 设备');

  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/licenses');
  await expect(page.getByTestId('licenses-page')).toBeVisible();
  await expect(page.getByRole('button', { name: '下一页' })).toBeEnabled();
  const nextPage = page.waitForRequest((request) => request.url().includes('cursor=p1-next'));
  await page.getByRole('button', { name: '下一页' }).click();
  await nextPage;
  await expect(page.getByTestId('table-empty')).toBeVisible();

  await page.goto('/configurations');
  await expect(page.getByTestId('configurations-page')).toBeVisible();
  await expect(page.getByTestId('config-empty')).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/device-users');
  await expect(page.getByTestId('device-users-page')).toBeVisible();
  await expect(page.getByText('暂无设备用户')).toBeVisible();
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto('/alarms?tab=event');
  await expect(page.getByTestId('alarms-page')).toBeVisible();
  await expect(page.getByTestId('tab-event')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('table-empty')).toBeVisible();
});

test('FE-06 至 FE-10 在 403/404、Customer scope、详情焦点与重复提交场景失败关闭', async ({ qa05 }) => {
  const forbidden = await qa05.newPage();
  await seedSession(forbidden, 'PlatformSuperAdmin');
  await forbidden.route('**/api/v1/admin/sites**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await forbidden.route('**/api/v1/admin/devices**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/console') || path.endsWith('/dev-p0'))
      return json(route, { error: { code: 'FORBIDDEN', message: 'denied', requestId: 'req-p0-403' } }, 403);
    return json(route, { data: [p0Device], meta: { nextCursor: null } });
  });
  await forbidden.goto('/devices/view?deviceId=dev-p0');
  await expect(forbidden.getByTestId('error-forbidden')).toContainText('无权访问');
  await forbidden.close();

  const missing = await qa05.newPage();
  await seedSession(missing, 'PlatformSuperAdmin');
  await missing.route('**/api/v1/admin/customers**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await missing.route('**/api/v1/admin/sites**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await missing.route('**/api/v1/admin/devices/**', (route) =>
    json(route, { error: { code: 'NOT_FOUND', message: 'device missing', requestId: 'req-p0-404' } }, 404),
  );
  await missing.goto('/devices/manage?deviceId=missing');
  await expect(missing.getByText('device missing')).toBeVisible();
  await missing.close();

  const customer = await qa05.newPage();
  await seedSession(customer, 'CustomerViewer', { customerId: 'cust-a' });
  let scopedAlarmRequest = false;
  await routeP0Apis(customer);
  await customer.route('**/api/v1/admin/alarms**', (route) => {
    scopedAlarmRequest = new URL(route.request().url()).searchParams.get('customerId') === 'cust-a';
    return json(route, { data: [], meta: { nextCursor: null } });
  });
  await customer.goto('/alarms');
  await expect(customer.getByTestId('alarms-page')).toBeVisible();
  await expect.poll(() => scopedAlarmRequest).toBe(true);
  await expect(customer.getByTestId('filter-customer')).toHaveCount(0);
  await customer.goto('/configurations');
  await expect(customer.getByRole('heading', { name: '403' })).toBeVisible();
  await customer.close();

  const action = await qa05.newPage();
  await seedSession(action, 'PlatformSuperAdmin');
  let acknowledgements = 0;
  await routeP0Apis(action, { alarmRows: true });
  await action.route('**/api/v1/admin/alarms/alarm-p0/acknowledge', async (route) => {
    acknowledgements += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return json(route, { data: { alarm: { ...p0Alarm, status: 'ACKNOWLEDGED' }, replayed: false }, meta: {} });
  });
  await action.goto('/alarms');
  const criticalRow = action.getByTestId('severity-alarm-p0').locator('xpath=ancestor::tr');
  await expect(criticalRow).toHaveClass(/severity-critical/);
  expect(await criticalRow.evaluate((row) => getComputedStyle(row.querySelector('td')!).backgroundColor)).toBe(
    'rgb(254, 243, 242)',
  );
  await action.getByTestId('filter-severity').selectOption('CRITICAL');
  await action.getByTestId('filter-search').click();
  await expect(action).toHaveURL(/severity=CRITICAL/);
  await action.goBack();
  await expect(action).not.toHaveURL(/severity=CRITICAL/);
  await action.goForward();
  await expect(action).toHaveURL(/severity=CRITICAL/);
  await action.getByTestId('alarm-detail-alarm-p0').click();
  await action.getByTestId('alarm-acknowledge').click();
  await expect(action.getByRole('dialog', { name: '确认告警' })).toBeVisible();
  await expect(action.getByLabel('确认原因')).toBeFocused();
  await action.getByLabel('确认原因').fill('P0 E2E');
  await action.getByRole('button', { name: '确认告警' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => acknowledgements).toBe(1);
  await action.close();
});

test('FE-11 至 FE-15 七个生产路由由真实控制器驱动，并覆盖媒体签发与审计详情', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeFe11To15Apis(page);

  const routes = [
    ['/esg/overview', 'esg-overview-page'],
    ['/esg/devices', 'esg-devices-page'],
    ['/devices/operate?deviceId=dev-p0', 'device-operate-page'],
    ['/ota/campaigns', 'ota-campaigns-page'],
    ['/ota/packages', 'ota-packages-page'],
    ['/media', 'media-page'],
    ['/audit-logs', 'audit-logs-page'],
  ] as const;
  for (const [path, testId] of routes) {
    await page.goto(path);
    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.locator('body')).not.toContainText('该页面尚未接入当前管理后台组合根');
  }

  await page.goto('/esg/overview');
  await page.getByTestId('esg-export-csv').click();
  await expect(page.getByTestId('esg-export-download')).toHaveAttribute('href', 'https://exports.example.test/esg.csv');

  await page.goto('/devices/operate?deviceId=dev-p0');
  await expect(page.getByTestId('quick-reboot')).toBeEnabled();
  await page.getByTestId('quick-reboot').click();
  await page.getByTestId('command-submit').click();
  await expect(page.getByTestId('action-notice')).toContainText('已受理');

  await page.goto('/ota/campaigns');
  await expect(page.getByTestId('campaign-create-open')).toBeEnabled();
  await page.getByTestId('campaign-create-open').click();
  await page.getByTestId('campaign-name').fill('E2E 灰度');
  await page.getByTestId('campaign-package').selectOption('pkg-verified');
  await page.getByTestId('campaign-device').selectOption('dev-p0');
  await page.getByTestId('campaign-create-submit').click();
  await expect(page.getByTestId('action-notice')).toContainText('首批 1 台进入灰度');

  await page.goto('/media');
  await page.getByTestId('media-open-media-fe14').click();
  await expect(page.getByTestId('media-preview-image')).toHaveAttribute('src', 'https://media.example.test/fe14.png');

  await page.goto('/ota/packages');
  await page.getByTestId('upload-session-open').click();
  const uploadForm = page.getByTestId('upload-form');
  await uploadForm.getByTestId('upload-model').fill('FD-100');
  await uploadForm.getByTestId('upload-version').fill('2.0.0');
  await uploadForm.getByTestId('upload-size').fill('4');
  await uploadForm.getByTestId('upload-sha256').fill('a'.repeat(64));
  await uploadForm.getByTestId('upload-signature').fill('signed-e2e');
  await uploadForm.getByTestId('upload-session-submit').click();
  await page
    .getByTestId('upload-file')
    .setInputFiles({ name: 'firmware.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('FDP!') });
  await page.getByTestId('upload-complete-submit').click();
  await expect(page.getByTestId('verified-result')).toContainText('可发布');

  await page.goto('/audit-logs');
  await page.getByTestId('audit-detail-audit-fe15').click();
  await expect(page.getByTestId('audit-detail-request-id')).toHaveText('req-fe15');
  await expect(page.getByTestId('audit-detail-before')).toContainText('[REDACTED]');
  await expect(page.locator('body')).not.toContainText('must-redact');
});

test('FE-11 至 FE-15 API 403 与路由角色边界在真实浏览器失败关闭', async ({ qa05 }) => {
  const denied = await qa05.newPage();
  await seedSession(denied, 'PlatformSuperAdmin');
  await denied.route('**/api/v1/admin/media**', (route) =>
    json(route, { error: { code: 'FORBIDDEN', message: 'denied', requestId: 'req-fe14-403' } }, 403),
  );
  await denied.goto('/media');
  await expect(denied.getByTestId('error-forbidden')).toContainText('无权访问');
  await denied.close();

  const customer = await qa05.newPage();
  await seedSession(customer, 'CustomerAdmin', { customerId: 'cust-a' });
  await customer.goto('/audit-logs');
  await expect(customer.getByRole('heading', { name: '403' })).toBeVisible();
  await customer.close();
});

test('FE-17 新建权限与零设备第二阶段在真实浏览器失败关闭', async ({ qa05 }) => {
  const operator = await qa05.newPage();
  await seedSession(operator, 'PlatformOperator');
  await operator.goto('/contracts/new');
  await expect(operator.getByRole('heading', { name: '403' })).toBeVisible();
  await operator.close();

  const admin = await qa05.newPage();
  await seedSession(admin, 'PlatformSuperAdmin');
  await admin.route('**/api/v1/admin/customers**', (route) =>
    json(route, {
      data: [
        {
          id: 'cust-a',
          name: '租户 A',
          status: 'ACTIVE',
          version: 1,
          createdAt: '2026-09-10T00:00:00Z',
          updatedAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  await admin.route('**/api/v1/admin/contracts**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/con-zero/available-devices')) return json(route, { data: [] });
    if (path.endsWith('/contracts') && request.method() === 'POST') {
      return json(
        route,
        {
          data: {
            contractId: 'con-zero',
            contractNumber: 'HT-E2E-ZERO',
            name: '零设备合约',
            customerId: 'cust-a',
            contact: null,
            startAt: '2026-10-01T00:00:00Z',
            endAt: '2027-10-01T00:00:00Z',
            status: 'DRAFT',
            derivedStatus: 'DRAFT',
            version: 1,
            createdBy: 'e2e-PlatformSuperAdmin',
            createdAt: '2026-09-10T00:00:00Z',
            updatedAt: '2026-09-10T00:00:00Z',
          },
        },
        201,
      );
    }
    return json(route, { data: [], meta: { nextCursor: null } });
  });

  await admin.goto('/contracts/new');
  await admin.getByTestId('contract-number-input').fill('HT-E2E-ZERO');
  await admin.getByTestId('contract-name-input').fill('零设备合约');
  await admin.getByTestId('contract-customer-select').selectOption('cust-a');
  await admin.getByTestId('contract-start-input').fill('2026-10-01T00:00');
  await admin.getByTestId('contract-end-input').fill('2027-10-01T00:00');
  await admin.getByTestId('contract-create-submit').click();

  await expect(admin.getByTestId('contract-new-devices-empty')).toBeVisible();
  await expect(admin.getByTestId('contract-new-device-required')).toContainText('至少关联一台');
  await expect(admin.getByTestId('contract-new-done')).toBeDisabled();
  await expect(admin.getByTestId('contract-create-cancel')).toBeDisabled();
  await admin.locator('a[href="/dashboard"]').click();
  await expect(admin).toHaveURL(/\/contracts\/new$/);
  await admin.close();
});

test('FE-18 Chromium 覆盖 unknown/stale、联系人按需零预载与申请状态机', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  const pii = '13800000000';
  let contactRequests = 0;
  let requestStatus: 'PENDING' | 'PROCESSING' = 'PENDING';
  let duplicateMutations = 0;
  const statusRow = {
    deviceId: 'dev-fe18',
    serialNumber: 'SN-FE18',
    model: 'FD-100',
    alias: 'FE18',
    lifecycleStatus: 'Active',
    site: { siteId: 'site-a', name: '上海站点', region: 'CN', subregion: 'SH' },
    connectivity: 'ONLINE',
    consumables: {
      CARBON_FILTER: {
        remainingPercent: 8,
        remainingDisplay: '8%',
        stale: false,
        observedAt: '2026-09-10T00:00:00Z',
        sourceMessageId: 'msg-1',
      },
      BIO_ADDITIVE: {
        remainingPercent: null,
        remainingDisplay: 'unknown',
        stale: true,
        observedAt: null,
        sourceMessageId: 'msg-2',
      },
    },
  };
  const statusRowPage2 = {
    ...statusRow,
    deviceId: 'dev-fe18-page-2',
    serialNumber: 'SN-FE18-2',
    alias: 'FE18 page 2',
  };
  const request = () => ({
    requestId: 'request-fe18',
    customerId: 'cust-a',
    deviceId: 'dev-fe18',
    consumableType: 'CARBON_FILTER',
    status: requestStatus,
    source: 'ADMIN',
    requestedBy: 'admin',
    requestedAt: '2026-09-10T00:00:00Z',
    processedBy: requestStatus === 'PROCESSING' ? 'admin' : null,
    processNote: null,
    completedAt: null,
    version: requestStatus === 'PROCESSING' ? 2 : 1,
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  });
  await page.route('**/api/v1/admin/settings/alarm.thresholds', (route) =>
    json(route, { error: { code: 'FORBIDDEN', message: 'denied', requestId: 'req-settings-403' } }, 403),
  );
  await page.route('**/api/v1/admin/consumables**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/dev-fe18/contact')) {
      contactRequests += 1;
      return json(route, { data: { name: '联系人', phone: pii, email: 'contact@example.test' } });
    }
    return url.searchParams.get('cursor') === 'cursor-fe18-2'
      ? json(route, { data: [statusRowPage2], meta: { nextCursor: null } })
      : json(route, { data: [statusRow], meta: { nextCursor: 'cursor-fe18-2' } });
  });
  await page.route('**/api/v1/admin/consumable-requests**', async (route) => {
    const httpRequest = route.request();
    const path = new URL(httpRequest.url()).pathname;
    if (path.endsWith('/request-fe18/process')) {
      duplicateMutations += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      requestStatus = 'PROCESSING';
      return json(route, { data: request() });
    }
    return json(route, { data: [request()] });
  });

  await page.goto('/consumables');
  await expect(page.getByTestId('consumables-page')).toBeVisible();
  await expect(page.getByTestId('consumable-bio-dev-fe18')).toContainText('unknown');
  await expect(page.getByTestId('consumable-bio-dev-fe18').locator('.consumable-bar')).toHaveCount(0);
  await expect(page.getByTestId('consumable-bio-dev-fe18')).toContainText('数据过期');
  expect(contactRequests).toBe(0);
  await expect(page.locator('body')).not.toContainText(pii);
  await page.getByTestId('consumable-table').getByRole('button', { name: '下一页' }).click();
  await expect(page.getByTestId('consumable-carbon-dev-fe18-page-2')).toBeVisible();
  await page.getByTestId('consumable-table').getByRole('button', { name: '上一页' }).click();
  await expect(page.getByTestId('consumable-carbon-dev-fe18')).toBeVisible();
  await page.getByTestId('consumable-contact-dev-fe18').click();
  await expect(page.getByTestId('consumable-contact-info-dev-fe18')).toContainText(pii);
  expect(contactRequests).toBe(1);

  await page.getByTestId('consumable-process-request-fe18').click();
  await page.getByTestId('consumable-action-submit').evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => duplicateMutations).toBe(1);
  await expect(page.getByTestId('consumable-request-status-request-fe18')).toContainText('处理中');
  await expect(page.getByTestId('consumable-complete-request-fe18')).toBeVisible();
});

test('FE-16 Chromium 覆盖邀请、角色、Scope、重置与设置 409 回源', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  const calls = { invite: 0, roles: 0, scope: 0, reset: 0, refresh: 0 };
  const user = {
    userId: 'usr-fe16',
    email: 'viewer@example.test',
    displayName: 'Viewer',
    status: 'ACTIVE',
    mfaEnabled: true,
    roles: ['CustomerViewer'],
    customerId: 'cust-a',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  };
  const setting = {
    key: 'alarm.thresholds',
    value: { CONSUMABLE_REMAINING_PERCENT: { warning: 10, major: 30 } },
    version: 3,
    updatedBy: 'admin',
    updatedAt: '2026-09-10T00:00:00Z',
    runtimeStatus: 'ACTIVE',
    runtimeConsumer: 'FE-18',
  };
  await page.route('**/api/v1/admin/customers**', (route) =>
    json(route, {
      data: [
        {
          id: 'cust-a',
          name: '租户 A',
          status: 'ACTIVE',
          version: 1,
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  await page.route('**/api/v1/admin/devices**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/device-users**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/users**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/roles')) {
      calls.roles += 1;
      return json(route, { data: { ...user, roles: ['CustomerAdmin'] } });
    }
    if (path.endsWith('/scope')) {
      calls.scope += 1;
      return json(route, { data: { ...user, customerId: 'cust-b' } });
    }
    if (path.endsWith('/password-reset')) {
      calls.reset += 1;
      return json(route, { data: { userId: user.userId, status: 'RESET_TRIGGERED' } });
    }
    if (request.method() === 'POST') {
      calls.invite += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      expect('password' in body).toBe(false);
      return json(
        route,
        {
          data: {
            ...user,
            userId: 'usr-invited',
            email: body['email'],
            roles: body['roles'],
            customerId: null,
            status: 'INVITED',
          },
        },
        201,
      );
    }
    calls.refresh += 1;
    return json(route, { data: [user], meta: { nextCursor: null } });
  });
  await page.route('**/api/v1/admin/settings**', (route) => {
    if (route.request().method() === 'PUT') {
      return json(
        route,
        { error: { code: 'VERSION_CONFLICT', message: 'version mismatch', requestId: 'req-fe16-409' } },
        409,
      );
    }
    return json(route, { data: [setting] });
  });

  await page.goto('/settings');
  await expect(page.getByTestId('user-roles-usr-fe16')).toBeVisible();
  await page.getByTestId('user-invite-open').click();
  await page.getByTestId('invite-email').fill('new@example.test');
  await page.getByTestId('invite-display-name').fill('New User');
  await page.getByTestId('invite-role-PlatformOperator').check();
  await page.getByTestId('invite-submit').click();
  await expect.poll(() => calls.invite).toBe(1);

  await page.getByTestId('user-roles-usr-fe16').click();
  await page.getByTestId('assign-role-CustomerViewer').uncheck();
  await page.getByTestId('assign-role-CustomerAdmin').check();
  await page.getByTestId('assign-submit').click();
  await page.getByTestId('confirm-dialog').getByRole('button').last().click();
  await expect.poll(() => calls.roles).toBe(1);
  await expect(page.getByTestId('user-roles-form')).toHaveCount(0);
  await expect(page.getByTestId('user-scope-usr-fe16')).toBeEnabled();

  await page.getByTestId('user-scope-usr-fe16').click();
  await page.getByTestId('scope-customer').fill('cust-b');
  await page.getByTestId('scope-submit').click();
  await expect.poll(() => calls.scope).toBe(1);

  await page.getByTestId('user-reset-usr-fe16').click();
  await page.getByTestId('confirm-dialog').getByRole('button').last().click();
  await expect.poll(() => calls.reset).toBe(1);

  await page.getByTestId('tab-business-settings').click();
  await page.getByTestId('setting-edit-alarm.thresholds').click();
  await page.getByTestId('setting-submit').click();
  await expect(page.getByTestId('error-version-conflict')).toContainText('数据已被他人修改');
  const beforeRefresh = calls.refresh;
  await page.getByTestId('error-version-conflict').getByRole('button', { name: '刷新' }).click();
  await expect.poll(() => calls.refresh).toBeGreaterThan(beforeRefresh);
});

test('FE-17 Chromium 覆盖绑定、解绑、续约与终止并保留 License 边界', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await page.route('**/api/v1/admin/devices**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  const calls = { bind: 0, unbind: 0, renew: 0, terminate: 0 };
  const contract = {
    contractId: 'con-fe17',
    contractNumber: 'HT-FE17',
    name: 'FE17 Contract',
    customerId: 'cust-a',
    contact: 'ops@example.test',
    startAt: '2026-01-01T00:00:00Z',
    endAt: '2027-01-01T00:00:00Z',
    status: 'EFFECTIVE',
    derivedStatus: 'EFFECTIVE',
    version: 3,
    createdBy: 'admin',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  };
  const association = {
    associationId: 'assoc-fe17',
    deviceId: 'dev-bound',
    customerId: 'cust-a',
    validFrom: '2026-01-01T00:00:00Z',
    validTo: '2027-01-01T00:00:00Z',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00Z',
    endedAt: null,
  };
  const device = {
    deviceId: 'dev-bound',
    serialNumber: 'SN-BOUND',
    model: 'FD-100',
    alias: '已绑定设备',
    firmwareVersion: '1.2.3',
    site: { name: '上海站点', region: 'CN', subregion: 'SH' },
    lifecycleStatus: 'Active',
    operationalStatus: 'Active',
    connectivity: 'ONLINE',
    licenseStatus: 'Active',
    lastHeartbeatAt: '2026-09-10T00:00:00Z',
  };
  await page.route('**/api/v1/admin/customers**', (route) =>
    json(route, {
      data: [
        {
          id: 'cust-a',
          name: '租户 A',
          status: 'ACTIVE',
          version: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  const license = {
    licenseId: 'lic-fe17',
    deviceId: 'dev-bound',
    customerId: 'cust-a',
    status: 'Active',
    validFrom: '2026-01-01',
    validTo: '2027-01-01',
    entitlements: [{ code: 'REMOTE_CONTROL', enabled: true }],
    signature: 'v1.sig',
    version: 1,
    effective: true,
    createdBy: 'admin',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  };
  await page.route('**/api/v1/admin/licenses**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/lic-fe17/history')) return json(route, { data: [] });
    if (path.endsWith('/lic-fe17')) return json(route, { data: license });
    return json(route, { data: [license], meta: { nextCursor: null } });
  });
  await page.route('**/api/v1/admin/contracts/con-fe17**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/available-devices'))
      return json(route, {
        data: [
          {
            deviceId: 'dev-available',
            serialNumber: 'SN-AVAILABLE',
            model: 'FD-100',
            alias: '可绑定设备',
            lifecycleStatus: 'Onboarded',
            site: { name: '上海站点', region: 'CN', subregion: 'SH' },
          },
        ],
      });
    if (path.endsWith('/devices/bind')) {
      calls.bind += 1;
      return json(route, { data: { bound: ['dev-available'] } });
    }
    if (path.endsWith('/devices/unbind')) {
      calls.unbind += 1;
      return json(route, { data: { unbound: ['dev-bound'] } });
    }
    if (path.endsWith('/devices')) return json(route, { data: [{ association, device }] });
    if (path.endsWith('/associations')) return json(route, { data: [association] });
    if (path.endsWith('/renew')) {
      calls.renew += 1;
      return json(route, { data: { ...contract, endAt: '2028-01-01T00:00:00Z', version: 4 } });
    }
    if (path.endsWith('/terminate')) {
      calls.terminate += 1;
      return json(route, { data: { ...contract, status: 'TERMINATED', derivedStatus: 'TERMINATED', version: 4 } });
    }
    return json(route, { data: contract });
  });

  await page.goto('/contracts/detail?contractId=con-fe17');
  await expect(page.getByTestId('contract-detail-page')).toContainText('HT-FE17');
  await expect(page.getByTestId('license-summary')).toContainText('授权有效');
  await page.getByTestId('license-summary-open').click();
  await expect(page).toHaveURL(/\/licenses\?licenseId=lic-fe17$/);
  await expect(page.getByTestId('license-id')).toContainText('lic-fe17');
  await page.goto('/contracts/detail?contractId=con-fe17');
  await page.getByTestId('contract-bind-open').click();
  await page.getByTestId('contract-bind-check-dev-available').check();
  await page.getByTestId('contract-bind-reason').fill('扩容');
  await page.getByTestId('contract-bind-submit').click();
  await expect.poll(() => calls.bind).toBe(1);

  await page.getByTestId('contract-unbind-check-dev-bound').check();
  await page.getByTestId('contract-unbind-open').click();
  await page.getByTestId('confirm-dialog').getByRole('textbox').fill('设备迁移');
  await page.getByTestId('confirm-dialog').getByRole('button').last().click();
  await expect.poll(() => calls.unbind).toBe(1);
  await expect(page.getByTestId('action-notice')).toContainText('不撤销 License');

  await page.getByTestId('contract-renew-open').click();
  await page.getByTestId('contract-renew-end').fill('2028-01-01T00:00:00Z');
  await page.getByTestId('contract-renew-reason').fill('续约');
  await page.getByTestId('contract-renew-submit').click();
  await expect.poll(() => calls.renew).toBe(1);

  await page.getByTestId('contract-terminate-open').click();
  await page.getByTestId('confirm-dialog').getByRole('textbox').fill('合同结束');
  await page.getByTestId('confirm-dialog').getByRole('button').last().click();
  await expect.poll(() => calls.terminate).toBe(1);
});

const layoutRoutes = [
  '/dashboard',
  '/devices/view',
  '/devices/operate',
  '/devices/groups',
  '/configurations',
  '/consumables',
  '/alarms',
  '/media',
  '/esg/overview',
  '/esg/devices',
  '/contracts',
  '/settings',
  '/customers',
  '/sites',
  '/licenses',
  '/device-users',
  '/audit-logs',
  '/devices/manage',
  '/contracts/new',
  '/contracts/detail',
  '/ota/campaigns',
  '/ota/packages',
];

// Each language/viewport gets a fresh page and its own time budget for 22 navigations.
for (const language of ['zh-CN', 'en'] as const) {
  for (const width of [375, 768, 1440]) {
    test(`FE-19 Chromium 22 个生产路由：${language} / ${width}px`, async ({ page }) => {
      await seedSession(page, 'PlatformSuperAdmin');
      await page.route('**/api/v1/admin/**', (route) =>
        json(route, { error: { code: 'FORBIDDEN', message: 'layout probe', requestId: 'req-layout' } }, 403),
      );
      await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
        key: 'fdp.admin.lang.v1',
        value: language,
      });
      await page.setViewportSize({ width, height: 900 });
      for (const path of layoutRoutes) {
        await page.goto(path);
        await expect(page.getByTestId('page-content')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', language);
        await expect(page.locator('body')).not.toContainText('该页面尚未接入当前管理后台组合根');
        expect(await layoutViolations(page), `${language} ${width} ${path}`).toEqual([]);
      }
    });
  }
}

test('FE-19 语言选择在刷新后保持', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await page.route('**/api/v1/admin/**', (route) =>
    json(route, { error: { code: 'FORBIDDEN', message: 'layout probe', requestId: 'req-layout' } }, 403),
  );
  await page.goto('/dashboard');
  await page.getByTestId('language-select').selectOption('en');
  await page.reload();
  await expect(page.getByTestId('language-select')).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
