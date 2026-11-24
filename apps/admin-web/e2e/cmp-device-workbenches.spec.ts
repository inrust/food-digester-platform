import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { dashboard, json, p0Alarm, p0Device, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

test('B/T06 R04–R06 原型入口、设备范围、面包屑及返回筛选', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page, { alarmRows: true });
  await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard }));
  await page.route('**/api/v1/admin/media?*', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/onboarding/requests**', (route) =>
    json(route, { data: [], meta: { nextCursor: null } }),
  );
  const groups: Array<string | null> = [];
  const configs: Array<string | null> = [];
  const alarms: Array<[string, string | null]> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    const endpoint = url.pathname.replace(/^\/api\/v1\/admin\//, '');
    if (endpoint === 'devices' && url.searchParams.has('keyword')) groups.push(url.searchParams.get('keyword'));
    if (endpoint === 'configurations') configs.push(url.searchParams.get('targetDeviceId'));
    if (endpoint === 'alarms' || endpoint === 'events' || endpoint === 'tamper-events') {
      alarms.push([endpoint, url.searchParams.get('deviceId')]);
    }
  });

  await page.goto('/dashboard');
  await page.getByTestId('dashboard-alarms').click();
  const breadcrumb = page.getByRole('navigation', { name: '面包屑' });
  await expect(breadcrumb.getByRole('link', { name: '概览' })).toHaveAttribute('href', '/dashboard');
  await expect(page.getByTestId('alarm-detail-alarm-p0')).toBeVisible();
  expect(alarms.at(-1)).toEqual(['alarms', null]);

  await page.getByTestId('menu-item-/devices/groups').click();
  await page.getByTestId('device-keyword').fill('SN-P0');
  await page.getByTestId('device-search').click();
  await expect(page).toHaveURL(/\/devices\/groups\?keyword=SN-P0$/);
  await page.getByTestId('device-groups-configurations').click();
  await expect(page.getByTestId('config-empty')).toBeVisible();
  expect(configs.at(-1)).toBeNull();
  await breadcrumb.getByRole('link', { name: '设备群管理' }).click();
  await expect(page.getByTestId('device-keyword')).toHaveValue('SN-P0');

  await page.getByTestId('manage-dev-p0').click();
  await page.getByTestId('goto-current-config').click();
  await expect(page.getByTestId('configuration-device-scope')).toContainText('dev-p0');
  await expect(page.getByTestId('config-empty')).toBeVisible();
  expect(configs.at(-1)).toBe('dev-p0');
  await page.getByTestId('config-create').click();
  await expect(page.getByTestId('config-fixed-target')).toHaveText('dev-p0');
  await expect(page.getByTestId('config-target-value')).toHaveCount(0);
  await page.getByRole('dialog', { name: '新建配置' }).getByRole('button', { name: '关闭' }).click();
  await breadcrumb.getByRole('link', { name: '设备管理详情' }).click();
  await page.getByTestId('manage-media').click();
  await expect(page.getByTestId('media-device-scope')).toContainText('dev-p0');
  await breadcrumb.getByRole('link', { name: '设备管理详情' }).click();
  await page.getByTestId('manage-alarms').click();
  await expect(page.getByTestId('alarm-device-scope')).toContainText('dev-p0');
  await expect(page.getByTestId('alarm-detail-alarm-p0')).toBeVisible();
  expect(alarms.at(-1)).toEqual(['alarms', 'dev-p0']);
  await page.getByTestId('tab-event').click();
  await expect.poll(() => alarms.at(-1)).toEqual(['events', 'dev-p0']);
  await page.getByTestId('tab-tamper').click();
  await expect.poll(() => alarms.at(-1)).toEqual(['tamper-events', 'dev-p0']);
  await page.reload();
  await expect(page.getByTestId('alarm-device-scope')).toContainText('dev-p0');
  await expect.poll(() => alarms.at(-1)).toEqual(['tamper-events', 'dev-p0']);
  await breadcrumb.getByRole('link', { name: '设备群管理' }).click();
  await expect(page.getByTestId('device-keyword')).toHaveValue('SN-P0');
  await expect(page.getByTestId('manage-dev-p0')).toBeVisible();
  expect(groups.at(-1)).toBe('SN-P0');

  await page.goto('/configurations?targetDeviceId=dev-p0');
  await expect(page.getByTestId('configuration-device-scope')).toContainText('dev-p0');
  await expect(page.getByTestId('config-empty')).toBeVisible();
  expect(configs.at(-1)).toBe('dev-p0');
});

