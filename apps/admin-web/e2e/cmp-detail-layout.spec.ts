import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, p0Alarm, p0Device, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

const time = '2026-09-10T00:00:00Z';
const longValue = 'synthetic-detailed-record-'.repeat(24);

test('CMP-14 and CMP-15 keep configuration history bounded and let the keyboard reach earlier versions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page);
  const summary = {
    configurationId: 'cmp-configuration',
    name: 'CMP configuration',
    targetModel: null,
    targetDeviceId: 'cmp-device',
    versionCount: 24,
    latestPublishedVersion: 23,
    createdBy: 'fixture-admin',
    createdAt: time,
  };
  const versions = Array.from({ length: 24 }, (_, index) => ({
    configurationId: summary.configurationId,
    versionId: 'fixture-version-' + (index + 1),
    version: index + 1,
    status: index === 23 ? 'DRAFT' : 'PUBLISHED',
    createdAt: time,
    effectiveAt: index === 23 ? null : time,
    changeNote: index === 0 ? longValue : null,
    payload: { heartbeatInterval: 60, telemetryInterval: 30, cameraRefreshInterval: 5, temperatureThreshold: 85 },
  }));
  const empty = { ...summary, configurationId: 'cmp-empty', name: 'Empty configuration', versionCount: 0 };
  let reads = 0;
  let statusReads = 0;
  await page.route('**/api/v1/admin/configurations**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) {
      statusReads += 1;
      return json(route, {
        data: {
          configurationId: summary.configurationId,
          version: 1,
          effectiveAt: time,
          status: 'PUBLISHED',
          targets: [],
        },
      });
    }
    if (path.endsWith('/cmp-empty')) return json(route, { data: { ...empty, derivedContext: null, versions: [] } });
    if (path.endsWith('/cmp-configuration')) {
      if (++reads === 1) return json(route, { error: { code: 'UNAVAILABLE', message: 'fixture retry' } }, 503);
      return json(route, {
        data: {
          ...summary,
          versions,
          derivedContext: { alias: longValue, site: 'Fixture site', region: null, subregion: null, contract: null },
        },
      });
    }
    return json(route, { data: [summary, empty] });
  });

  await page.goto('/configurations');
  const opener = page.getByTestId('config-detail-open-cmp-configuration');
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('config-detail');
  await expect(dialog.getByRole('alert')).toContainText('fixture retry');
  await dialog.getByRole('button', { name: '重试' }).click();
  await expect(dialog.getByTestId('config-derived-context')).toContainText(longValue);
  const history = dialog.getByTestId('config-history-scroll');
  await expect(history.locator('summary').first()).toContainText('v24');
  await expect(history.locator('details[open]')).toHaveCount(0);
  expect(await history.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(statusReads).toBe(0);
  const oldest = history.getByTestId('config-expand-1');
  await dialog.getByRole('button', { name: '关闭' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(oldest).toBeFocused();

  await history.focus();
  await page.keyboard.press('End');
  await expect.poll(() => history.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await oldest.focus();
  await page.keyboard.press('Enter');
  await expect(history.getByTestId('config-version-1-payload')).toBeVisible();
  await expect(history.getByTestId('config-version-1')).toContainText(longValue);
  await expect(history.getByTestId('config-publish-1')).toBeDisabled();
  await history.getByTestId('config-sync-1').click();
  await expect(history.getByTestId('config-sync-empty-1')).toBeVisible();
  expect(statusReads).toBe(1);
  await history.getByTestId('config-expand-24').click();
  await expect(history.getByTestId('config-version-1-payload')).toBeHidden();
  await history.getByTestId('config-publish-24').click();
  await expect(page.getByTestId('config-publish-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(history.getByTestId('config-publish-24')).toBeFocused();
  expect(await layoutViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();

  await page.getByTestId('config-detail-open-cmp-empty').click();
  await expect(dialog.getByTestId('config-versions-empty')).toBeVisible();
});

const site = {
  id: 'site-0',
  customerId: 'cust-a',
  name: 'Fixture site',
  status: 'ACTIVE',
  region: 'CN',
  subregion: null,
  address: longValue,
  timezone: 'Asia/Shanghai',
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  deviceCount: 2,
  version: 2,
  createdAt: time,
  updatedAt: time,
};

test('CMP-41 returns to the same row and scroll position and uses the latest site version for nested writes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page);
  const rows = Array.from({ length: 24 }, (_, index) => ({ ...site, id: 'site-' + index }));
  let current = { ...site, id: 'site-20', version: 4 };
  let reads = 0;
  const writes: { method: string; version: string | undefined; body: unknown }[] = [];
  await page.route('**/api/v1/admin/sites**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), version: request.headers()['if-match'], body: request.postDataJSON() });
      if (request.method() === 'PATCH') {
        current = { ...current, ...request.postDataJSON(), version: 5 };
      } else {
        current = { ...current, status: 'SUSPENDED', version: 6 };
      }
      return json(route, { data: current });
    }
    if (path.endsWith('/site-20')) {
      if (++reads === 1) return json(route, { error: { code: 'UNAVAILABLE', message: 'fixture site retry' } }, 503);
      return json(route, { data: current });
    }
    return json(route, {
      data: rows.map((row) => (row.id === current.id && writes.length ? current : row)),
      meta: { nextCursor: null },
    });
  });
  await page.goto('/sites');
  const opener = page.getByTestId('detail-site-20');
  await opener.scrollIntoViewIfNeeded();
  await opener.focus();
  const scrollPosition = () =>
    page.evaluate(() => [window.scrollY, document.querySelector('.table-scroll')?.scrollLeft]);
  const before = await scrollPosition();
  expect(before[0]).toBeGreaterThan(0);
  expect(before[1]).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  const details = page.getByTestId('site-detail');
  await expect(details.getByRole('alert')).toContainText('fixture site retry');
  await details.getByRole('button', { name: '重试' }).click();
  await expect(details).toContainText(longValue);
  expect(await layoutViolations(page)).toEqual([]);
  const close = details.getByRole('button', { name: '关闭' });
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(details.getByTestId('deactivate-site')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  expect(await scrollPosition()).toEqual(before);

  await page.keyboard.press('Enter');
  const edit = details.getByTestId('edit-site');
  await edit.click();
  await page.getByLabel('站点名称').fill('Unsaved fixture');
  await page.keyboard.press('Escape');
  await expect(edit).toBeFocused();
  await expect(details).toContainText('Fixture site');
  expect(writes).toEqual([]);
  await edit.click();
  await page.getByLabel('站点名称').fill('Updated fixture');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(details).toContainText('Updated fixture');
  expect(writes[0]).toMatchObject({ method: 'PATCH', version: '4', body: { name: 'Updated fixture' } });

  const deactivate = details.getByTestId('deactivate-site');
  await deactivate.click();
  await expect(page.getByRole('button', { name: '确认停用' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(deactivate).toBeFocused();
  expect(writes).toHaveLength(1);
  await deactivate.click();
  await page.getByLabel('停用原因').fill('Fixture site deactivation');
  await page.getByRole('button', { name: '确认停用' }).click();
  await expect(details.getByTestId('site-status')).toHaveText('已停用');
  expect(writes[1]).toEqual({ method: 'POST', version: '5', body: { reason: 'Fixture site deactivation' } });
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  expect(await scrollPosition()).toEqual(before);
});

test('CMP-10 and CMP-21 show scoped detail sections, long values and the existing action gates', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await seedSession(page, 'Auditor');
  await page.addInitScript(() => window.localStorage.setItem('fdp.admin.lang.v1', 'en'));
  await routeP0Apis(page, { alarmRows: true });
  await page.route('**/admin/devices/dev-p0', (route) => json(route, { data: { ...p0Device, alias: longValue } }));
  await page.route('**/admin/alarms/alarm-p0', (route) =>
    json(route, {
      data: { ...p0Alarm, status: 'CLEARED', clearedAt: time, clearReason: longValue, message: longValue },
    }),
  );
  await page.goto('/devices/manage?deviceId=dev-p0');
  const identity = page.getByTestId('device-manage-summary');
  await expect(identity).toContainText(p0Device.model);
  await expect(identity.locator('[data-axis]')).toHaveCount(4);
  await expect(page.getByTestId('action-retire')).toBeDisabled();
  await expect(page.getByTestId('configuration-entry')).toBeVisible();
  await expect(page.getByTestId('ota-entry')).toContainText(p0Device.firmwareVersion);
  await expect(page.getByTestId('alias-current')).toHaveText(longValue);
  await expect(page.getByTestId('cert-id')).toHaveText(p0Device.certificate.certificateId);
  await expect(page.getByTestId('assignments-empty')).toBeVisible();
  expect(await layoutViolations(page)).toEqual([]);

  await page.goto('/alarms');
  const opener = page.getByTestId('alarm-detail-alarm-p0');
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('alarm-detail-panel')).toBeFocused();
  const details = page.getByTestId('alarm-detail');
  await expect(details.getByTestId('detail-status')).toHaveText('Cleared');
  await expect(details.getByRole('region', { name: 'Detection and resolution' })).toContainText(longValue);
  await expect(details.getByRole('region', { name: 'Readings and guidance' })).toContainText(longValue);
  await expect(details.getByRole('region', { name: 'Archived image' })).toBeVisible();
  await expect(details.getByTestId('alarm-acknowledge')).toBeDisabled();
  await expect(details.getByTestId('alarm-clear')).toBeDisabled();
  expect(await layoutViolations(page)).toEqual([]);
  await details.getByRole('button', { name: 'Close' }).click();
  await expect(opener).toBeFocused();
});
