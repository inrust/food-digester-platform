import { createRequire } from 'node:module';
export async function recheckDeviceUserLayout({
  username,
  password,
  requireOverflow = true,
  emptyCustomerScope = false,
}) {
  const { chromium, expect } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))(
    '@playwright/test',
  );
  const browser = await chromium.launch({ headless: true });
  const r = {
    scope: 'ONLY_DEPLOYED_DEVICE_USER_375_EN_PREVIOUSLY_FAILED_COMBINATION',
    reads: [],
    writes: [],
    domMutation: false,
    fullQa09Accepted: false,
  };
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 1000 }, serviceWorkers: 'block' }),
      page = await context.newPage();
    page.on('request', (q) => {
      if (q.url().startsWith('https://api.bio-nexa.com/') && !['GET', 'OPTIONS'].includes(q.method()))
        r.writes.push(q.method());
    });
    page.on('response', (res) => {
      const u = new URL(res.url());
      if (u.origin === 'https://api.bio-nexa.com' && res.request().method() === 'GET')
        r.reads.push({ path: u.pathname, status: res.status(), requestId: res.headers()['x-amzn-requestid'] ?? null });
    });
    await page.goto('https://admin.bio-nexa.com/login');
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
    await page.getByTestId('language-select').selectOption('en');
    await page.goto('https://admin.bio-nexa.com/device-users');
    if (emptyCustomerScope) {
      await expect(page.getByTestId('device-user-empty')).toBeVisible();
      await expect(page.getByTestId('device-user-create')).toHaveCount(0);
      await page.waitForLoadState('networkidle');
      r.layout = await page.evaluate(() => ({
        width: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        locale: document.documentElement.lang,
        emptyCustomerScope: true,
      }));
      if (
        r.layout.width !== 375 ||
        r.layout.documentWidth > 376 ||
        r.layout.locale !== 'en' ||
        r.writes.length ||
        !r.reads.some((q) => q.path === '/api/v1/admin/device-users' && q.status === 200 && q.requestId) ||
        r.reads.some((q) => q.status >= 500)
      )
        throw Object.assign(Error('VIEWER_EMPTY_SCOPE_RECHECK_FAILED'), { layoutObservation: r });
      r.gate = 'PASS_DEPLOYED_VIEWER_DEVICE_USER_EMPTY_SCOPE_375_EN';
      return r;
    }
    await expect(page.getByTestId('device-user-table')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const region = page.getByRole('region', {
      name: await page.getByTestId('device-user-table').getAttribute('aria-label'),
      exact: true,
    });
    await expect(region).toHaveClass('table-scroll');
    await expect(region).toHaveAttribute('tabindex', '0');
    await region.focus();
    await page.keyboard.press('ArrowRight');
    if (requireOverflow)
      await page.waitForFunction(
        () => document.querySelector('.device-users-page .table-scroll').scrollLeft > 0,
        {},
        { timeout: 3000 },
      );
    r.layout = await page.evaluate(() => {
      const e = document.querySelector('.device-users-page .table-scroll');
      return {
        width: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        locale: document.documentElement.lang,
        tableScrollWidth: e.scrollWidth,
        tableClientWidth: e.clientWidth,
        keyboardScrollLeft: e.scrollLeft,
        rows: e.querySelector('table').rows.length,
      };
    });
    if (
      r.layout.width !== 375 ||
      r.layout.documentWidth > 376 ||
      r.layout.locale !== 'en' ||
      (requireOverflow && r.layout.keyboardScrollLeft <= 0) ||
      r.writes.length ||
      !r.reads.some((q) => q.path === '/api/v1/admin/device-users' && q.status === 200 && q.requestId) ||
      r.reads.some((q) => q.status >= 500)
    )
      throw Object.assign(Error('DEPLOYED_LAYOUT_RECHECK_FAILED'), { layoutObservation: r });
    r.gate = 'PASS_DEPLOYED_DEVICE_USER_375_EN_SCROLL_REGION';
    return r;
  } finally {
    await browser.close();
  }
}
