/** User-selected Playwright (installed Chrome/Edge) and Mozilla WebDriver (official Firefox). */
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, existsSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { createHash, randomInt } from 'node:crypto';
import { APP_ROUTES } from '../apps/admin-web/src/router/routes.ts';

const folder = 'docs/audit/evidence/admin-ui-811a895-formal-2026-10-04/';
const commit = '811a8959477d7b2608f2562b5d221f8b40370944';
const privatePath = '/tmp/fdp-811a895-formal-private-logins.json';
const origin = 'https://admin.bio-nexa.com';
const digest = (b) => createHash('sha256').update(b).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (process.env.FDP_FORMAL_BROWSER_AUTOMATION_AUTHORIZED !== '1')
  throw Error('EXPLICIT_USER_AUTOMATION_SELECTION_REQUIRED');
if (existsSync(folder + 'browsers.json')) throw Error('PRESERVE_EXISTING_RECEIPT_BEFORE_RETRY');
if (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() !== commit)
  throw Error('EXACT_SOURCE_REQUIRED');
const version = JSON.parse(readFileSync(folder + 'application-version.json'));
if (version.gate !== 'PASS' || version.sourceCommit !== commit) throw Error('DEPLOYMENT_PASS_REQUIRED');
if ((statSync(privatePath).mode & 0o777) !== 0o600) throw Error('PRIVATE_CREDENTIAL_FILE_MODE_REQUIRED');
const logins = JSON.parse(readFileSync(privatePath)),
  ledger = JSON.parse(readFileSync(folder + 'owned-fixture-ledger.json'));
if (logins.length !== 5 || ledger.accounts.some((x) => x.cleanup !== 'PENDING'))
  throw Error('FRESH_FIVE_ROLES_REQUIRED');
