import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, p0Device, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

const at = '2026-09-10T00:00:00Z';
const oldCustomers = ['old-a', 'old-b'].map((id) => ({
  id,
  name: '同名客户',
  status: 'ACTIVE',
  version: 1,
  createdAt: at,
  updatedAt: at,
}));
const customer = { ...oldCustomers[0]!, id: 'cust-t09', name: '合约新客户' };
const site = { id: 'site-t09', customerId: customer.id, name: '测试站点', status: 'ACTIVE' };
const draft = {
  contractId: 'con-t09',
  contractNumber: 'T09-RECOVER',
  name: 'T09 合约',
  customerId: customer.id,
  contact: null,
  startAt: '2028-02-28T16:00:00Z',
  endAt: '2028-02-29T16:00:00Z',
  status: 'DRAFT',
  derivedStatus: 'DRAFT',
  version: 1,
  createdAt: at,
  updatedAt: at,
};

async function fillContract(page: Page, contractNumber: string) {
  await page.getByTestId('contract-number-input').fill(contractNumber);
  await page.getByTestId('contract-name-input').fill(draft.name);
  await page.getByTestId('contract-start-input').fill('2028-02-29');
  await page.getByTestId('contract-end-input').fill('2028-02-29');
}

test('C/T09 R12 same-name customers remain distinct and existing and new inputs are explicit', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await page.setViewportSize({ width: 375, height: 900 });
  await page.route('**/api/v1/admin/customers**', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    return json(route, {
      data: cursor ? [oldCustomers[1]] : [oldCustomers[0]],
      meta: { nextCursor: cursor ? null : 'next' },
    });
  });
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/v1/admin/contracts**', (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.push(body);
      return json(
        route,
        { data: { ...draft, contractNumber: body.contractNumber, customerId: body.customerId ?? 'new-duplicate' } },
        201,
      );
    }
    return json(route, { data: [] });
  });
  await page.goto('/contracts/new');
  await fillContract(page, 'T09-EXISTING');
  const mode = page.getByTestId('contract-customer-mode');
  const picker = page.getByTestId('contract-customer-select');
  await expect(picker.locator('option[value=old-a]')).toHaveText('同名客户 (old-a)');
  await expect(picker.locator('option[value=old-b]')).toHaveText('同名客户 (old-b)');
  await mode.selectOption('new');
  await page.getByTestId('contract-new-customer-name').fill('同名客户');
  await expect(page.getByTestId('contract-create-submit')).toBeDisabled();
  await page.getByTestId('contract-use-customer-old-b').click();
  await expect(picker).toHaveValue('old-b');
  await page.getByTestId('contract-create-submit').click();
  await expect(page.getByTestId('contract-new-devices-empty')).toBeVisible();
  expect(requests[0]).toEqual({
    contractNumber: 'T09-EXISTING',
    name: draft.name,
    customerId: 'old-b',
    startDate: '2028-02-29',
    endDate: '2028-02-29',
  });

  await page.goto('/contracts/new');
  await fillContract(page, 'T09-SEPARATE');
  await mode.selectOption('new');
  await page.getByTestId('contract-new-customer-name').fill('同名客户');
  await expect(page.getByTestId('contract-create-submit')).toBeDisabled();
  await page.getByTestId('contract-confirm-duplicate-customer').check();
  await page.getByTestId('contract-create-submit').click();
  await expect(page.getByTestId('contract-new-devices-empty')).toBeVisible();
  expect(requests[1]).toEqual({
    contractNumber: 'T09-SEPARATE',
    name: draft.name,
    newCustomer: { name: '同名客户', allowDuplicateName: true },
    startDate: '2028-02-29',
    endDate: '2028-02-29',
  });
  expect(await layoutViolations(page)).toEqual([]);
});

