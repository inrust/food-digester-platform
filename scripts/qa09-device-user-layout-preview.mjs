import { createRequire } from 'node:module';
export async function previewDeviceUserLayout({ username, password }) {
  const { chromium, expect } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))(
    '@playwright/test',
  );
  const browser = await chromium.launch({ headless: true });
  const r = {
    scope: 'LOCAL_DOM_PREVIEW_OF_TABLE_SCROLL_WRAPPER_NOT_DEPLOYED_ACCEPTANCE',
    cases: [],
    businessWrites: [],
    fullQa09Accepted: false,
  };
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 1000 }, serviceWorkers: 'block' }),
      page = await context.newPage();
    page.on('request', (q) => {
      if (q.url().startsWith('https://api.bio-nexa.com/') && !['GET', 'OPTIONS'].includes(q.method()))
        r.businessWrites.push(q.method());
    });
    await page.goto('https://admin.bio-nexa.com/login');
    await page.getByLabel('邮箱').fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
    await page.getByTestId('language-select').selectOption('en');
    await page.goto('https://admin.bio-nexa.com/device-users');
    await expect(page.getByTestId('device-user-table')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const before = await page.evaluate(() => ({
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    const after = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="device-user-table"]');
      const wrapper = document.createElement('div');
      wrapper.className = 'table-scroll';
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', table.getAttribute('aria-label'));
      wrapper.tabIndex = 0;
      table.replaceWith(wrapper);
      wrapper.append(table);
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        tableScrollWidth: wrapper.scrollWidth,
        tableClientWidth: wrapper.clientWidth,
        rows: table.rows.length,
        tabIndex: wrapper.tabIndex,
      };
    });
    if (
      before.documentWidth <= before.viewport ||
      after.documentWidth > after.viewport + 1 ||
      after.tableScrollWidth <= after.tableClientWidth ||
      after.tabIndex !== 0 ||
      r.businessWrites.length
    )
      throw Error('LOCAL_TABLE_SCROLL_PREVIEW_FAILED');
    r.cases.push({ locale: 'en', before, after });
    r.gate = 'PASS_LOCAL_PREVIEW_ONLY';
    return r;
  } finally {
    await browser.close();
  }
}
