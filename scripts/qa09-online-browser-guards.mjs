import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export async function runOnlineBrowserGuards(ctx, output) {
  const { chromium } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))('@playwright/test');
  const browser = await chromium.launch({ headless: true }),
    id = ctx.receipt.devices[0];
  const r = {
    task: 'QA-09',
    scope: 'REAL_ENTITLED_DEVICE_BROWSER_GUARDS',
    prefix: ctx.receipt.prefix,
    sourceCommit: ctx.receipt.sourceCommit,
    startedAt: new Date().toISOString(),
    cases: [],
    apiMock: false,
    jwtModified: false,
    credentialsExported: false,
    fullQa09Accepted: false,
    sourceHash: createHash('sha256')
      .update(readFileSync(new URL('./qa09-online-browser-guards.mjs', import.meta.url)))
      .digest('hex'),
  };
  try {
    for (const width of [375, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      try {
        const page = await context.newPage(),
          writes = [];
        page.on('request', (req) => {
          if (req.url().startsWith('https://api.bio-nexa.com') && req.method() !== 'GET')
            writes.push({ method: req.method(), path: new URL(req.url()).pathname });
        });
        await page.goto('https://admin.bio-nexa.com/login');
        await page.locator('#username').fill(ctx.browserLogin.username);
        await page.locator('input[type=password]').fill(ctx.browserLogin.password);
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await page.waitForURL('**/dashboard', { timeout: 30000 });
        await page.waitForLoadState('networkidle');
        const close = async () => {
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'hidden' });
        };
        for (const [command, binding] of [
          ['START', 'start'],
          ['STOP', 'stop'],
          ['REBOOT', 'reboot'],
        ]) {
          const c = { width, id: `dashboard.button.${binding}`, result: 'RUNNING' };
          try {
            const button = page.getByTestId(`action-${command}-${id}`);
            await button.waitFor({ state: 'visible', timeout: 10000 });
            if (await button.isDisabled()) throw Error('ENTITLED_DEVICE_ACTION_DISABLED');
            const count = writes.length;
            await button.click();
            const dialog = page.getByTestId('confirm-dialog');
            await dialog.waitFor({ state: 'visible' });
            if (!(await dialog.innerText()).includes(id)) throw Error('OWN_DEVICE_CONFIRMATION_MISSING');
            await close();
            if (writes.length !== count) throw Error('CANCEL_DID_NOT_PREVENT_WRITE');
            c.result = 'PASS';
            c.guard = 'EXPLICIT_DEVICE_CONFIRMATION_CANCEL_ZERO_WRITE';
          } catch (e) {
            c.result = 'FAIL';
            c.errorName = e.name;
            c.failure = /^[A-Z_]+$/.test(e.message) ? e.message : 'BROWSER_GUARD_FAILED';
          }
          r.cases.push(c);
        }
        await page.goto('https://admin.bio-nexa.com/devices/operate?deviceId=' + id);
        await page.waitForLoadState('networkidle');
        for (const [button, command] of [
          ['agitatorForward', 'AGITATOR_FORWARD'],
          ['agitatorReverse', 'AGITATOR_REVERSE'],
          ['heating', 'HEATING_ON'],
          ['exhaust', 'EXHAUST_ON'],
          ['reboot', 'REBOOT'],
          ['shutdown', 'SHUTDOWN'],
          ['modeSwitch', 'START'],
          ['factoryReset', 'FACTORY_RESET'],
        ]) {
          const c = { width, id: `device-operate.button.${button}`, result: 'RUNNING' };
          try {
            await page.getByTestId('quick-' + button).click({ timeout: 10000 });
            if ((await page.getByTestId('command-select').inputValue()) !== command)
              throw Error('COMMAND_CATALOG_MAPPING_MISMATCH');
            if (['AGITATOR_FORWARD', 'AGITATOR_REVERSE', 'HEATING_ON', 'SHUTDOWN', 'FACTORY_RESET'].includes(command)) {
              await page.getByTestId('command-confirm-text').fill('WRONG');
              if (!(await page.getByTestId('command-submit').isDisabled()))
                throw Error('HIGH_RISK_CONFIRMATION_BYPASSED');
              await page.getByTestId('command-confirm-text').fill(command);
              if (!(await page.getByTestId('command-submit').isEnabled()))
                throw Error('CORRECT_CONFIRMATION_NOT_ENABLED');
            }
            c.result = 'PASS';
            c.guard = 'CATALOG_AND_CONFIRMATION_STATE_NO_SUBMIT';
            await close();
          } catch (e) {
            c.result = 'FAIL';
            c.errorName = e.name;
            c.failure = /^[A-Z_]+$/.test(e.message) ? e.message : 'BROWSER_GUARD_FAILED';
            await page.keyboard.press('Escape').catch(() => {});
          }
          r.cases.push(c);
        }
        r.cases.push({
          width,
          id: 'online-browser-zero-business-writes',
          result: writes.length === 0 ? 'PASS' : 'FAIL',
          actualWrites: writes.length,
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    r.finishedAt = new Date().toISOString();
    r.gate = r.cases.length === 24 && r.cases.every((c) => c.result === 'PASS') ? 'PASS' : 'FAIL';
    writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  }
  return r;
}