test('C/T09 R12 R16 duplicate recovery opens the saved draft and makes the customer available for onboarding', async ({
  page,
  qa05,
}) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page);
  let saved = false;
  let posts = 0;
  let numberLookups = 0;
  const selected: Record<string, unknown>[] = [];
  await page.route('**/api/v1/admin/customers**', (route) => {
    expect(route.request().method()).toBe('GET');
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    return json(route, {
      data: cursor ? (saved ? [customer] : []) : oldCustomers,
      meta: { nextCursor: cursor ? null : 'next' },
    });
  });
  await page.route('**/api/v1/admin/sites**', (route) => json(route, { data: [site], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/devices/dev-p0', (route) =>
    json(route, {
      data: { ...p0Device, lifecycleStatus: 'Onboarded', customer: null, site: null },
    }),
  );
  await page.route('**/api/v1/admin/devices/dev-p0/assignment', (route) => {
    selected.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, { data: { ...selected.at(-1), assignmentId: 'fixture-assignment' } }, 201);
  });
  await page.route('**/api/v1/admin/contracts**', (route) => {
    const request = route.request();
    const path = new URL(request.url());
    if (request.method() === 'POST') {
      posts++;
      expect(request.postDataJSON()).toMatchObject({ newCustomer: { name: customer.name } });
      if (posts === 1) return json(route, { error: { code: 'INTERNAL_ERROR', message: 'controlled failure' } }, 500);
      if (posts === 2) {
        saved = true;
        return route.abort('failed');
      }
      return json(route, { error: { code: 'CONFLICT', message: 'The contractNumber already exists' } }, 409);
    }
    if (path.searchParams.get('contractNumber') === draft.contractNumber) {
      numberLookups++;
      return json(route, { data: saved ? [draft] : [] });
    }
    if (path.pathname.endsWith('/con-t09')) return json(route, { data: draft });
    return json(route, { data: [] });
  });

  await page.goto('/contracts/new');
  await fillContract(page, draft.contractNumber);
  await page.getByTestId('contract-customer-mode').selectOption('new');
  const name = page.getByTestId('contract-new-customer-name');
  await name.fill(customer.name);
  const submit = page.getByTestId('contract-create-submit');
  await submit.click();
  await expect(page.getByTestId('error-generic')).toContainText('controlled failure');
  await expect(name).toHaveValue(customer.name);
  await submit.click();
  await expect(page.getByTestId('contract-check-saved')).toBeVisible();
  await submit.click();
  await expect(page.getByTestId('contract-number-conflict')).toContainText(draft.contractNumber);
  await page.getByTestId('contract-open-existing').click();
  await expect(page).toHaveURL(/\/contracts\/detail\?contractId=con-t09$/);
  await expect(page.getByTestId('contract-detail-customer')).toHaveText(customer.name);
  await page.getByTestId('contract-bind-open').click();
  await expect(page.getByTestId('contract-bind-empty')).toBeVisible();
  expect(posts).toBe(3);
  expect(numberLookups).toBe(1);

  await page.goto('/devices/manage?deviceId=dev-p0');
  await page.getByTestId('action-assign').click();
  await page.getByTestId('assign-customer').selectOption({ label: customer.name });
  await page.getByTestId('assign-site').selectOption(site.id);
  await page.getByTestId('assign-submit').click();
  await expect.poll(() => selected).toEqual([{ customerId: customer.id, siteId: site.id }]);

  await page.goto('/customers');
  await expect(page).toHaveURL(/\/contracts\/customers$/);
  await expect(page.getByTestId('customers-page')).toBeVisible();
  await expect(page.getByTestId('menu-item-/customers')).toHaveCount(0);
  const crumb = page.getByRole('navigation', { name: '面包屑' });
  await crumb.getByRole('link', { name: '合约查询及修改' }).click();
  await page.getByTestId('contract-open-customers').click();
  await expect(page).toHaveURL(/\/contracts\/customers$/);

  const viewer = await qa05.newPage();
  await seedSession(viewer, 'CustomerViewer');
  await viewer.goto('/customers');
  await expect(viewer.getByRole('heading', { name: '403' })).toBeVisible();
  await viewer.close();
});
