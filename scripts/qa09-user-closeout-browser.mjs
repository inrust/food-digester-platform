import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { assertOwnedBusinessUser } from './run-qa09-signed-session-target.mjs';

// Attach both rejection handlers before performing the action; an early click failure
// must never turn the pending response wait into an unhandled rejection.
export async function observeUserAction(responseWait, action) {
  const [response] = await Promise.all([responseWait, Promise.resolve().then(action)]);
  return response;
}
export function validateUserBrowserEvidence(row) {
  if (
    ![375, 1440].includes(row.width) ||
    row.result !== 'PASS' ||
    row.cancelReadback !== 'ACTIVE' ||
    row.finalReadback !== 'DISABLED' ||
    row.apiMock !== false ||
    row.notificationWrites !== 0 ||
    row.viewport !== row.width ||
    row.documentWidth > row.width + 1 ||
    row.documentWidth < row.width ||
    !/^[a-f0-9]{64}$/.test(row.screenshotSha256 ?? '') ||
    !row.disableResponse?.requestId ||
    row.disableResponse.status !== 200 ||
    row.disableResponse.path !== `/api/v1/admin/users/${row.userId}/disable`
  )
    throw Error('USER_BROWSER_BUSINESS_PROOF_REQUIRED');
  return ['settings.button.deletePlatformUser', 'settings.modal.confirm'];
}
export async function runUserCloseoutBrowser({ prefix, own, browserLogin, admin, receipt, save }) {
  if (!['PlatformOperator', 'Auditor'].includes(own.role)) return;
  assertOwnedBusinessUser(prefix, own, { ...own, roles: [own.role], status: 'ACTIVE' });
  const width = own.role === 'PlatformOperator' ? 375 : 1440;
  const row = { width, userId: own.userId, email: own.email, apiMock: false, result: 'RUNNING', notificationWrites: 0 };
  (receipt.userBrowser ??= []).push(row);
  save();
  const { chromium, expect } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))(
    '@playwright/test',
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const forbidden = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (
        u.origin === 'https://api.bio-nexa.com' &&
        req.method() !== 'GET' &&
        (u.pathname === '/api/v1/admin/users' || u.pathname.endsWith('/password-reset'))
      )
        forbidden.push({ method: req.method(), path: u.pathname });
    });
    await page.goto('https://admin.bio-nexa.com/login');
    await page.getByLabel('用户名').fill(browserLogin.username);
    await page.getByLabel('密码', { exact: true }).fill(browserLogin.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
    await page.goto('https://admin.bio-nexa.com/settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('platform-users-tab')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('user-filter-q').fill(own.email);
    const listing = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/v1/admin/users' &&
        res.request().method() === 'GET' &&
        res.status() === 200,
    );
    await observeUserAction(listing, () => page.getByTestId('user-filter-search').click());
    const button = page.getByTestId('user-disable-' + own.userId);
    await expect(button).toBeEnabled();
    await button.click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toContainText(own.email);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const before = (await admin('browser-cancel-readback-' + width, 'GET', '/api/v1/admin/users?limit=100', 200)).data;
    row.cancelReadback = before.find((u) => u.userId === own.userId)?.status;
    if (row.cancelReadback !== 'ACTIVE') throw Error('USER_CANCEL_CHANGED_STATE');
    await button.click();
    const response = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === `/api/v1/admin/users/${own.userId}/disable` &&
        res.request().method() === 'POST',
    );
    const result = await observeUserAction(response, () =>
      dialog.getByRole('button', { name: '确认停用', exact: true }).click(),
    );
    row.disableResponse = {
      status: result.status(),
      path: new URL(result.url()).pathname,
      requestId: result.headers()['x-amzn-requestid'] ?? null,
    };
    await expect(dialog).toHaveCount(0, { timeout: 20000 });
    const after = (await admin('browser-disabled-readback-' + width, 'GET', '/api/v1/admin/users?limit=100', 200)).data;
    row.finalReadback = after.find((u) => u.userId === own.userId)?.status;
    Object.assign(
      row,
      await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth })),
    );
    row.screenshotSha256 = createHash('sha256')
      .update(await page.screenshot())
      .digest('hex');
    row.notificationWrites = forbidden.length;
    row.result = 'PASS';
    row.elements = validateUserBrowserEvidence(row);
  } catch (e) {
    row.result = 'FAIL';
    row.failureCode = /^[A-Z_]+$/.test(e.message) ? e.message : 'TARGET_USER_BROWSER_FAILED';
    throw e;
  } finally {
    save();
    await browser.close();
  }
}
