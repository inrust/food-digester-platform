import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, p0Device, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

const at = '2026-09-10T00:00:00Z';
const customer = { id: 'cust-a', name: '租户 A', status: 'ACTIVE', version: 1, createdAt: at, updatedAt: at };
const shared = {
  ...p0Device.site,
  id: 'site-shared',
  name: '共用站点',
  customerId: customer.id,
  status: 'ACTIVE',
  deviceCount: 2,
  region: '华东',
  subregion: '上海',
  version: 1,
  timezone: 'Asia/Shanghai',
  address: null,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  createdAt: at,
  updatedAt: at,
};
const legacy = { ...shared, id: 'site-t10-old', name: '旧接入站', status: 'SUSPENDED', deviceCount: 0 };
async function confirm(page: Page) {
  await page.getByTestId('confirm-dialog').getByRole('button', { name: '确认', exact: true }).click();
}

test('C/T10 R02 R16 onboarding waits for the device and retries site creation within business assignment', async ({
  page,
}) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page);
  await page.setViewportSize({ width: 375, height: 900 });
  let lifecycle = 'OnboardingApproved';
  let site: typeof shared | null = null;
  const posts: unknown[] = [];
  const device = () => ({ ...p0Device, lifecycleStatus: lifecycle, customer: site ? customer : null, site });
  const request = {
    requestId: 't10-onb',
    serialNumber: p0Device.serialNumber,
    submittedBy: 'DEVICE:SN-P0',
    model: p0Device.model,
    hardwareVersion: p0Device.hardwareVersion,
    manufacturer: p0Device.manufacturer,
    manufactureDate: p0Device.manufactureDate,
    status: 'APPROVED',
    rejectReason: null,
    reviewedBy: 'fixture',
    reviewedAt: at,
    version: 2,
    createdAt: at,
    certificateProvisioningStatus: 'QUEUED',
  };
  await page.route('**/api/v1/admin/onboarding/requests**', (route) => {
    const url = new URL(route.request().url());
    return json(
      route,
      url.searchParams.has('status')
        ? { data: url.searchParams.get('status') === 'APPROVED' ? [request] : [], meta: { nextCursor: null } }
        : { data: request },
    );
  });
  await page.route('**/api/v1/admin/devices?**', (route) =>
    json(route, {
      data: [{ ...p0Device, id: 'another-device', serialNumber: 'SN-P0-suffix' }, device()],
      meta: { nextCursor: null },
    }),
  );
  await page.route('**/api/v1/admin/devices/dev-p0', (route) => json(route, { data: device() }));
  await page.route('**/api/v1/admin/customers**', (route) =>
    json(route, { data: [customer], meta: { nextCursor: null } }),
  );
  await page.route('**/api/v1/admin/sites**', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    return json(route, {
      data: cursor ? [shared, legacy] : site ? [site] : [],
      meta: { nextCursor: cursor ? null : 'next' },
    });
  });
  await page.route('**/api/v1/admin/devices/dev-p0/assignment', (route) => {
    posts.push(route.request().postDataJSON());
    if (posts.length === 1)
      return json(route, { error: { code: 'INTERNAL_ERROR', message: 'controlled failure' } }, 500);
    site = { ...shared, id: 'site-t10-new', name: '新接入站', subregion: 'T12' };
    lifecycle = 'Assigned';
    return json(route, { data: { assignmentId: 't10-asg', siteId: site.id } });
  });

  await page.goto('/devices/groups');
  await page.getByTestId('tab-APPROVED').click();
  await page.getByTestId('detail-t10-onb').click();
  await page.getByTestId('onboarding-business-assignment').click();
  const waiting = page.getByTestId('onboarding-assignment-waiting');
  await expect(waiting).toBeVisible();
  await expect(page.getByTestId('action-assign')).toBeDisabled();
  expect(posts).toEqual([]);

  lifecycle = 'Onboarded';
  await waiting.getByRole('button').click();
  await page.getByTestId('action-assign').click();
  await page.getByTestId('assign-customer').selectOption(customer.id);
  await expect(page.getByTestId('assign-site').locator('option[value=site-t10-old]')).toBeDisabled();
  await page.getByTestId('assign-site-mode').selectOption('new');
  const name = page.getByTestId('assign-new-site-name');
  await name.fill(shared.name);
  await expect(page.getByTestId('assign-submit')).toBeDisabled();
  await page.getByTestId('assign-reuse-site').click();
  await expect(page.getByTestId('assign-site')).toHaveValue(shared.id);
  await expect(page.getByTestId('assign-site-location')).toContainText('上海');

  await page.getByTestId('assign-site-mode').selectOption('new');
  await name.fill('新接入站');
  await page.getByTestId('assign-new-site-region').fill('华东');
  await page.getByTestId('assign-new-site-subregion').fill('T12');
  const submit = page.getByTestId('assign-submit');
  await submit.click();
  const form = page.getByTestId('assign-dialog');
  await expect(form.getByTestId('error-generic')).toContainText('controlled failure');
  await expect(name).toHaveValue('新接入站');
  await expect(page.getByTestId('assign-new-site-subregion')).toHaveValue('T12');
  expect(await layoutViolations(page)).toEqual([]);
  await submit.click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId('manage-site-subregion')).toHaveText('T12');
  const body = { customerId: customer.id, newSite: { name: '新接入站', region: '华东', subregion: 'T12' } };
  expect(posts).toEqual([body, body]);
});

