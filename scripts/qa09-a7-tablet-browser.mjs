import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { assertTabletProof } from './qa09-a467-proof.mjs';
export async function runTabletGap({ browserLogin, receipt, save }) {
  const { chromium, expect } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))(
    '@playwright/test',
  );
  const browser = await chromium.launch({ headless: true });
  const r = {
    scope: 'ONLY_MISSING_768_BILINGUAL_ROOT_READ_PAGES',
    gate: 'RUNNING',
    apiMock: false,
    sessionMutation: false,
    notificationWrites: 0,
    cases: [],
    writes: [],
    traffic: [],
    fullQa09Accepted: false,
  };
  receipt.tabletGap = r;
  save();
  try {
    const context = await browser.newContext({ viewport: { width: 768, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('request', (q) => {
      const u = new URL(q.url());
      if (u.origin === 'https://api.bio-nexa.com' && !['GET', 'OPTIONS'].includes(q.method()))
        r.writes.push({ method: q.method(), path: u.pathname });
    });
    page.on('response', (res) => {
      const u = new URL(res.url());
      if (u.origin === 'https://api.bio-nexa.com' && res.request().method() === 'GET')
        r.traffic.push({
          path: u.pathname,
          status: res.status(),
          requestId: res.headers()['x-amzn-requestid'] ?? null,
        });
    });
    await page.goto('https://admin.bio-nexa.com/login');
    await page.getByLabel('邮箱').fill(browserLogin.username);
    await page.getByLabel('密码', { exact: true }).fill(browserLogin.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
    for (const locale of ['zh-CN', 'en']) {
      await page.getByTestId('language-select').selectOption(locale);
      for (const [route, root] of [
        ['/settings', 'settings-page'],
        ['/contracts', 'contracts-page'],
        ['/contracts/new', 'contract-new-page'],
        ['/consumables', 'consumables-page'],
      ]) {
        const start = r.traffic.length;
        await page.goto('https://admin.bio-nexa.com' + route, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId(root)).toBeVisible({ timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 });
        const dimensions = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          lang: document.documentElement.lang,
        }));
        r.cases.push({
          route,
          locale,
          width: 768,
          ...dimensions,
          apiReads: r.traffic.slice(start),
          domSha256: createHash('sha256')
            .update(await page.getByTestId(root).innerHTML())
            .digest('hex'),
          result: 'PASS',
        });
        save();
      }
    }
    if (r.writes.length) throw Error('UNEXPECTED_BROWSER_WRITE');
    Object.assign(r, assertTabletProof(r.cases));
    save();
    return r;
  } finally {
    await browser.close();
  }
}
