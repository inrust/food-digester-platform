import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, p0Device, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

test('B/T08 R18 business settings save reaches FE-18 and preserves CMP-34 runtime labels', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await seedSession(page, 'PlatformSuperAdmin');
  const base = { version: 7, updatedBy: 'fixture-user', updatedAt: '2026-09-10T00:00:00Z' };
  const threshold = {
    ...base,
    key: 'alarm.thresholds',
    value: {
      CONSUMABLE_REMAINING_PERCENT: { warning: 40, major: 60, critical: 90 },
      TEMPERATURE_HIGH: { warning: 72, major: 82 },
    },
    runtimeStatus: 'ACTIVE',
    runtimeConsumer: 'FE-18',
  };
  const settings = [
    threshold,
    {
      ...base,
      key: 'command.confirmation',
      value: { ttlSec: 45, maxFutureSec: 5 },
      runtimeStatus: 'ACTIVE',
      runtimeConsumer: 'BE-CMD-01',
    },
    {
      ...base,
      key: 'dictionary.displayNames',
      value: { command: { STOP: 'Fixture label' } },
      runtimeStatus: 'STORED_ONLY',
      runtimeConsumer: null,
    },
    {
      ...base,
      key: 'notification.business',
      value: { eventTypes: ['CRITICAL_ALERT_RAISED'], channels: ['EMAIL'] },
      runtimeStatus: 'STORED_ONLY',
      runtimeConsumer: null,
    },
  ];
  const reading = (remainingPercent: number) => ({
    remainingPercent,
    remainingDisplay: remainingPercent + '%',
    stale: false,
    observedAt: base.updatedAt,
  });
  let userReads = 0;
  await page.route('**/api/v1/admin/users**', (route) => {
    userReads++;
    return json(route, { data: [], meta: { nextCursor: null } });
  });
  const settingRequests: string[] = [];
  await page.route('**/api/v1/admin/settings**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    settingRequests.push(request.method() + ':' + path);
    if (request.method() === 'PUT') {
      expect(path).toBe('/api/v1/admin/settings/alarm.thresholds');
      const body = request.postDataJSON() as { version: number; value: typeof threshold.value };
      expect(body.version).toBe(7);
      expect(body.value.CONSUMABLE_REMAINING_PERCENT.warning).toBe(55);
      threshold.value = body.value;
      threshold.version++;
      return json(route, { data: threshold });
    }
    return json(route, { data: path.endsWith('/settings') ? settings : threshold });
  });
  await page.route('**/api/v1/admin/consumables**', (route) =>
    json(route, {
      data: [
        {
          deviceId: 'cmp-t09-device',
          serialNumber: 'CMP-T09',
          model: 'T09',
          alias: null,
          lifecycleStatus: 'Active',
          site: null,
          connectivity: 'ONLINE',
          consumables: { CARBON_FILTER: reading(50), BIO_ADDITIVE: reading(85) },
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  await page.route('**/api/v1/admin/consumable-requests**', (route) => json(route, { data: [] }));

  await page.goto('/settings');
  const breadcrumb = page.getByRole('navigation', { name: '面包屑' });
  await expect(page.getByRole('heading', { name: '平台用户管理', exact: true })).toBeVisible();
  await expect(breadcrumb.locator('[aria-current=page]')).toHaveText('平台用户管理');
  await expect(page.getByTestId('menu-item-/settings')).toHaveText('平台用户管理');
  await expect(page.getByTestId('table-empty')).toBeVisible();
  expect(settingRequests).toEqual([]);
  await page.getByTestId('drawer-open').click();
  await page.getByTestId('menu-item-/business-settings').click();
  await expect(page).toHaveURL(/\/business-settings$/);
  await expect(page.getByRole('heading', { name: '业务设置', exact: true })).toBeVisible();
  await expect(breadcrumb.locator('[aria-current=page]')).toHaveText('业务设置');
  const cards = page.getByTestId('business-settings-content');
  await expect(cards.getByRole('article')).toHaveCount(4);
  await expect(cards.getByTestId('setting-consumer-alarm.thresholds')).toContainText('FE-18');
  await expect(cards.getByTestId('setting-alarm.thresholds')).toContainText(
    /CONSUMABLE_REMAINING_PERCENT.*warning.*major/,
  );
  await expect(cards.getByTestId('setting-command.confirmation')).toContainText(/ttlSec.*maxFutureSec/);
  await expect(cards.getByTestId('setting-consumer-command.confirmation')).toContainText('BE-CMD-01');
  await expect(cards.getByTestId('setting-edit-command.confirmation')).toHaveCount(0);
  for (const key of ['dictionary.displayNames', 'notification.business']) {
    await expect(cards.getByTestId(`setting-runtime-${key}`)).toContainText('仅存储');
    await expect(cards.getByTestId(`setting-consumer-${key}`)).toContainText('尚无运行时消费方');
    await expect(cards.getByTestId(`setting-edit-${key}`)).toBeEnabled();
  }
  await expect(cards.getByTestId('setting-edit-alarm.thresholds')).toBeEnabled();
  expect(await layoutViolations(page)).toEqual([]);

  await page.goto('/consumables');
  await expect(page.getByTestId('consumable-carbon-cmp-t09-device').locator('.consumable-bar')).toHaveAttribute(
    'data-level',
    'mid',
  );
  await expect(page.getByTestId('consumable-bio-cmp-t09-device').locator('.consumable-bar')).toHaveAttribute(
    'data-level',
    'ok',
  );
  await page.getByTestId('drawer-open').click();
  await page.getByTestId('menu-item-/business-settings').click();
  await cards.getByTestId('setting-edit-alarm.thresholds').click();
  const form = page.getByTestId('setting-edit-form');
  const changed = {
    ...threshold.value,
    CONSUMABLE_REMAINING_PERCENT: { ...threshold.value.CONSUMABLE_REMAINING_PERCENT, warning: 55 },
  };
  await form.getByTestId('setting-value-input').fill(JSON.stringify(changed));
  await form.getByTestId('setting-submit').click();
  await expect(page.getByTestId('action-notice')).toContainText('v8');
  await expect(cards.getByTestId('setting-alarm.thresholds')).toContainText('v8');
  await page.goto('/consumables');
  await expect(page.getByTestId('consumable-carbon-cmp-t09-device').locator('.consumable-bar')).toHaveAttribute(
    'data-level',
    'low',
  );
  expect(userReads).toBe(1);
  expect(settingRequests).toEqual([
    'GET:/api/v1/admin/settings',
    'GET:/api/v1/admin/settings/alarm.thresholds',
    'GET:/api/v1/admin/settings',
    'PUT:/api/v1/admin/settings/alarm.thresholds',
    'GET:/api/v1/admin/settings',
    'GET:/api/v1/admin/settings/alarm.thresholds',
  ]);
});

test('B/T08 R18 old settings links follow destination permissions and keep device context', async ({ qa05 }) => {
  const anonymous = await qa05.newPage();
  await anonymous.goto('/settings#business-settings');
  await expect(anonymous).toHaveURL(/\/login\?/);
  expect(new URL(anonymous.url()).searchParams.get('returnTo')).toBe('/settings#business-settings');
  await anonymous.close();

  const auditor = await qa05.newPage();
  await seedSession(auditor, 'Auditor');
  await auditor.addInitScript(() => localStorage.setItem('fdp.admin.lang.v1', 'en'));
  const calls: string[] = [];
  await auditor.route('**/api/v1/admin/settings**', (route) => {
    calls.push(route.request().method() + ' settings');
    return json(route, {
      data: [
        {
          key: 'alarm.thresholds',
          value: {},
          version: 1,
          updatedBy: 'fixture',
          updatedAt: '2026-09-10T00:00:00Z',
          runtimeStatus: 'ACTIVE',
          runtimeConsumer: 'FE-18',
        },
      ],
    });
  });
  await auditor.route('**/api/v1/admin/users**', (route) => {
    calls.push(route.request().method() + ' users');
    return json(route, { data: [], meta: { nextCursor: null } });
  });
  await auditor.goto('/settings#business-settings');
  await expect(auditor).toHaveURL(/\/business-settings$/);
  await expect(auditor.getByRole('heading', { name: 'Business Settings', exact: true })).toBeVisible();
  await expect(auditor.getByTestId('setting-edit-alarm.thresholds')).toBeDisabled();
  await expect(auditor.getByTestId('setting-access-alarm.thresholds')).toContainText('Read-only');
  expect(calls).toEqual(['GET settings']);
  await auditor.goto('/settings?tab=platform-users');
  await expect(auditor).toHaveURL(/\/settings$/);
  await expect(auditor.getByRole('heading', { name: 'Platform User Management', exact: true })).toBeVisible();
  await expect(auditor.getByTestId('table-empty')).toBeVisible();
  await expect(auditor.getByTestId('user-invite-open')).toBeDisabled();
  expect(calls).toEqual(['GET settings', 'GET users']);
  await auditor.close();

  const customer = await qa05.newPage();
  await seedSession(customer, 'CustomerAdmin', { customerId: p0Device.customer.id });
  await routeP0Apis(customer);
  await customer.goto('/settings?tab=business-settings');
  await expect(customer).toHaveURL(/\/business-settings$/);
  await expect(customer.getByRole('heading', { name: '403' })).toBeVisible();
  await customer.goto('/settings');
  await expect(customer.getByRole('heading', { name: '403' })).toBeVisible();
  await customer.goto(`/settings?tab=device-users&deviceId=${p0Device.id}`);
  await expect(customer).toHaveURL(/\/device-users\?deviceId=dev-p0$/);
  await expect(customer.getByTestId('device-user-device-scope')).toContainText(p0Device.id);
  await customer.goto('/settings#device-users');
  await expect(customer.getByTestId('device-user-choose-device')).toBeVisible();
});