test('C/T10 R02 R09 R16 contextual site maintenance restores and removes old sites and refreshes device geography', async ({
  page,
  qa05,
}) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page);
  await page.route('**/api/v1/admin/onboarding/requests**', (route) =>
    json(route, { data: [], meta: { nextCursor: null } }),
  );
  let sharedSite = { ...shared };
  let oldSite: typeof legacy | null = { ...legacy };
  const writes: string[] = [];
  const scopes: string[][] = [];
  await page.route('**/api/v1/admin/customers**', (route) =>
    json(route, { data: [customer], meta: { nextCursor: null } }),
  );
  await page.route('**/api/v1/admin/devices?**', (route) => {
    const q = new URL(route.request().url()).searchParams;
    const region = q.get('region');
    const subregion = q.get('subregion');
    if (region && subregion) scopes.push([region, subregion]);
    const matches = (!region || region === sharedSite.region) && (!subregion || subregion === sharedSite.subregion);
    return json(route, { data: matches ? [{ ...p0Device, site: sharedSite }] : [], meta: { nextCursor: null } });
  });
  await page.route('**/api/v1/admin/devices/dev-p0', (route) =>
    json(route, { data: { ...p0Device, site: sharedSite } }),
  );
  await page.route('**/api/v1/admin/sites**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const version = req.headers()['if-match'];
    if (req.method() === 'PATCH') {
      writes.push('edit:' + version);
      sharedSite = { ...sharedSite, ...req.postDataJSON(), version: 2 };
      return json(route, { data: sharedSite });
    }
    if (url.pathname.endsWith('/reactivate') && oldSite) {
      writes.push('restore:' + version);
      oldSite = { ...oldSite, status: 'ACTIVE', version: 2 };
      return json(route, { data: oldSite });
    }
    if (req.method() === 'DELETE') {
      writes.push('delete:' + version);
      const deleted = oldSite;
      oldSite = null;
      return json(route, { data: deleted });
    }
    if (url.pathname.endsWith(shared.id)) return json(route, { data: sharedSite });
    if (url.pathname.endsWith(legacy.id)) return json(route, { data: oldSite });
    const keyword = url.searchParams.get('keyword');
    const rows = (oldSite ? [sharedSite, oldSite] : [sharedSite]).filter(
      (site) => !keyword || site.name.includes(keyword),
    );
    return json(route, { data: rows, meta: { nextCursor: null } });
  });

  await page.goto('/devices/groups');
  await expect(page.getByTestId('menu-item-/sites')).toHaveCount(0);
  await page.getByTestId('device-groups-sites').click();
  await expect(page).toHaveURL(/\/devices\/sites$/);
  await page.getByTestId('site-keyword').fill('旧接入');
  await page.getByTestId('detail-site-t10-old').click();
  await expect(page.getByTestId('site-device-count')).toHaveText('0');
  await page.getByTestId('reactivate-site').click();
  await confirm(page);
  await expect(page.getByTestId('reactivate-site')).toHaveCount(0);
  await page.getByTestId('delete-site').click();
  await confirm(page);
  await expect(page.getByTestId('detail-site-t10-old')).toHaveCount(0);

  await page.goto('/devices/manage?deviceId=dev-p0');
  await page.getByTestId('manage-sites').click();
  await expect(page.getByTestId('site-detail')).toBeVisible();
  await expect(page.getByTestId('delete-site')).toBeDisabled();
  await page.getByTestId('edit-site').click();
  const edit = page.getByTestId('site-form');
  await expect(edit.getByTestId('site-edit-impact')).toContainText('2 台设备');
  await edit.locator('#site-region').fill('新区域');
  await edit.locator('#site-subregion').fill('T12');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('sites-back').click();
  await expect(page.getByTestId('manage-site-region')).toHaveText('新区域');
  await expect(page.getByTestId('manage-site-subregion')).toHaveText('T12');
  await page.goto('/devices/groups?region=华东');
  await page.locator('#scope-region').selectOption('新区域');
  await page.locator('#scope-subregion').selectOption('T12');
  await page.getByTestId('device-search').click();
  await expect.poll(() => scopes.at(-1)).toEqual(['新区域', 'T12']);
  expect(writes).toEqual(['restore:1', 'delete:2', 'edit:1']);

  const viewer = await qa05.newPage();
  await seedSession(viewer, 'CustomerViewer', { customerId: 'cust-a' });
  await routeP0Apis(viewer);
  await viewer.goto('/sites?status=SUSPENDED');
  await expect(viewer).toHaveURL(/\/devices\/sites\?status=SUSPENDED$/);
  await expect(viewer.getByTestId('sites-page')).toBeVisible();
  await expect(viewer.getByTestId('create-site')).toHaveCount(0);
  await viewer.close();
});
