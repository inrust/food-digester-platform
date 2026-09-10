import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

type Role = 'PlatformSuperAdmin' | 'PlatformOperator' | 'Auditor' | 'CustomerAdmin' | 'CustomerViewer';

function jwt(expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.signature`;
}

async function seedSession(page: Page, role: Role, options: { expired?: boolean; customerId?: string } = {}) {
  const accessToken = options.expired ? 'expired-session-token' : jwt();
  await page.addInitScript(
    ({ role: selectedRole, accessToken: token, customerId }) => {
      sessionStorage.setItem(
        'fdp.admin.session.v1',
        JSON.stringify({
          username: `e2e-${selectedRole}`,
          roles: [selectedRole],
          customerId,
          idToken: 'redacted-id-token',
          accessToken: token,
          refreshToken: 'redacted-refresh-token',
          expiresInSeconds: token === 'expired-session-token' ? 1 : 3600,
          obtainedAtMs: token === 'expired-session-token' ? 0 : Date.now(),
        }),
      );
    },
    { role, accessToken, customerId: options.customerId ?? (role.startsWith('Customer') ? 'cust-a' : null) },
  );
}

const section = (requestId = 'req-e2e') => ({
  status: 'READY',
  errorCode: null,
  requestId,
  dataUpdatedAt: '2026-09-10T00:00:00Z',
});

const dashboard = {
  generatedAt: '2026-09-10T00:00:00Z',
  sections: { summary: section(), latestAlarms: section(), deviceCards: section() },
  contracts: { effectiveTotal: 1 },
  devices: { total: 1, online: 0, onlineRatePct: 0, licenseDistribution: { Active: 1 } },
  esgToday: {
    summaryDate: '2026-09-10',
    carbonReductionKg: 1,
    powerConsumptionKwh: 2,
    feedingWeightKg: 3,
  },
  latestAlarms: [],
  deviceCards: [
    {
      deviceId: 'dev-offline',
      serialNumber: 'SN-OFFLINE',
      alias: null,
      model: 'FD-100',
      lifecycleStatus: 'Active',
      operationalStatus: 'Active',
      connectivity: 'OFFLINE',
      licenseStatus: 'Active',
      firmwareVersion: '1.0.0',
      signalStrength: null,
      networkType: null,
      consumables: [],
      capabilities: {
        schemaVersion: '1.0',
        commands: [
          { command: 'START', allowed: false, denyReason: 'DEVICE_OFFLINE' },
          { command: 'STOP', allowed: false, denyReason: 'DEVICE_OFFLINE' },
          { command: 'REBOOT', allowed: false, denyReason: 'DEVICE_OFFLINE' },
        ],
        ota: { allowed: false, denyReason: 'OTA_ENTITLEMENT_REQUIRED' },
      },
    },
  ],
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('无 Token 安全回登录；五角色菜单和受限路由均由组合根守卫', async ({ browser }) => {
  const anonymous = await browser.newPage();
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
    const page = await browser.newPage();
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

test('刷新失败清会话，API 403 保留会话并呈现无权', async ({ browser }) => {
  const expiredPage = await browser.newPage();
  await seedSession(expiredPage, 'PlatformSuperAdmin', { expired: true });
  await expiredPage.route('https://cognito-idp.us-east-1.amazonaws.com/', (route) =>
    json(route, { __type: 'NotAuthorizedException' }, 400),
  );
  await expiredPage.goto('/dashboard');
  await expect(expiredPage).toHaveURL(/\/login/);
  expect(await expiredPage.evaluate(() => sessionStorage.getItem('fdp.admin.session.v1'))).toBeNull();
  await expiredPage.close();

  const forbiddenPage = await browser.newPage();
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
  const table = page.getByTestId('cursor-table');
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
    await page.locator('#root').evaluate((root) => root.inert && root.getAttribute('aria-hidden') === 'true'),
  ).toBe(true);
  await expect(page.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '确认下发' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '取消' })).toBeFocused();
});
