import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, p0Alarm, p0Device, routeFe11To15Apis, seedSession } from './qa05-api-fixtures.js';

async function mockFilters(page: Page) {
  await routeFe11To15Apis(page);
  await page.route('**/api/v1/admin/onboarding/requests**', (route) =>
    json(route, { data: [], meta: { nextCursor: null } }),
  );
  await page.route('**/api/v1/admin/consumables**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/consumable-requests**', (route) => json(route, { data: [] }));
  await page.route('**/api/v1/admin/settings/alarm.thresholds', (route) =>
    json(route, { error: { code: 'FORBIDDEN', message: 'fixture' } }, 403),
  );
}

function filteredRequest(page: Page, endpoint: string, params: Record<string, string>) {
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      request.method() === 'GET' &&
      url.pathname === `/api/v1/admin/${endpoint}` &&
      Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value)
    );
  });
}

async function verifyControls(page: Page, layout: Locator) {
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await layoutViolations(page)).toEqual([]);
    const issues = await layout.evaluate((node) => {
      const panel = node.getBoundingClientRect();
      const actionRow = node.querySelector('.filter-actions')?.getBoundingClientRect();
      const controls = [
        ...node.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.filter-fields input, .filter-fields select'),
      ];
      return controls.flatMap((control) => {
        const rect = control.getBoundingClientRect();
        const label = control.labels?.[0];
        const validLabel =
          label?.textContent?.trim() && label.closest('.filter-field') === control.closest('.filter-field');
        const withinPanel = rect.left >= panel.left && rect.right <= panel.right + 1 && rect.height >= 35;
        const outsideActions = actionRow === undefined || rect.bottom <= actionRow.top;
        return validLabel && withinPanel && outsideActions ? [] : [control.id];
      });
    });
    expect(issues).toEqual([]);
  }
  await page.setViewportSize({ width: 375, height: 900 });
}