const r = {
  schemaVersion: '1.0',
  sourceCommit: commit,
  scope: 'FIVE_ROLE_REAL_LOGIN_MENU_ROUTE_LAYOUT_NONEMPTY_SITE_DEVICE_USER',
  startedAt: new Date().toISOString(),
  status: 'RUNNING',
  productionAccepted: false,
  fullAdminTargetAccepted: false,
  automationAuthorization:
    'User explicitly selected installed-browser Playwright and official Firefox GeckoDriver on 2026-10-04',
  apiMock: false,
  jwtModified: false,
  credentialsInRepository: false,
  executorSha256: digest(readFileSync(new URL(import.meta.url))),
  applicationVersionReceiptSha256: digest(readFileSync(folder + 'application-version.json')),
  cases: [],
  network: [],
  browsers: [],
};
const save = () => writeFileSync(folder + 'browsers.json', JSON.stringify(r, null, 2) + '\n');
save();
function check(c, id, ok, detail = {}) {
  c.checks.push({ ...detail, id, result: ok ? 'PASS' : 'FAIL' });
  save();
  if (!ok) throw Error(id);
}
const E = 'element-6066-11e4-a52e-4f735466cecf';
async function firefox() {
  const port = randomInt(45000, 47000),
    url = 'http://127.0.0.1:' + port;
  const marionettePort = randomInt(47001, 49000);
  const profile = mkdtempSync('/private/tmp/fdp-formal-browser-811a895/profile-');
  chmodSync(profile, 0o700);
  writeFileSync(
    profile + '/user.js',
    `user_pref("marionette.port", ${marionettePort});\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.startup.page", 0);\n`,
  );
  // Mozilla bug 2060476: macOS 27 requires LaunchServices for access to app data.
  // Official GeckoDriver controls the isolated instance through --connect-existing.
  const launched = spawnSync('open', [
    '-n',
    '-a',
    '/private/tmp/fdp-formal-browser-811a895/Firefox.app',
    '--args',
    '-headless',
    '-no-remote',
    '-profile',
    profile,
    '--marionette',
    'about:blank',
  ]);
  if (launched.status !== 0) {
    rmSync(profile, { recursive: true, force: true });
    throw Error('FIREFOX_LAUNCHSERVICES_FAILED');
  }
  const processHandle = spawn(
    '/tmp/fdp-formal-browser-811a895/geckodriver',
    [
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--log',
      'fatal',
      '--connect-existing',
      '--marionette-port',
      String(marionettePort),
    ],
    { stdio: 'ignore' },
  );
  const request = async (method, path, body) => {
    const response = await fetch(url + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000),
    });
    const json = await response.json();
    if (!response.ok) throw Error('WEBDRIVER_' + (json.value?.error ?? 'FAILED').replaceAll(' ', '_'));
    return json.value;
  };
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      await request('GET', '/status');
      ready = true;
      break;
    } catch {
      await pause(100);
    }
  }
  if (!ready) {
    processHandle.kill();
    throw Error('GECKODRIVER_NOT_READY');
  }
  const session = await request('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        acceptInsecureCerts: false,
        'moz:firefoxOptions': {
          binary: '/private/tmp/fdp-formal-browser-811a895/Firefox.app/Contents/MacOS/firefox',
          args: ['-headless'],
        },
      },
    },
  });
  if (session.capabilities['moz:profile'] !== profile) throw Error('ISOLATED_FIREFOX_PROFILE_REQUIRED');
  const path = '/session/' + session.sessionId;
  const send = (method, p, body) => request(method, path + p, body);
  const evaluate = (fn, arg) =>
    send('POST', '/execute/sync', { script: 'return (' + fn.toString() + ')(arguments[0]);', args: [arg ?? null] });
  const element = async (css) => {
    await until({ evaluate }, (selector) => !!document.querySelector(selector), css);
    return (await send('POST', '/element', { using: 'css selector', value: css }))[E];
  };
  return {
    name: 'Firefox',
    version: session.capabilities.browserVersion,
    capabilities: {
      browserName: session.capabilities.browserName,
      browserVersion: session.capabilities.browserVersion,
      platformName: session.capabilities.platformName,
      geckodriverVersion: session.capabilities['moz:geckodriverVersion'],
      acceptInsecureCerts: session.capabilities.acceptInsecureCerts,
      launcher: 'macOS LaunchServices; GeckoDriver --connect-existing; independent temporary profile',
    },
    driver: 'Mozilla GeckoDriver WebDriver',
    binary: '/private/tmp/fdp-formal-browser-811a895/Firefox.app/Contents/MacOS/firefox',
    evaluate,
    goto: (url) => send('POST', '/url', { url }),
    fill: async (css, text) => {
      const id = await element(css);
      await send('POST', '/element/' + id + '/clear', {});
      await send('POST', '/element/' + id + '/value', { text, value: [...text] });
    },
    click: async (css) => send('POST', '/element/' + (await element(css)) + '/click', {}),
    select: async (css, value) =>
      send('POST', '/element/' + (await element(css + ' option[value="' + value + '"]')) + '/click', {}),
    viewport: async (width, height) => {
      await send('POST', '/window/rect', { width, height });
      for (let i = 0; i < 3; i++) {
        const m = await evaluate(() => ({ w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight }));
        if (m.w === width && m.h === height) return;
        await send('POST', '/window/rect', { width: width + m.ow - m.w, height: height + m.oh - m.h });
      }
    },
    screenshot: async (file) => writeFileSync(file, Buffer.from(await send('GET', '/screenshot'), 'base64')),
    close: async () => {
      try {
        await send('DELETE', '');
      } finally {
        processHandle.kill();
        try {
          process.kill(session.capabilities['moz:processID'], 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') r.browserProcessCleanupFailure = true;
        }
        rmSync(profile, { recursive: true, force: true });
      }
    },
  };
}
async function chromium(name, binary) {
  const { chromium } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: binary });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } }),
    page = await context.newPage();
  page.on('response', async (response) => {
    if (response.url().startsWith('https://api.bio-nexa.com/api/v1/')) {
      const headers = await response.allHeaders();
      r.network.push({
        browser: name,
        method: response.request().method(),
        path: new URL(response.url()).pathname,
        status: response.status(),
        requestId: headers['x-amzn-requestid'] ?? null,
      });
      save();
    }
  });
  return {
    name,
    version: browser.version(),
    binary,
    driver: 'Playwright installed vendor executable',
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    goto: (url) => page.goto(url, { waitUntil: 'domcontentloaded' }),
    fill: (css, text) => page.locator(css).fill(text),
    click: (css) => page.locator(css).click(),
    select: (css, value) => page.locator(css).selectOption(value),
    viewport: (width, height) => page.setViewportSize({ width, height }),
    screenshot: (file) => page.screenshot({ path: file }),
    close: () => browser.close(),
  };
}
async function until(b, fn, arg) {
  for (let i = 0; i < 150; i++) {
    const result = await b.evaluate(fn, arg);
    if (result) return result;
    await pause(200);
  }
  throw Error('UI_COMPLETION_TIMEOUT');
}
const visible = (selector) => {
  const e = document.querySelector(selector);
  return !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
};
async function snapshot(b, c, suffix) {
  const file = `${b.name.toLowerCase()}-${c.role.toLowerCase()}-${suffix}.png`;
  await b.screenshot(folder + file);
  c.artifacts.push({ path: file, sha256: digest(readFileSync(folder + file)) });
  save();
}
const metrics = () => ({
  width: innerWidth,
  height: innerHeight,
  scrollWidth: document.documentElement.scrollWidth,
  navCount: document.querySelectorAll('nav[aria-label="主菜单"],nav[aria-label="Main menu"]').length,
  main: !!document.querySelector('main'),
  language: document.documentElement.lang,
  buttons: Array.from(document.querySelectorAll('main button'))
    .filter((x) => x.getBoundingClientRect().width > 0)
    .map((x) => ({ testid: x.dataset.testid ?? null, text: x.textContent.trim(), disabled: x.disabled })),
  alerts: Array.from(document.querySelectorAll('main [role=alert]'))
    .map((x) => x.textContent.trim())
    .filter(Boolean),
});
try {
  for (const factory of [
    () => chromium('Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    () => chromium('Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    firefox,
  ]) {
    let b;
    try {
      b = await factory();
      r.browsers.push({
        name: b.name,
        version: b.version,
        binary: b.binary,
        driver: b.driver,
        ...(b.capabilities ? { capabilities: b.capabilities } : {}),
      });
      save();
      for (const login of logins) {
        const c = {
          browser: b.name,
          role: login.role,
          customerId: login.customerId,
          status: 'RUNNING',
          checks: [],
          routes: [],
          artifacts: [],
        };
        r.cases.push(c);
        save();
        try {
          await b.viewport(1366, 768);
          await b.goto(origin + '/login');
          await until(b, visible, '#username');
          await b.fill('#username', login.username);
          await b.fill('input[type=password]', login.password);
          await b.click('button[type=submit]');
          await until(
            b,
            () => location.pathname === '/dashboard' && !!document.querySelector('[data-testid="dashboard-page"]'),
          );
          check(c, 'real-ui-login', true);
          await until(b, () => !document.querySelector('[role="status"]')?.textContent.includes('加载中'));
          const menu = await b.evaluate(() =>
            Array.from(document.querySelectorAll('nav[aria-label="主菜单"] a')).map((x) => new URL(x.href).pathname),
          );
          const expected = APP_ROUTES.filter((x) => x.menuGroup && !x.public && x.roles.includes(login.role))
            .map((x) => x.path)
            .sort();
          check(c, 'role-menu-exact', JSON.stringify(menu.sort()) === JSON.stringify(expected), { visiblePaths: menu });
          // Source-enumerated routes, not guessed URLs. Child routes without a device/contract only prove selection state and layout.
          for (const route of APP_ROUTES.filter((x) => !x.public)) {
            await b.goto(origin + route.path);
            await until(b, () => !!document.querySelector('main'));
            const denied = !route.roles.includes(login.role);
            await until(b, (path) => location.pathname === path, route.path);
            await until(
              b,
              (denied) =>
                denied
                  ? document.querySelector('main h1')?.textContent.trim() === '403' &&
                    !document.querySelector('nav.sidebar-nav')
                  : !!document.querySelector('nav.sidebar-nav'),
              denied,
            );
            await until(
              b,
              () =>
                !Array.from(document.querySelectorAll('main [role="status"]')).some((x) =>
                  /加载中|Loading/i.test(x.textContent),
                ),
            );
            const state = await b.evaluate(() => ({
              path: location.pathname,
              body: document.querySelector('main')?.innerText ?? '',
              width: innerWidth,
              height: innerHeight,
              scroll: document.documentElement.scrollWidth,
              forbiddenRendered:
                document.querySelector('main h1')?.textContent.trim() === '403' &&
                !document.querySelector('nav.sidebar-nav'),
            }));
            const result =
              state.path === route.path &&
              (denied ? state.forbiddenRendered : !state.forbiddenRendered && state.body.trim().length > 0);
            c.routes.push({
              path: route.path,
              expected: denied ? 'FORBIDDEN' : 'ALLOWED',
              actualPath: state.path,
              result: result ? 'PASS' : 'FAIL',
              viewport: { width: state.width, height: state.height },
              horizontalOverflow: state.scroll > state.width + 1,
              forbiddenRendered: state.forbiddenRendered,
            });
            save();
            check(
              c,
              'route:' + route.path,
              result && state.scroll <= state.width + 1 && state.width === 1366 && state.height === 768,
            );
          }
          await b.goto(origin + '/sites');
          await until(b, visible, '[data-testid="sites-page"]');
          const ownCustomer = login.customerId ?? ledger.customers[0].id;
          const site = ledger.created.find((x) => x.kind === 'sites' && x.customerId === ownCustomer);
          if (!login.customerId) {
            await until(b, visible, '#filter-customer');
            await b.select('#filter-customer', ownCustomer);
          }
          await until(
            b,
            (id) => {
              const details = Array.from(document.querySelectorAll('[data-testid^="detail-"]'));
              return details.length === 1 && details[0].dataset.testid === 'detail-' + id;
            },
            site.id,
          );
          await b.click('[data-testid="detail-' + site.id + '"]');
          await until(b, visible, '[data-testid="site-detail"]');
          const siteView = await b.evaluate(() => document.querySelector('[data-testid="site-detail"]').innerText);
          check(c, 'nonempty-owned-site-detail', siteView.includes(site.id) && siteView.includes(site.name));
          await b.click('[data-testid="site-detail"]');
          await snapshot(b, c, 'site-1366x768');
          if (login.role === 'PlatformOperator') {
            await b.goto(origin + '/device-users');
            await until(
              b,
              () =>
                document.querySelector('main h1')?.textContent.trim() === '403' &&
                !document.querySelector('nav.sidebar-nav'),
            );
            check(c, 'operator-device-user-route-denied', true);
            await snapshot(b, c, 'device-users-forbidden');
          } else {
            await b.goto(origin + '/device-users');
            await until(b, visible, '[data-testid="device-user-keyword"]');
            await b.fill('[data-testid="device-user-keyword"]', 'ui-formal-811a895-r2-');
            await b.click('[data-testid="device-user-search"]');
            const du = ledger.created.find((x) => x.kind === 'device-users' && x.customerId === ownCustomer);
            await until(b, visible, '[data-testid="device-user-detail-' + du.id + '"]');
            await b.click('[data-testid="device-user-detail-' + du.id + '"]');
            await until(b, visible, '[data-testid="device-user-detail"]');
            const view = await b.evaluate(() => document.querySelector('[data-testid="device-user-detail"]').innerText);
            check(c, 'nonempty-owned-device-user-detail', view.includes(du.name) && view.includes(du.customerId));
            await b.click('[data-testid="device-user-detail"]');
            const writes = await b.evaluate(() =>
              ['create', 'edit', 'password-reset', 'disable', 'assign', 'revoke'].filter((x) =>
                document.querySelector('[data-testid="device-user-' + x + '"]'),
              ),
            );
            const writer = ['PlatformSuperAdmin', 'CustomerAdmin'].includes(login.role);
            check(c, 'device-user-controls', writer ? writes.length === 6 : writes.length === 0, {
              writeControlIds: writes,
            });
            await snapshot(b, c, 'device-user-1366x768');
            if (writer) {
              await b.click('[data-testid="device-user-edit"]');
              await until(b, visible, '[data-testid="device-user-edit-dialog"]');
              const focus = await b.evaluate(() => ({
                dialog: !!document.querySelector('[role=dialog]')?.contains(document.activeElement),
                submitDisabled: document.querySelector('[data-testid="edit-submit"]')?.disabled,
              }));
              check(c, 'edit-modal-focus-and-required-reason', focus.dialog && focus.submitDisabled);
              await snapshot(b, c, 'edit-required-reason');
              const displayName = 'UI-FORMAL-811A895-20261004-R2-' + b.name + '-' + login.role;
              await b.fill('[data-testid="edit-display-name"]', displayName);
              await b.fill('[data-testid="edit-reason"]', 'UI-FORMAL-811A895-20261004-R2 browser acceptance');
              await b.click('[data-testid="edit-submit"]');
              await until(b, () => !document.querySelector('[data-testid="device-user-edit-dialog"]'));
              await until(
                b,
                (text) => document.querySelector('[data-testid="device-user-detail"]')?.innerText.includes(text),
                displayName,
              );
              await b.goto(origin + '/device-users');
              await until(b, visible, '[data-testid="device-user-keyword"]');
              await b.fill('[data-testid="device-user-keyword"]', 'ui-formal-811a895-r2-');
              await b.click('[data-testid="device-user-search"]');
              await until(b, visible, '[data-testid="device-user-detail-' + du.id + '"]');
              await b.click('[data-testid="device-user-detail-' + du.id + '"]');
              await until(
                b,
                (text) => document.querySelector('[data-testid="device-user-detail"]')?.innerText.includes(text),
                displayName,
              );
              check(c, 'owned-device-user-edit-persisted', true, { deviceUserId: du.id, customerId: du.customerId });
              await snapshot(b, c, 'edit-persisted');
              await b.goto(origin + '/device-users');
            }
          }
          await b.viewport(1440, 900);
          await b.goto(origin + '/sites');
          await until(b, visible, '[data-testid="sites-page"]');
          if (!login.customerId) await b.select('#filter-customer', ownCustomer);
          await until(
            b,
            (id) => {
              const details = Array.from(document.querySelectorAll('[data-testid^="detail-"]'));
              return details.length === 1 && details[0].dataset.testid === 'detail-' + id;
            },
            site.id,
          );
          await b.click('[data-testid="detail-' + site.id + '"]');
          await until(b, visible, '[data-testid="site-detail"]');
          const m = await b.evaluate(metrics);
          check(c, 'desktop-1440x900', m.width === 1440 && m.height === 900 && m.scrollWidth <= 1441, { viewport: m });
          const languageCss = '[data-testid="language-select"]';
          await b.select(languageCss, 'en');
          await until(b, () => document.documentElement.lang === 'en');
          check(c, 'english-layout', await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          await snapshot(b, c, 'site-english-1440x900');
          await b.goto(origin + '/sites');
          await until(
            b,
            () => document.documentElement.lang === 'en' && !!document.querySelector('[data-testid="sites-page"]'),
          );
          check(c, 'language-persists-reload', true);
          await b.select(languageCss, 'zh-CN');
          await b.click('[data-testid="logout-button"]');
          await until(b, () => location.pathname === '/login');
          check(c, 'logout', true);
          c.status = 'PASS';
          save();
          console.log(JSON.stringify({ browser: b.name, role: login.role, status: c.status, routes: c.routes.length }));
        } catch (e) {
          c.status = 'FAIL';
          c.failure = {
            code: /^[A-Za-z0-9:._/-]+$/.test(e.message) ? e.message : 'BROWSER_EXECUTION_FAILED',
            name: e.name,
          };
          save();
          await snapshot(b, c, 'failure').catch(() => {});
          throw e;
        }
      }
    } catch (e) {
      r.failures ??= [];
      r.failures.push({
        browser: b?.name ?? 'STARTUP',
        code: /^[A-Za-z0-9:_-]+$/.test(e.message) ? e.message : 'BROWSER_EXECUTION_FAILED',
      });
      save();
    } finally {
      await b?.close();
    }
  }
} finally {
  logins.length = 0;
  r.finishedAt = new Date().toISOString();
  r.status =
    r.browsers.length === 3 && r.cases.length === 15 && r.cases.every((x) => x.status === 'PASS')
      ? 'PASS_SCOPED_THREE_VENDOR_BROWSERS'
      : 'FAIL';
  save();
  console.log(JSON.stringify({ status: r.status, cases: r.cases.length }));
}
process.exitCode = r.status.startsWith('PASS_') ? 0 : 1;
