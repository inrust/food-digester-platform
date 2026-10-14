import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { APP_ROUTES } from '../apps/admin-web/src/router/routes.ts';
const roots = {
  'device-group': 'device-groups',
  'device-consumable': 'consumables',
  'esg-device': 'esg-devices',
  'contract-modify': 'contracts',
};
export async function runCloseoutBrowserGaps(
  ctx,
  contractId,
  { roleControlsOnly = false, rootOnly = false, completedCases = [], continueOnLayoutFailure = false } = {},
) {
  const { chromium, expect } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))(
    '@playwright/test',
  );
  const browser = await chromium.launch({ headless: true });
  const r = {
    scope: 'ONLY_MISSING_ENGLISH_MOBILE_DESKTOP_AND_TABLET_ROUTES_PLUS_FOUR_ROLE_CONTROLS',
    gate: 'RUNNING',
    apiMock: false,
    sessionMutation: false,
    cases: [],
    writes: [],
    fullQa09Accepted: false,
  };
  ctx.businessReceipt.remaining.browser = r;
  ctx.save();
  const routes = APP_ROUTES.filter((x) => !x.public);
  try {
    for (const role of rootOnly
      ? ['PlatformSuperAdmin']
      : roleControlsOnly
        ? ['PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer']
        : ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer']) {
      const context = await browser.newContext({ viewport: { width: 768, height: 1000 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      const traffic = [];
      page.on('request', (q) => {
        const u = new URL(q.url());
        if (u.origin === 'https://api.bio-nexa.com' && !['GET', 'OPTIONS'].includes(q.method()))
          r.writes.push({ role, method: q.method(), path: u.pathname });
      });
      page.on('response', (res) => {
        const u = new URL(res.url());
        if (u.origin === 'https://api.bio-nexa.com' && res.request().method() === 'GET')
          traffic.push({
            path: u.pathname,
            status: res.status(),
            requestId: res.headers()['x-amzn-requestid'] ?? null,
          });
      });
      await page.goto('https://admin.bio-nexa.com/login');
      const login = ctx.logins.get(role);
      await page.getByLabel('邮箱').fill(login.username);
      await page.getByLabel('密码', { exact: true }).fill(login.password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
      const dimensions =
        role === 'PlatformSuperAdmin'
          ? [
              [375, 'en'],
              [1440, 'en'],
              [768, 'zh-CN'],
              [768, 'en'],
            ]
          : [[768, 'en']];
      for (const [width, locale] of dimensions) {
        await page.setViewportSize({ width, height: 1000 });
        await page.getByTestId('language-select').selectOption(locale);
        const selected =
          role === 'PlatformSuperAdmin'
            ? routes.filter(
                (x) =>
                  !(width === 768 && ['/settings', '/contracts', '/contracts/new', '/consumables'].includes(x.path)),
              )
            : routes.filter((x) => ['/devices/view', '/settings'].includes(x.path));
        for (const route of selected) {
          if (
            completedCases.some(
              (c) =>
                c.result === 'PASS' &&
                c.role === role &&
                c.route === route.path &&
                c.width === width &&
                c.locale === locale,
            )
          )
            continue;
          const before = traffic.length,
            allowed = route.roles.includes(role);
          const query =
            route.path === '/contracts/detail'
              ? '?contractId=' + contractId
              : ['/devices/view', '/devices/operate', '/devices/manage'].includes(route.path)
                ? '?deviceId=' + ctx.devices[0]
                : '';
          await page.goto('https://admin.bio-nexa.com' + route.path + query, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          const root = allowed ? (roots[route.pageState] ?? route.pageState) + '-page' : null;
          if (!allowed) await expect(page.getByRole('heading', { name: '403', exact: true })).toBeVisible();
          const locator = allowed ? page.getByTestId(root) : page.locator('main.standalone-page');
          await expect(locator).toBeVisible({ timeout: 20000 });
          await page.waitForLoadState('networkidle', { timeout: 20000 });
          const layout = await page.evaluate(() => ({
            width: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            lang: document.documentElement.lang,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            overflowing: Array.from(document.querySelectorAll('main,section,table,div'))
              .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
              .slice(0, 8)
              .map((e) => ({
                tag: e.tagName,
                className: e.className,
                width: Math.round(e.getBoundingClientRect().width),
              })),
          }));
          const layoutPassed = layout.documentWidth <= width + 1 && layout.lang === locale;
          if (!layoutPassed && !continueOnLayoutFailure) throw Error('CLOSEOUT_BROWSER_LAYOUT_OR_LANGUAGE_FAILED');
          const reads = traffic.slice(before);
          if (allowed && reads.some((x) => x.status >= 500 || !x.requestId)) throw Error('CLOSEOUT_BROWSER_API_FAILED');
          r.cases.push({
            role,
            route: route.path,
            locale,
            width,
            allowed,
            ...layout,
            reads,
            domSha256: createHash('sha256')
              .update(await locator.innerHTML())
              .digest('hex'),
            result: layoutPassed ? 'PASS' : 'FAIL',
          });
          ctx.save();
        }
        await page.reload({ waitUntil: 'domcontentloaded' });
        if ((await page.evaluate(() => document.documentElement.lang)) !== locale)
          throw Error('LANGUAGE_RELOAD_NOT_PERSISTED');
      }
      await context.close();
    }
    if (r.writes.length) throw Error('UNEXPECTED_BROWSER_BUSINESS_WRITE');
    r.gate = r.cases.some((c) => c.result !== 'PASS') ? 'FAIL' : 'PASS';
  } finally {
    await browser.close();
    ctx.save();
  }
  return r;
}