for (const language of ['zh-CN', 'en']) {
  test(`T05 filters keep labels, actions and query semantics in ${language}`, async ({ page }) => {
    test.setTimeout(90_000);
    await seedSession(page, 'PlatformSuperAdmin');
    await page.addInitScript((locale) => window.localStorage.setItem('fdp.admin.lang.v1', locale), language);
    await mockFilters(page);
    const longId = (language === 'en' ? 'device-with-long-reference-' : '很长的设备引用编号').repeat(6);
    const longName = (
      language === 'en' ? 'Customer with a very long account name ' : '用于布局验证的超长客户名称'
    ).repeat(8);
    await page.route('**/api/v1/admin/customers**', (route) =>
      json(route, { data: [{ id: 'cust-a', name: longName }], meta: { nextCursor: null } }),
    );

    await page.goto('/consumables');
    await page.getByTestId('consumable-filter-site').fill(longId);
    await page.getByTestId('consumable-filter-max').fill('30');
    await verifyControls(page, page.getByTestId('consumable-status-filter'));
    const consumables = filteredRequest(page, 'consumables', { siteId: longId, maxRemainingPercent: '30' });
    await page.getByTestId('consumable-search').click();
    await consumables;
    await page.getByTestId('request-filter-device').fill(longId);
    await verifyControls(page, page.getByTestId('consumable-request-filter'));
    const requests = filteredRequest(page, 'consumable-requests', { deviceId: longId });
    await page.getByTestId('request-filter-search').click();
    await requests;

    await page.goto('/alarms');
    await page.getByTestId('filter-customer').selectOption('cust-a');
    await page.getByTestId('filter-severity').selectOption('CRITICAL');
    await verifyControls(page, page.getByTestId('alarm-filter-bar'));
    const alarms = filteredRequest(page, 'alarms', { severity: 'CRITICAL', customerId: 'cust-a' });
    await page.getByTestId('filter-search').click();
    await alarms;
    await page.getByTestId('tab-event').click();
    await expect(page.getByTestId('filter-severity')).toHaveCount(0);
    await expect(page.getByTestId('filter-status')).toHaveCount(0);
    await page.getByTestId('filter-event-type').fill('SYNC');
    const events = filteredRequest(page, 'events', { eventType: 'SYNC' });
    await page.getByTestId('filter-search').click();
    await events;
    await page.getByTestId('tab-tamper').click();
    await expect(page.getByTestId('filter-event-type')).toBeVisible();
    await expect(page.getByTestId('filter-status')).toHaveCount(0);
    await page.getByTestId('filter-severity').selectOption('CRITICAL');
    const tamper = filteredRequest(page, 'tamper-events', { severity: 'CRITICAL' });
    await page.getByTestId('filter-search').click();
    await tamper;
    await page.getByTestId('filter-customer').selectOption('cust-a');
    const platformScope = filteredRequest(page, 'tamper-events', { customerId: 'cust-a', severity: 'CRITICAL' });
    await page.getByTestId('filter-search').click();
    await platformScope;
    const resetTamper = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/v1/admin/tamper-events' && url.search === '';
    });
    await page.getByTestId('filter-reset').click();
    await resetTamper;
    await expect(page.getByTestId('filter-customer')).toHaveValue('');

    await page.goto('/media');
    await page.getByTestId('media-filter-device').fill(longId);
    await page.getByTestId('media-filter-customer').fill('cust-a');
    await verifyControls(page, page.getByTestId('media-filter').locator('.filter-bar--stacked'));
    const media = filteredRequest(page, 'media', { deviceId: longId, customerId: 'cust-a' });
    await page.getByTestId('media-filter-search').click();
    await media;

    await page.goto('/esg/overview');
    await page.getByTestId('esg-customer-filter').selectOption('cust-a');
    await page.getByTestId('period-week').click();
    await expect(page.getByTestId('period-week')).toHaveAttribute('aria-pressed', 'true');
    await verifyControls(page, page.getByTestId('esg-overview-filter'));
    const esg = filteredRequest(page, 'esg/daily-summary', { customerId: 'cust-a' });
    await page.getByTestId('esg-apply').click();
    await esg;

    await page.goto('/sites');
    await expect(page.getByTestId('site-toolbar').getByTestId('create-site')).toBeVisible();
    await page.locator('#filter-customer').selectOption('cust-a');
    await verifyControls(page, page.getByTestId('site-filters'));
    const sites = filteredRequest(page, 'sites', { customerId: 'cust-a', region: longId });
    await page.locator('#filter-region').fill(longId);
    await sites;

    await page.goto('/audit-logs');
    await page.getByTestId('audit-filter-actor').fill(longId);
    await page.getByTestId('audit-filter-object-id').fill(longId);
    await verifyControls(page, page.getByTestId('audit-filter').locator('.filter-bar--stacked'));
    const audit = filteredRequest(page, 'audit-logs', { actorId: longId, objectId: longId });
    await page.getByTestId('audit-filter-search').click();
    await audit;

    await page.goto('/configurations');
    const toolbar = page.getByTestId('config-toolbar');
    const config = page.getByTestId('config-filter-bar');
    const create = await toolbar.getByTestId('config-create').boundingBox();
    const filters = await config.boundingBox();
    expect(create!.y + create!.height).toBeLessThan(filters!.y);
    expect(create!.x).toBe(filters!.x);
    await page.getByTestId('config-filter-model').fill(longId);
    await verifyControls(page, config);
    const configurations = filteredRequest(page, 'configurations', { targetModel: longId });
    await page.getByTestId('config-search').click();
    await configurations;
    await page.getByTestId('config-reset').click();
    await expect(page.getByTestId('config-filter-model')).toHaveValue('');

    await page.goto('/devices/operate');
    const quick = page.getByTestId('quick-actions');
    await expect(quick.locator('.quick-action-group')).toHaveCount(6);
    await expect(quick.getByTestId('quick-action-reasons').locator('li')).toHaveCount(1);
    const reasonId = await quick.getByTestId('quick-reboot').getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    await expect(quick.locator(`[id="${reasonId}"]`)).toBeVisible();
    await expect(quick.getByTestId('quick-factoryReset')).toBeDisabled();
    expect(await layoutViolations(page)).toEqual([]);
  });
}

