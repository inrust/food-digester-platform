import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, p0Device, routeFe11To15Apis, seedSession } from './qa05-api-fixtures.js';

test('CMP-19 selects eligible devices and recovers when the server invalidates a selection', async ({ page }) => {
  await seedSession(page, 'PlatformOperator');
  const invalidAtSubmit = { ...p0Device, id: 'dev-changed', serialNumber: 'SN-CHANGED' };
  const valid = { ...p0Device, id: 'dev-valid', serialNumber: 'SN-VALID', site: null };
  const retired = { ...p0Device, id: 'dev-retired', lifecycleStatus: 'Retired' };
  const unassigned = { ...p0Device, id: 'dev-unassigned', customer: null, site: null };
  const bodies: Record<string, unknown>[] = [];
  const deviceCursors: (string | null)[] = [];

  await page.route('**/api/v1/admin/consumables**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/devices**', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    deviceCursors.push(cursor);
    return cursor === null
      ? json(route, { data: [retired, unassigned, invalidAtSubmit], meta: { nextCursor: 'devices-page-2' } })
      : json(route, { data: [valid], meta: { nextCursor: null } });
  });
  await page.route('**/api/v1/admin/consumable-requests**', (route) => {
    if (route.request().method() === 'GET') return json(route, { data: [] });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (body['deviceId'] === invalidAtSubmit.id) {
      return json(
        route,
        { error: { code: 'CONFLICT', message: 'The device is retired', requestId: 'req-changed' } },
        409,
      );
    }
    const replayed = bodies.length > 2;
    return json(route, { data: { requestId: 'request-cmp19', replayed } }, replayed ? 200 : 201);
  });

  await page.goto('/consumables');
  const open = page.getByTestId('consumable-request-create-open');
  await expect(open).toBeEnabled();
  expect(deviceCursors).toEqual([]);
  await open.click();
  const modal = page.getByTestId('consumable-create-form');
  const select = modal.getByTestId('consumable-create-device');
  const type = modal.getByTestId('consumable-create-type');
  const submit = modal.getByTestId('consumable-create-submit');
  await expect(select.locator('option')).toHaveCount(3);
  expect(deviceCursors).toEqual([null, 'devices-page-2']);
  for (const device of [retired, unassigned]) {
    await expect(select.locator(`option[value="${device.id}"]`)).toHaveCount(0);
  }
  await type.selectOption('CARBON_FILTER');
  await modal.getByLabel('按名称、序列号或设备 ID 搜索').fill('dev-missing');
  await expect(modal.getByText('没有符合搜索条件的可用设备。')).toBeVisible();
  await expect(submit).toBeDisabled();
  expect(bodies).toEqual([]);
  await modal.getByLabel('按名称、序列号或设备 ID 搜索').clear();
  await select.selectOption(invalidAtSubmit.id);
  await modal.getByTestId('consumable-create-note').fill('保留备注');
  await submit.click();
  await expect(modal.getByTestId('consumable-device-error')).toBeVisible();
  await expect(select).toHaveAttribute('aria-invalid', 'true');
  await expect(submit).toBeDisabled();
  await expect(select.locator(`option[value="${invalidAtSubmit.id}"]`)).toHaveCount(0);

  await modal.getByLabel('按名称、序列号或设备 ID 搜索').fill(valid.serialNumber);
  await select.selectOption(valid.id);
  await submit.click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('action-notice')).toContainText('request-cmp19');
  expect(bodies.at(-1)).toEqual({ deviceId: valid.id, consumableType: 'CARBON_FILTER', note: '保留备注' });

  await open.click();
  await select.selectOption(valid.id);
  await type.selectOption('CARBON_FILTER');
  await submit.click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('action-notice')).toContainText('幂等返回现有记录');
  expect(bodies.map((body) => body['deviceId'])).toEqual([invalidAtSubmit.id, valid.id, valid.id]);
});

