import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { dashboard, json, layoutViolations, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

const accountPath = '**/api/v1/admin/account/profile';

test('R01 CMP-01/02 platform shows account details on demand and previews ten of thirteen devices', async ({
  page,
  qa05,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  const displayName = '合成账号名称用于查看完整文本'.repeat(8);
  const userId = 'fixture-9f03aca2-0a9f-498b-88ed-ad82a84c8dc5';
  const subject = 'fixture-352b9784-2cc6-4a1b-9e70-d66d0909faa6';
  const username = 'fixture.internal.platform-user';
  await seedSession(page, 'PlatformSuperAdmin', {
    username,
    identityClaims: { sub: subject, email: 'platform@example.test', email_verified: true },
  });
  await routeP0Apis(page);
  await page.route('**/api/v1/admin/onboarding/requests?*', (route) =>
    json(route, { data: [], meta: { nextCursor: null } }),
  );
  const accountReads: { method: string; query: string }[] = [];
  await page.route(accountPath, (route) => {
    accountReads.push({ method: route.request().method(), query: new URL(route.request().url()).search });
    return json(route, { data: { userId, displayName } });
  });
  const previewIds = Array.from({ length: 10 }, (_, index) => `cmp-device-${String(index + 1).padStart(2, '0')}`);
  await page.route('**/api/v1/admin/dashboard/overview', (route) =>
    json(route, {
      data: {
        ...dashboard,
        devices: { ...dashboard.devices, total: 13 },
        deviceCards: previewIds.map((deviceId) => ({ ...dashboard.deviceCards[0], deviceId })),
      },
    }),
  );
  await page.route('https://cognito-idp.us-east-1.amazonaws.com/', (route) => json(route, {}));

  await page.goto('/dashboard');
  const name = page.getByTestId('topbar-account-name');
  const account = page.getByTestId('topbar-account');
  await expect(name).toHaveText(displayName);
  await expect(account).toHaveAttribute('title', displayName);
  expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(page.getByTestId('role-tag')).toBeVisible();
  await expect(page.getByTestId('logout-button')).toBeVisible();
  await expect(page.getByTestId('user-badge')).not.toContainText(userId);
  await expect(page.getByTestId('user-badge')).not.toContainText(subject);

  await account.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '账号详情' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('dt')).toHaveText(['当前显示名称', '角色', '已验证的登录邮箱']);
  await expect(dialog.locator('dd')).toHaveText([
    displayName,
    await page.getByTestId('role-tag').innerText(),
    'platform@example.test',
  ]);
  for (const value of [userId, subject, username]) await expect(dialog).not.toContainText(value);
  expect(await layoutViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(account).toBeFocused();

  await expect(page.getByTestId('metric-devices')).toContainText('可见设备总数');
  await expect(page.getByTestId('metric-devices').locator('.value')).toHaveText('13');
  await expect(page.getByTestId('device-preview-scope')).toHaveText('可见范围：全平台设备');
  await expect(page.getByTestId('device-cards')).toContainText('按设备 ID 升序预览，最多显示 10 台');
  await expect(page.getByTestId('device-preview-count')).toHaveText('已显示 10 台，可见设备共 13 台。');
  const cards = page.getByTestId('device-cards').locator('.device-card');
  expect(await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')))).toEqual(
    previewIds.map((id) => `device-card-${id}`),
  );
  const link = page.getByRole('link', { name: '查看设备列表' });
  await expect(link).toHaveAttribute('href', '/devices/groups');
  await link.click();
  await expect(page.getByTestId('device-groups-page')).toBeVisible();
  expect(accountReads).toEqual([{ method: 'GET', query: '' }]);
  await page.getByTestId('logout-button').click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('topbar-account')).toHaveCount(0);
  Object.assign(qa05.proof, { accountReads, total: 13, previewIds });
});

test('CMP-01/02 CustomerViewer uses the verified email fallback and opens the fixed customer device list', async ({
  page,
  qa05,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await seedSession(page, 'CustomerViewer', {
    username: 'fixture.internal.customer-viewer',
    customerId: 'cmp-customer',
    identityClaims: { sub: 'fixture-customer-sub', email: 'viewer@example.test', email_verified: true },
  });
  await page.addInitScript(() => localStorage.setItem('fdp.admin.lang.v1', 'en'));
  await routeP0Apis(page);
  await page.route('**/api/v1/admin/onboarding/requests?*', (route) =>
    json(route, { error: { code: 'FORBIDDEN', message: 'Fixture onboarding access is denied' } }, 403),
  );
  await page.route(accountPath, (route) => json(route, { data: { displayName: null, userId: 'fixture-customer-id' } }));
  await page.route('**/api/v1/admin/dashboard/overview', (route) =>
    json(route, {
      data: {
        ...dashboard,
        devices: { ...dashboard.devices, total: 2 },
        deviceCards: ['tenant-01', 'tenant-02'].map((deviceId) => ({ ...dashboard.deviceCards[0], deviceId })),
      },
    }),
  );
  const deviceSearch: string[] = [];
  await page.route('**/api/v1/admin/devices?*', (route) => {
    deviceSearch.push(new URL(route.request().url()).search);
    return json(route, { data: [], meta: { nextCursor: null } });
  });

  await page.goto('/dashboard');
  await expect(page.getByTestId('topbar-account-name')).toHaveText('viewer@example.test');
  await page.getByRole('button', { name: 'View account details for viewer@example.test' }).click();
  const dialog = page.getByRole('dialog', { name: 'Account details' });
  await expect(dialog.locator('dt')).toHaveText(['Displayed name', 'Role', 'Verified sign-in email']);
  await expect(dialog.locator('dd')).toHaveText([
    'viewer@example.test',
    await page.getByTestId('role-tag').innerText(),
    'viewer@example.test',
  ]);
  await dialog.getByRole('button', { name: 'Close' }).click();

  await expect(page.getByTestId('device-preview-scope')).toHaveText(
    'Scope: devices for your customer account (cmp-customer)',
  );
  await expect(page.getByTestId('device-preview-count')).toHaveText('Showing 2 of 2 visible devices.');
  await expect(page.getByTestId('device-cards').locator('.device-card')).toHaveCount(2);
  expect(await layoutViolations(page)).toEqual([]);
  await page.getByRole('link', { name: 'Open device list' }).click();
  await expect(page.getByTestId('device-groups-page')).toBeVisible();
  await expect
    .poll(() => deviceSearch.some((search) => new URLSearchParams(search).get('customerId') === 'cmp-customer'))
    .toBe(true);
  Object.assign(qa05.proof, { total: 2, deviceSearch });
});

test('CMP-01/02 keeps the username fallback and list entry when profile and device data are absent', async ({
  page,
}) => {
  await seedSession(page, 'CustomerAdmin', {
    username: 'legacy-customer',
    identityClaims: { email: 'unverified@example.test', email_verified: false },
  });
  await page.route(accountPath, (route) => json(route, { error: { code: 'NOT_FOUND' } }, 404));
  await page.route('**/api/v1/admin/dashboard/overview', (route) =>
    json(route, {
      data: {
        ...dashboard,
        devices: { total: 0, online: 0, onlineRatePct: 0, licenseDistribution: {} },
        deviceCards: [],
      },
    }),
  );
  await page.goto('/dashboard');
  await expect(page.getByTestId('topbar-account-name')).toHaveText('legacy-customer');
  await page.getByTestId('topbar-account').click();
  const dialog = page.getByRole('dialog', { name: '账号详情' });
  await expect(dialog.locator('dt')).toHaveText(['当前显示名称', '角色']);
  await expect(dialog.locator('dd')).toHaveText(['legacy-customer', await page.getByTestId('role-tag').innerText()]);
  await expect(dialog.getByText('unverified@example.test')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(page.getByTestId('metric-devices').locator('.value')).toHaveText('0');
  await expect(page.getByTestId('device-preview-count')).toHaveText('已显示 0 台，可见设备共 0 台。');
  await expect(page.getByTestId('devices-empty')).toBeVisible();
  await expect(page.getByRole('link', { name: '查看设备列表' })).toBeVisible();
});

test('R01 omits the email row when the session has no email claim', async ({ page }) => {
  await seedSession(page, 'CustomerAdmin', { username: 'no-email', identityClaims: { email_verified: true } });
  await page.route(accountPath, (route) =>
    json(route, { data: { userId: 'fixture-id', displayName: '本地测试账号' } }),
  );
  await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard }));
  await page.goto('/dashboard');
  const account = page.getByTestId('topbar-account');
  await expect(page.getByTestId('topbar-account-name')).toHaveText('本地测试账号');
  await account.focus();
  await page.keyboard.press('Space');
  const dialog = page.getByRole('dialog', { name: '账号详情' });
  await expect(dialog.locator('dt')).toHaveText(['当前显示名称', '角色']);
  await expect(dialog.locator('dd')).toHaveText(['本地测试账号', await page.getByTestId('role-tag').innerText()]);
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(account).toBeFocused();
});