for (const language of ['zh-CN', 'en']) {
  const resetLabel = language === 'en' ? 'Reset' : '重置';
  const nextLabel = language === 'en' ? 'Next' : '下一页';
  const longId = (language === 'en' ? 'long-reference-' : '很长的引用编号').repeat(8);
  const tabs = { alarm: 'alarms', event: 'events', tamper: 'tamper-events' } as const;

  test(`CMP-20 resets each tab to its scoped first page in ${language}`, async ({ page }) => {
    test.setTimeout(90_000);
    await seedSession(page, 'CustomerAdmin', { customerId: 'cust-a' });
    await page.addInitScript((locale) => window.localStorage.setItem('fdp.admin.lang.v1', locale), language);
    await mockFilters(page);
    for (const [tab, endpoint] of Object.entries(tabs)) {
      const received: Record<string, string>[] = [];
      await page.route(`**/api/v1/admin/${endpoint}**`, (route) => {
        const url = new URL(route.request().url());
        const query = Object.fromEntries(url.searchParams);
        received.push(query);
        const position = query['cursor'] ? 'second' : 'first';
        return json(route, {
          data: [
            {
              ...p0Alarm,
              alarmId: position,
              eventId: position,
              tamperEventId: position,
              occurredAt: p0Alarm.detectedTime,
              deviceId: `device-${position}`,
            },
          ],
          meta: { nextCursor: query['cursor'] ? null : 'alarm-next' },
        });
      });
      await page.goto(`/alarms?tab=${tab}`);
      const layout = page.getByTestId('alarm-filter-bar');
      const reset = layout.getByRole('button', { name: resetLabel, exact: true });
      const table = page.getByTestId('cursor-table');
      const next = table.getByRole('button', { name: nextLabel, exact: true });
      const from = '2026-09-01T00:00:00Z';
      const to = '2026-09-11T00:00:00Z';
      const fixed = { customerId: 'cust-a' };
      const active = {
        ...fixed,
        siteId: p0Device.site.id,
        deviceId: p0Device.id,
        from,
        to,
        ...(tab === 'alarm' ? { status: 'ACTIVE' } : { eventType: longId }),
        ...(tab === 'event' ? {} : { severity: 'CRITICAL' }),
      };
      await expect(reset).toHaveCount(1);
      await expect(layout.getByTestId('filter-customer')).toHaveCount(0);
      await layout.getByTestId('filter-site').selectOption(p0Device.site.id);
      await layout.getByTestId('filter-device').selectOption(p0Device.id);
      await layout.getByTestId('filter-from').fill(from);
      await layout.getByTestId('filter-to').fill(to);
      if (tab === 'alarm') await layout.getByTestId('filter-status').selectOption('ACTIVE');
      else await layout.getByTestId('filter-event-type').fill(longId);
      if (tab !== 'event') await layout.getByTestId('filter-severity').selectOption('CRITICAL');
      await verifyControls(page, layout);
      await layout.getByTestId('filter-search').click();
      await expect.poll(() => received.at(-1)).toEqual(active);
      await expect(table).toHaveAttribute('aria-busy', 'false');
      await next.click();
      await expect.poll(() => received.at(-1)).toEqual({ ...active, cursor: 'alarm-next' });
      await expect(table.getByText('device-second')).toBeVisible();

      await reset.click();
      await expect.poll(() => received.at(-1)).toEqual(fixed);
      await expect(table.getByText('device-first')).toBeVisible();
      await expect(table.getByText('device-second')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/alarms\\?tab=${tab}&customerId=cust-a$`));
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
      for (const field of await layout.locator('input, select').all()) await expect(field).toHaveValue('');

      // The reset still fetches page one if the applied URL is already at its defaults.
      await next.click();
      await expect(table.getByText('device-second')).toBeVisible();
      await layout.getByTestId('filter-to').fill(to);
      await reset.focus();
      await reset.press('Enter');
      await expect(table.getByText('device-first')).toBeVisible();
      await expect.poll(() => received.at(-1)).toEqual(fixed);
      await expect(layout.getByTestId('filter-to')).toHaveValue('');
    }
  });

  test(`CMP-43 resets all audit filters and rejects stale pages in ${language}`, async ({ page }) => {
    await seedSession(page, 'Auditor');
    await page.addInitScript((locale) => {
      window.localStorage.setItem('fdp.admin.lang.v1', locale);
      window.localStorage.setItem('fdp.admin.time-zone.v1', 'Asia/Shanghai');
    }, language);
    await mockFilters(page);
    const received: Record<string, string>[] = [];
    let releasePendingPage!: () => void;
    const pendingPage = new Promise<void>((resolve) => {
      releasePendingPage = resolve;
    });
    await page.route('**/api/v1/admin/audit-logs**', async (route) => {
      const query = Object.fromEntries(new URL(route.request().url()).searchParams);
      received.push(query);
      if (query['cursor'] === 'audit-pending') await pendingPage;
      const auditId = query['cursor'] ?? 'first-audit';
      await json(route, {
        data: [
          {
            auditId,
            actorId: 'operator-1',
            actorRole: 'PlatformOperator',
            customerId: 'cust-a',
            objectType: 'Device',
            objectId: auditId,
            action: 'COMMAND_CREATED',
            result: 'SUCCESS',
            createdAt: '2026-09-10T00:00:00Z',
          },
        ],
        meta: { nextCursor: query['cursor'] ? 'audit-pending' : 'audit-second' },
      });
    });
    await page.goto('/audit-logs');
    const layout = page.getByTestId('audit-filter');
    const reset = layout.getByRole('button', { name: resetLabel, exact: true });
    const search = layout.getByTestId('audit-filter-search');
    const active = {
      actorId: longId,
      customerId: 'cust-a',
      objectType: 'Device',
      objectId: longId,
      action: 'COMMAND_CREATED',
      result: 'SUCCESS',
      from: '2026-09-09T16:00:00.000Z',
      to: '2026-09-11T16:00:00.000Z',
    };
    await layout.getByTestId('audit-filter-actor').fill(active.actorId);
    await layout.getByTestId('audit-filter-customer').fill(active.customerId);
    await layout.getByTestId('audit-filter-object-type').fill(active.objectType);
    await layout.getByTestId('audit-filter-object-id').fill(active.objectId);
    await layout.getByTestId('audit-filter-action').fill(active.action);
    await layout.getByTestId('audit-filter-result').selectOption(active.result);
    await layout.getByTestId('audit-filter-from').fill('2026-09-10T00:00');
    await layout.getByTestId('audit-filter-to').fill('2026-09-12T00:00');
    await verifyControls(page, layout.locator('.filter-bar--stacked'));
    await expect(reset).toHaveCount(1);
    await search.click();
    await expect.poll(() => received.at(-1)).toEqual(active);
    const table = page.getByTestId('cursor-table');
    const next = table.getByRole('button', { name: nextLabel, exact: true });
    await next.click();
    await expect(table.getByTestId('audit-detail-audit-second')).toBeVisible();
    await expect.poll(() => received.at(-1)).toEqual({ ...active, cursor: 'audit-second' });
    try {
      await next.click();
      await expect.poll(() => received.at(-1)).toEqual({ ...active, cursor: 'audit-pending' });
      await layout.getByTestId('audit-filter-to').fill('2026-09-08T00:00');
      await expect(search).toBeDisabled();
      await expect(layout.getByTestId('audit-filter-time-error')).toBeVisible();
      await reset.focus();
      await reset.press('Enter');
      await expect.poll(() => received.at(-1)).toEqual({});
      await expect(table.getByTestId('audit-detail-first-audit')).toBeVisible();
      await expect(table.getByTestId('audit-detail-audit-second')).toHaveCount(0);
      await expect(search).toBeEnabled();
      await expect(layout.getByTestId('audit-filter-time-error')).toHaveCount(0);
      for (const field of await layout.locator('input, select').all()) await expect(field).toHaveValue('');
      const late = page.waitForResponse(
        (result) => new URL(result.url()).searchParams.get('cursor') === 'audit-pending',
      );
      releasePendingPage();
      await (await late).finished();
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await expect(table.getByTestId('audit-detail-audit-pending')).toHaveCount(0);
    } finally {
      releasePendingPage();
    }
  });
}

test('CMP-09 one device-group reset returns to scoped page one and clears every editable filter', async ({ page }) => {
  await seedSession(page, 'CustomerAdmin', { customerId: 'cust-a' });
  await mockFilters(page);
  const received: Record<string, string>[] = [];
  await page.route('**/api/v1/admin/devices**', (route) => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    received.push(query);
    return json(route, {
      data: query['cursor'] ? [] : [p0Device],
      meta: { nextCursor: query['cursor'] ? null : 'next-fixture' },
    });
  });
  await page.goto('/devices/groups');
  const layout = page.getByTestId('device-filter-bar');
  const reset = layout.getByRole('button', { name: '重置' });
  await expect(reset).toHaveCount(1);
  await layout.locator('#scope-region').selectOption(p0Device.site.region);
  await layout.locator('#scope-subregion').selectOption(p0Device.site.subregion);
  await layout.locator('#scope-site').selectOption(p0Device.site.id);
  await page.getByTestId('device-keyword').fill('SN-P0');
  await page.getByTestId('filter-connectivity').selectOption('ONLINE');
  await verifyControls(page, layout);
  const active = {
    customerId: 'cust-a',
    limit: '50',
    keyword: 'SN-P0',
    region: 'CN',
    subregion: 'SH',
    siteId: p0Device.site.id,
    connectivity: 'ONLINE',
  };
  await page.getByTestId('device-search').click();
  await expect.poll(() => received.at(-1)).toEqual(active);
  const devices = page.getByTestId('cursor-table').first();
  await devices.getByRole('button', { name: '下一页' }).click();
  await expect.poll(() => received.at(-1)).toEqual({ ...active, cursor: 'next-fixture' });
  await expect(devices.getByTestId('table-empty')).toBeVisible();
  await expect(layout.locator('#scope-site')).toHaveValue(p0Device.site.id);
  await expect(devices.getByRole('button', { name: '上一页' })).toBeEnabled();
  await reset.click();
  await expect.poll(() => received.at(-1)).toEqual({ customerId: 'cust-a', limit: '50' });
  await expect(devices.getByRole('button', { name: '上一页' })).toBeDisabled();
  for (const field of await layout.locator('input, select').all()) await expect(field).toHaveValue('');

  await page.goto('/sites');
  await expect(page.locator('#filter-customer')).toBeDisabled();
  await expect(page.locator('#filter-customer')).toHaveValue('cust-a');
  const sites = filteredRequest(page, 'sites', { customerId: 'cust-a', region: 'CN' });
  await page.locator('#filter-region').fill('CN');
  await sites;
});