test('CMP-25 resets applied scope, dates, pagination and export while holding the Customer scope', async ({ page }) => {
  await seedSession(page, 'CustomerAdmin', { customerId: 'cust-a' });
  await routeFe11To15Apis(page);
  const reports: Record<string, string>[] = [];
  const exports: Record<string, unknown>[] = [];
  const base = { customerId: 'cust-a', reportType: 'DAILY' };
  const scoped = { siteId: p0Device.site.id, deviceId: p0Device.id };
  const range = { from: '2026-09-30T16:00:00.000Z', to: '2026-10-01T15:59:59.999Z' };
  const changedRange = { from: '2026-10-01T16:00:00.000Z', to: '2026-10-02T15:59:59.999Z' };
  let releaseOldPage!: () => void;
  const oldPage = new Promise<void>((resolve) => {
    releaseOldPage = resolve;
  });
  let delayChangedQuery = true;
  await page.route('**/api/v1/admin/esg/reports**', async (route) => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    reports.push(query);
    if (delayChangedQuery && query['from'] === changedRange.from && !query['cursor']) {
      await oldPage;
      return json(route, { data: [], meta: { nextCursor: 'discarded-page' } });
    }
    const nextCursor = query['cursor'] ? null : query['from'] ? 'filtered-page-2' : 'all-page-2';
    return json(route, { data: [], meta: { nextCursor } });
  });
  await page.route('**/api/v1/admin/esg/exports', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    exports.push(body);
    return json(
      route,
      {
        data: {
          exportId: `cmp25-${exports.length}`,
          dataset: 'REPORTS',
          status: 'PENDING',
          filters: body,
          rowCount: null,
          downloadUrl: null,
          urlExpiresAt: null,
          urlExpired: false,
          error: null,
          requestedBy: 'fixture',
          createdAt: '2026-10-01T00:00:00Z',
          completedAt: null,
        },
      },
      202,
    );
  });

  await page.goto('/esg/devices');
  const filter = page.getByTestId('esg-device-filter');
  const from = page.getByTestId('esg-device-from-date');
  const to = page.getByTestId('esg-device-to-date');
  const apply = page.getByTestId('esg-device-apply');
  const exportButton = page.getByTestId('esg-device-export-csv');
  const reset = filter.getByRole('button', { name: '重置' });
  const selectScope = async () => {
    await filter.locator('#scope-region').selectOption(p0Device.site.region);
    await filter.locator('#scope-subregion').selectOption(p0Device.site.subregion);
    await filter.locator('#scope-site').selectOption(p0Device.site.id);
    await filter.locator('#scope-device').selectOption(p0Device.id);
  };
  await expect(page.getByTestId('esg-device-empty')).toBeVisible();
  await selectScope();
  await from.fill('2026-10-01');
  await to.fill('2026-10-01');
  await apply.click();
  const filtered = { ...base, ...scoped, ...range };
  await expect.poll(() => reports.slice(-2)).toEqual([filtered, { ...filtered, cursor: 'filtered-page-2' }]);
  await exportButton.click();
  await expect.poll(() => exports).toEqual([{ dataset: 'REPORTS', customerId: 'cust-a', ...scoped, ...range }]);
  await expect(page.getByTestId('esg-device-export-job')).toBeVisible();

  await from.fill('2026-10-02');
  await to.fill('2026-10-02');
  const changed = { ...base, ...scoped, ...changedRange };
  await apply.click();
  await expect.poll(() => reports.at(-1)).toEqual(changed);
  await to.fill('2026-10-01');
  await apply.click();
  await expect(page.getByTestId('esg-device-date-error')).toBeVisible();
  await expect(reset).toHaveCount(1);
  await reset.click();
  for (const id of ['#scope-region', '#scope-subregion', '#scope-site', '#scope-device']) {
    await expect(filter.locator(id)).toHaveValue('');
  }
  await expect(from).toHaveValue('');
  await expect(to).toHaveValue('');
  await expect(page.getByTestId('esg-device-date-error')).toHaveCount(0);
  await expect(page.getByTestId('esg-device-query-hint')).toHaveCount(0);
  await expect(page.getByTestId('esg-device-export-job')).toHaveCount(0);
  await expect.poll(() => reports.slice(-2)).toEqual([base, { ...base, cursor: 'all-page-2' }]);
  await exportButton.click();
  await expect.poll(() => exports.at(-1)).toEqual({ dataset: 'REPORTS', customerId: 'cust-a' });

  const discarded = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get('from') === changedRange.from,
  );
  delayChangedQuery = false;
  releaseOldPage();
  await discarded;
  await selectScope();
  await from.fill('2026-10-02');
  await to.fill('2026-10-02');
  await apply.click();
  await expect.poll(() => reports.slice(-2)).toEqual([changed, { ...changed, cursor: 'filtered-page-2' }]);
  expect(reports.some((query) => query['cursor'] === 'discarded-page')).toBe(false);
});