test('B/T06 R05–R06 旧直达链接校验设备后才读取数据，跨租户和冲突范围失败关闭', async ({ page }) => {
  await seedSession(page, 'CustomerViewer', { customerId: 'cust-a' });
  await routeP0Apis(page);
  await page.route('**/api/v1/admin/onboarding/requests**', (route) =>
    json(route, { data: [], meta: { nextCursor: null } }),
  );
  const scopedReads: Array<[string, string | null]> = [];
  const deviceChecks: string[] = [];
  let returnForeignMedia = false;
  await page.route(/\/api\/v1\/admin\/devices\/[^/?]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    deviceChecks.push(id);
    if (id === 'forbidden') return json(route, { error: { code: 'FORBIDDEN' } }, 403);
    const customer = id === 'other-tenant' ? { id: 'cust-b', name: '租户 B' } : p0Device.customer;
    return json(route, { data: { ...p0Device, id, customer } });
  });
  await page.route(/\/api\/v1\/admin\/(media|alarms|events)(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.split('/').at(-1)!;
    scopedReads.push([endpoint, url.searchParams.get('deviceId')]);
    const data = endpoint === 'alarms' ? [p0Alarm] : [];
    if (endpoint === 'media' && returnForeignMedia) {
      return json(route, { data: [{ mediaId: 'foreign-media', deviceId: 'dev-other' }], meta: { nextCursor: null } });
    }
    return json(route, { data, meta: { nextCursor: null } });
  });

  await page.goto('/media');
  await expect(page.getByTestId('media-choose-device')).toBeVisible();
  expect(scopedReads).toEqual([]);
  await page.getByTestId('media-choose-device').click();
  await expect(page).toHaveURL(/\/devices\/groups$/);

  for (const url of ['/media?deviceId=other-tenant', '/media?deviceId=dev-p0&deviceId=other-tenant']) {
    await page.goto(url);
    await expect(page.getByTestId('error-generic')).toContainText('NOT_FOUND');
    expect(scopedReads).toEqual([]);
  }
  expect(deviceChecks).toEqual(['other-tenant']);

  await page.goto('/alarms?scopeDeviceId=forbidden');
  await expect(page.getByTestId('error-forbidden')).toBeVisible();
  await page.goto('/configurations?deviceId=dev-p0');
  await expect(page.getByRole('heading', { name: '403' })).toBeVisible();
  expect(deviceChecks).toEqual(['other-tenant', 'forbidden']);
  expect(scopedReads).toEqual([]);

  await page.goto('/media?deviceId=dev-p0&customerId=cust-b');
  await expect(page.getByTestId('media-device-scope')).toContainText('dev-p0');
  await expect.poll(() => scopedReads.at(-1)).toEqual(['media', 'dev-p0']);
  returnForeignMedia = true;
  await page.reload();
  await expect(page.getByTestId('error-generic')).toContainText('NOT_FOUND');
  await expect(page.getByTestId('media-open-foreign-media')).toHaveCount(0);

  await page.goto('/alarms?tab=event&deviceId=dev-p0&customerId=cust-b');
  await expect(page.getByTestId('alarm-device-scope')).toContainText('dev-p0');
  await expect.poll(() => scopedReads.at(-1)).toEqual(['events', 'dev-p0']);
  await expect(page).toHaveURL(/tab=event&scopeDeviceId=dev-p0$/);
  await page.getByTestId('tab-alarm').click();
  await expect(page.getByTestId('alarm-detail-alarm-p0')).toBeVisible();
  expect(scopedReads.at(-1)).toEqual(['alarms', 'dev-p0']);
});
