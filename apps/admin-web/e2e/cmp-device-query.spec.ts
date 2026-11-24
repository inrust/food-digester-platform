import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, p0Console, p0Device, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

test('R03 refreshing the device console replaces offline history with newly reported component status', async ({
  page,
}) => {
  await seedSession(page, 'CustomerViewer', { customerId: 'cust-a' });
  await routeP0Apis(page);
  const oldHeartbeat = '2026-09-10T00:00:00.000Z';
  const newHeartbeat = '2026-09-10T00:20:00.000Z';
  let current = {
    ...p0Console,
    generatedAt: newHeartbeat,
    device: { ...p0Console.device, connectivity: 'OFFLINE' },
    components: { ...p0Console.components, stale: true, observedAt: oldHeartbeat },
    latestMedia: null,
  };
  await page.route('**/api/v1/admin/devices/dev-p0/console', (route) => json(route, { data: current }));

  await page.goto('/devices/view?deviceId=dev-p0');
  const console = page.getByTestId('device-console');
  const connectivity = console.locator('[data-axis="connectivity"]');
  const heartbeat = console.getByTestId('console-last-heartbeat').locator('time');
  const components = console.getByTestId('console-components');
  await expect(connectivity).toHaveAttribute('data-value', 'OFFLINE');
  await expect(heartbeat).toHaveAttribute('datetime', oldHeartbeat);
  await expect(components.getByTestId('stale-tag')).toBeVisible();
  await expect(components.getByTestId('component-overall')).toContainText('历史状态（正常）');

  current = {
    ...current,
    device: { ...current.device, connectivity: 'ONLINE' },
    components: { ...current.components, stale: false, observedAt: newHeartbeat },
  };
  await page.getByRole('button', { name: '刷新设备状态' }).click();
  await expect(connectivity).toHaveAttribute('data-value', 'ONLINE');
  await expect(heartbeat).toHaveAttribute('datetime', newHeartbeat);
  await expect(components.getByTestId('stale-tag')).toHaveCount(0);
  await expect(components.getByTestId('component-overall').locator('.value')).toHaveText('正常');
});

test('CMP-05 scoped picker recovers from errors and supports tagged and untagged sites', async ({ page }) => {
  await seedSession(page, 'CustomerViewer', { customerId: 'cust-a' });
  const untagged = {
    ...p0Device,
    id: 'dev-untagged',
    alias: '缺少地区标签的设备',
    serialNumber: 'SN-NO-REGION',
    site: { ...p0Device.site, id: 'site-untagged', region: null, subregion: null },
  };
  const unassigned = { ...p0Device, id: 'dev-unassigned', customer: null, site: null };
  const outsideScope = { ...p0Device, id: 'dev-other-customer', customer: { id: 'cust-b', name: '租户 B' } };
  let listLoads = 0;
  await routeP0Apis(page);
  await page.route('**/api/v1/admin/devices**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/devices')) {
      listLoads += 1;
      expect(url.searchParams.get('customerId')).toBe('cust-a');
      if (listLoads === 1) {
        return json(route, { error: { code: 'UNAVAILABLE', message: 'Device list unavailable' } }, 503);
      }
      return json(route, { data: [p0Device, untagged, unassigned, outsideScope], meta: { nextCursor: null } });
    }
    if (url.pathname.endsWith('/dev-untagged')) return json(route, { data: untagged });
    if (url.pathname.endsWith('/dev-untagged/console')) {
      return json(route, {
        data: {
          ...p0Console,
          device: {
            ...p0Console.device,
            deviceId: untagged.id,
            alias: untagged.alias,
            serialNumber: untagged.serialNumber,
          },
          latestMedia: null,
        },
      });
    }
    return route.fallback();
  });

  await page.goto('/devices/view');
  const apply = page.getByTestId('view-apply');
  const devices = page.locator('#scope-device');
  await expect(page.getByTestId('device-picker-error')).toContainText('Device list unavailable');
  await expect(apply).toBeDisabled();
  await page.getByRole('button', { name: '重新加载设备选项' }).click();
  await expect(devices.locator('option')).toHaveCount(3);
  await expect(devices.locator('option[value="dev-other-customer"]')).toHaveCount(0);
  await expect(devices.locator('option[value="dev-unassigned"]')).toHaveCount(0);

  await page.locator('#scope-region').selectOption(p0Device.site.region);
  await page.locator('#scope-subregion').selectOption(p0Device.site.subregion);
  await page.locator('#scope-site').selectOption(p0Device.site.id);
  await devices.selectOption(p0Device.id);
  await apply.click();
  await expect(page.getByTestId('device-console')).toContainText(p0Device.alias);

  await page.getByTestId('scope-filter').getByRole('button', { name: '重置' }).click();
  await expect(apply).toBeDisabled();
  await devices.selectOption(untagged.id);
  await apply.click();
  await expect(page.getByTestId('device-console')).toContainText(untagged.alias);
});

