import { expect, mergeTests } from '@playwright/test';
import { test as qa08Test } from './qa08-fixture.js';
import { test as qa05Test } from './qa05-fixture.js';
import { json, layoutViolations } from './qa05-api-fixtures.js';
const test = mergeTests(qa05Test, qa08Test);

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`UI redesign: all business routes at ${viewport.width}x${viewport.height}`, async ({
    page,
    qa08: q,
    qa05,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    for (const endpoint of ['alarms', 'audit-logs']) {
      await page.route(`**/api/v1/admin/${endpoint}**`, (route) =>
        json(route, { data: [], meta: { nextCursor: null } }),
      );
    }
    const routes = [
      '/dashboard',
      '/devices/groups',
      '/devices/view',
      '/devices/operate',
      `/devices/manage?deviceId=${q.f.deviceId}`,
      '/consumables',
      '/alarms',
      '/media',
      '/configurations',
      '/device-users',
      '/esg/overview',
      '/esg/devices',
      '/contracts',
      `/contracts/detail?contractId=${q.f.contractId}`,
      '/contracts/new',
      '/licenses',
      '/ota/campaigns',
      '/ota/packages',
      '/settings',
      '/customers',
      '/sites',
      '/audit-logs',
    ];
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByTestId('page-content')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('page-content').locator('h1,h2,h3').first()).toBeVisible();
      await expect(page.getByTestId('page-content').locator('.error-notice')).toHaveCount(0);
      expect(await layoutViolations(page), route).toEqual([]);
      expect(await page.getByTestId('sidebar').evaluate((element) => element.getBoundingClientRect().height)).toBe(
        viewport.height,
      );
      if (viewport.width === 1366 && ['/dashboard', '/devices/groups', '/settings', '/customers'].includes(route)) {
        await info.attach(route.slice(1).replaceAll('/', '-') + '.png', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      }
    }
    qa05.proof.desktopRoutes = true;
    qa05.proof.desktopLayout = true;
    // The long navigation remains independently scrollable at the minimum office size.
    await page.getByTestId('menu-item-/audit-logs').click();
    await expect(page).toHaveURL(/\/audit-logs$/);
    await page.goto('/settings');
    await page.getByTestId('user-invite-open').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('invite-email')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('invite-role-CustomerViewer')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('user-invite-open')).toBeFocused();
    qa05.proof.dialogKeyboard = true;
    await page.getByTestId('language-select').selectOption('en');
    await expect(page.getByTestId('menu-item-/dashboard')).toContainText('Overview');
    expect(await layoutViolations(page)).toEqual([]);
    qa05.proof.languageSwitch = true;
  });
}