test('CMP-06 query separates draft from applied device and ignores late target replies', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page);
  await page.route('**/api/v1/admin/commands**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  const license = {
    licenseId: 'lic-fixture',
    status: 'Active',
    validFrom: '2026-01-01',
    validTo: '2027-01-01',
    entitlements: ['REMOTE_CONTROL'],
  };
  const first = { ...p0Device, license };
  const confirmed = { ...first, id: 'dev-confirmed', alias: '已确认目标', serialNumber: 'SN-CONFIRMED', site: null };
  const slow = { ...first, id: 'dev-slow', alias: '迟到的设备', serialNumber: 'SN-SLOW' };
  const failed = { ...first, id: 'dev-failed', alias: '读取失败的设备', serialNumber: 'SN-FAILED' };
  const devices = [first, confirmed, slow, failed];
  const reads: string[] = [];
  const writes: string[] = [];
  let releaseSlow!: () => void;
  const pendingRead = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  await page.route('**/api/v1/admin/devices**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const [, , , , , id, action] = path.split('/');
    if (!id) return json(route, { data: devices, meta: { nextCursor: null } });
    if (action === 'commands' && route.request().method() === 'POST') {
      writes.push(id);
      return json(route, {
        data: { commandId: 'cmp-06-command', status: 'AUTHORIZED', replayed: false, requestedBy: 'fixture' },
      });
    }
    if (action === 'console') return json(route, { data: { ...p0Console, latestMedia: null } });
    if (action) return route.fallback();
    reads.push(id);
    if (id === slow.id) await pendingRead;
    if (id === failed.id) {
      return json(route, { error: { code: 'UNAVAILABLE', message: 'Target unavailable' } }, 503);
    }
    return json(route, { data: devices.find((device) => device.id === id) });
  });

  await page.goto('/devices/operate?deviceId=dev-p0');
  const query = page.getByTestId('operate-apply');
  const picker = page.locator('#scope-device');
  const reboot = page.getByTestId('quick-reboot');
  await expect(reboot).toBeEnabled();
  await expect(page.getByTestId('operate-target')).toContainText(first.serialNumber);
  await picker.selectOption(confirmed.id);
  await expect(reboot).toBeDisabled();
  await expect(page).toHaveURL(/deviceId=dev-p0$/);
  expect(reads).not.toContain(confirmed.id);

  await picker.selectOption(slow.id);
  const slowRequested = page.waitForRequest((request) => request.url().endsWith('/dev-slow'));
  await query.click();
  await slowRequested;
  await expect(page.getByTestId('operate-target-loading')).toBeVisible();
  await expect(reboot).toBeDisabled();
  await picker.selectOption(failed.id);
  await query.click();
  await expect(page.getByTestId('operate-target-error')).toContainText('Target unavailable');
  await expect(reboot).toBeDisabled();
  await expect(page.getByTestId('operate-target')).toHaveCount(0);
  expect(writes).toEqual([]);

  await picker.selectOption(confirmed.id);
  await query.click();
  await expect(page.getByTestId('operate-target')).toContainText(confirmed.serialNumber);
  const late = page.waitForResponse((response) => response.url().endsWith('/dev-slow'));
  releaseSlow();
  await late;
  await expect(reboot).toBeEnabled();
  await reboot.click();
  await expect(page.getByTestId('command-target')).toContainText(`${confirmed.serialNumber} · ${confirmed.id}`);
  await page.getByTestId('command-submit').click();
  await expect(page.getByTestId('action-notice')).toContainText('cmp-06-command');
  expect(writes).toEqual([confirmed.id]);
});

async function expectUnobstructed(select: Locator, button: Locator) {
  await expect(select).toBeVisible();
  await expect(button).toBeEnabled();
  const field = (await select.boundingBox())!;
  const action = (await button.boundingBox())!;
  const overlapX = field.x < action.x + action.width && action.x < field.x + field.width;
  const overlapY = field.y < action.y + action.height && action.y < field.y + field.height;
  expect(overlapX && overlapY).toBe(false);
}

for (const language of ['zh-CN', 'en']) {
  test(`CMP-08/26 long labels fit filter controls in ${language}`, async ({ page }) => {
    await seedSession(page, 'PlatformSuperAdmin');
    await page.addInitScript((locale) => window.localStorage.setItem('fdp.admin.lang.v1', locale), language);
    await routeP0Apis(page);
    await page.route('**/api/v1/admin/contracts**', (route) => json(route, { data: [] }));
    const name = language === 'zh-CN' ? '包含很长名称的客户账户'.repeat(10) : 'Long customer account name '.repeat(10);
    await page.route('**/api/v1/admin/customers**', (route) =>
      json(route, { data: [{ id: 'cust-long', name }], meta: { nextCursor: null } }),
    );
    await page.route('**/api/v1/admin/commands**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
    await page.goto('/devices/operate?deviceId=dev-p0');
    const commands = page.getByTestId('cmd-filter-command');
    const commandSearch = page.getByTestId('cmd-filter-search');
    await commands.selectOption('SET_TARGET_TEMPERATURE');
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectUnobstructed(commands, commandSearch);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    const commandFilter = page.waitForRequest((request) => request.url().includes('command=SET_TARGET_TEMPERATURE'));
    await commandSearch.click();
    await commandFilter;

    await page.goto('/contracts');
    const customers = page.getByTestId('contract-filter-customer');
    const contractSearch = page.getByTestId('contract-filter-search');
    await customers.selectOption('cust-long');
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectUnobstructed(customers, contractSearch);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    const filtered = page.waitForRequest((request) => request.url().includes('customerId=cust-long'));
    await contractSearch.click();
    await filtered;
  });
}
