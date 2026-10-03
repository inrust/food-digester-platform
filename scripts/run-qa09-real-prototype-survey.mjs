import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { validateBindings, VIEWPORTS } from './qa08-bindings.mjs';
const [parentFile, output] = process.argv.slice(2);
const parent = JSON.parse(readFileSync(parentFile));
if (!/^qa09-[a-f0-9]{16}$/.test(parent.prefix) || parent.sourceCommit !== 'e759626a3e965cd9c0330b8e73bc713c0386d7de')
  throw Error('OWN_VERIFIED_TARGET_REQUIRED');
const pool = 'ap-southeast-1_hZMX8LpFo',
  region = 'ap-southeast-1',
  username = `${parent.prefix}-prototype-survey@example.invalid`;
const temp = `A!z9${randomBytes(24).toString('base64url')}`,
  password = `A!z9${randomBytes(24).toString('base64url')}`;
const credentials = () => {
  const x = spawnSync('aws', ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (x.status !== 0) throw Error('SSO_UNAVAILABLE');
  const v = JSON.parse(x.stdout);
  return { accessKeyId: v.AccessKeyId, secretAccessKey: v.SecretAccessKey, sessionToken: v.SessionToken };
};
const idp = new sdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 });
const call = (Cmd, input) => idp.send(new Cmd(input), { abortSignal: AbortSignal.timeout(30000) });
const matrix = JSON.parse(readFileSync('contracts/prototype-traceability.yaml'));
const r = {
  task: 'QA-09',
  scope: 'REAL_BROWSER_STRUCTURAL_SEMANTIC_SURVEY_NOT_FULL_BEHAVIOR',
  prefix: parent.prefix,
  sourceCommit: parent.sourceCommit,
  startedAt: new Date().toISOString(),
  bindingInventory: validateBindings(matrix),
  pages: [],
  identity: { username, created: false },
  cleanup: [],
  fullQa09Accepted: false,
  credentialsExported: false,
  apiMock: false,
  updatedSnapshots: false,
  gate: 'RUNNING',
};
r.sources = [
  'scripts/run-qa09-real-prototype-survey.mjs',
  'contracts/prototype-traceability.yaml',
  'scripts/qa08-bindings.mjs',
].map((path) => {
  const bytes = readFileSync(path);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), sourceBase64: bytes.toString('base64') };
});
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
save();
let browser, auth, flow;
const contexts = [];
try {
  await call(sdk.AdminCreateUserCommand, {
    UserPoolId: pool,
    Username: username,
    MessageAction: 'SUPPRESS',
    TemporaryPassword: temp,
    UserAttributes: [
      { Name: 'email', Value: username },
      { Name: 'email_verified', Value: 'true' },
    ],
  });
  r.identity.created = true;
  save();
  await call(sdk.AdminAddUserToGroupCommand, { UserPoolId: pool, Username: username, GroupName: 'PlatformSuperAdmin' });
  flow = new AuthFlow({
    idp: createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
    userPoolId: pool,
    sessionManager: { establish() {} },
  });
  const first = await flow.login(username, temp);
  if (first.status !== 'new-password-required') throw Error('EXPECTED_FIRST_LOGIN_CHALLENGE');
  auth = await flow.submitNewPassword(password);
  if (auth.status !== 'authenticated') throw Error('REAL_SRP_REQUIRED');
  const { chromium } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))('@playwright/test');
  browser = await chromium.launch({ headless: true });
  const roots = {
    dashboard: 'dashboard-page',
    'device-view': 'device-view-page',
    'device-operate': 'device-operate-page',
    'device-group': 'device-groups-page',
    'device-manage': 'device-manage-page',
    'device-consumable': 'consumables-page',
    'contract-modify': 'contracts-page',
    'contract-new': 'contract-new-page',
    'contract-detail': 'contract-detail-page',
    'esg-overview': 'esg-overview-page',
    'esg-device': 'esg-devices-page',
    settings: 'settings-page',
  };
  for (const width of VIEWPORTS) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 } });
    contexts.push(context);
    const page = await context.newPage(),
      traffic = [];
    page.on('response', (res) => {
      const u = new URL(res.url());
      if (u.origin === 'https://api.bio-nexa.com')
        traffic.push({
          method: res.request().method(),
          path: u.pathname.replace(/[a-f0-9-]{36}/g, '<object>'),
          status: res.status(),
        });
    });
    await page.goto('https://admin.bio-nexa.com/login');
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
    for (const p of matrix.pages) {
      const baselinePath = `apps/admin-web/e2e/qa08-snapshots/${p.pageState}-${width}.json`,
        bytes = readFileSync(baselinePath),
        baseline = JSON.parse(bytes),
        row = {
          pageState: p.pageState,
          width,
          elements: p.elements.map((e) => ({ id: e.id, disposition: e.disposition, behaviorGate: 'NOT_RUN' })),
          baselineSha256: createHash('sha256').update(bytes).digest('hex'),
          route: p.routeId,
          gate: 'RUNNING',
        };
      const startTraffic = traffic.length;
      try {
        let route = p.routeId;
        if (p.pageState === 'contract-detail') {
          const business = JSON.parse(readFileSync(parentFile.replace(/\.devices\.json$/, '')));
          const own = business.checks.find((x) => x.id === 'contract-detail');
          if (!own?.path) throw Error('OWN_CONTRACT_NOT_READY');
          route += '?contractId=' + own.path.split('/').at(-1);
        }
        if (['device-view', 'device-operate', 'device-manage', 'esg-device'].includes(p.pageState))
          route += '?deviceId=' + parent.devices[0];
        await page.goto('https://admin.bio-nexa.com' + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 });
        const root = page.getByTestId(roots[p.pageState]);
        await root.waitFor({ state: 'visible', timeout: 10000 });
        const snapshot = await root.evaluate((el) => ({
          headings: [...el.querySelectorAll('h1,h2,h3,h4,h5')].map((n) => n.textContent?.trim()),
          columns: [...el.querySelectorAll('th')].map((n) => n.textContent?.trim()),
          labels: [...el.querySelectorAll('label')].map((n) => n.textContent?.trim()),
          buttons: [...el.querySelectorAll('button')].map((n) => ({
            id: n.getAttribute('data-testid'),
            name: n.textContent?.trim(),
            disabled: n.disabled,
          })),
          axes: [...el.querySelectorAll('[data-axis]')].map((n) => ({
            axis: n.getAttribute('data-axis'),
            value: n.getAttribute('data-value'),
          })),
        }));
        // Only retain hashes and baseline-owned literals; no existing customers' names or credentials are archived.
        row.targetSnapshotSha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
        row.semanticComparison = Object.fromEntries(
          ['headings', 'columns', 'labels'].map((k) => [
            k,
            {
              expected: baseline[k].filter((v) => !v.includes('<fixture>')),
              dynamicFixtureLabelsExcluded: baseline[k].filter((v) => v.includes('<fixture>')).length,
              missing: baseline[k].filter((v) => !v.includes('<fixture>')).filter((v) => !snapshot[k].includes(v)),
              expectedMultiplicityPreserved: baseline[k]
                .filter((v) => !v.includes('<fixture>'))
                .every((v) => snapshot[k].filter((x) => x === v).length >= baseline[k].filter((x) => x === v).length),
            },
          ]),
        );
        row.layout = await root.evaluate((el) => ({
          viewport: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          rootWidth: el.getBoundingClientRect().width,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        }));
        row.gate =
          Object.values(row.semanticComparison).every((v) => !v.missing.length) && !row.layout.horizontalOverflow
            ? 'PASS_STRUCTURAL_SUBSET'
            : 'FAIL';
      } catch (e) {
        row.gate = 'FAIL';
        row.failure = { name: e.name, code: 'TARGET_ROUTE_OR_SEMANTICS_FAILED' };
      }
      row.behaviorProbes = [];
      const proved = (ids, details) => {
        for (const id of ids) {
          const element = row.elements.find((x) => x.id === id);
          if (!element) throw Error('UNKNOWN_BEHAVIOR_BINDING');
          element.behaviorGate = 'PASS';
        }
        row.behaviorProbes.push({ ids, result: 'PASS', ...details });
      };
      const closeDialog = async () => {
        await page.keyboard.press('Escape');
        if (await page.getByRole('dialog').count()) throw Error('DIALOG_NOT_CLOSED');
      };
      try {
        if (p.pageState === 'dashboard')
          for (const [command, binding] of [
            ['START', 'start'],
            ['STOP', 'stop'],
            ['REBOOT', 'reboot'],
          ]) {
            const button = page.getByTestId(`action-${command}-${parent.devices[0]}`);
            if ((await button.count()) === 0 || (await button.isDisabled())) {
              row.behaviorProbes.push({
                id: `dashboard.button.${binding}`,
                result: 'BLOCKED',
                reason: 'OWN_CARD_OR_EFFECTIVE_ENTITLEMENT_PRECONDITION',
              });
              continue;
            }
            const before = traffic.filter((x) => x.method === 'POST').length;
            await button.click();
            await page.getByTestId('confirm-dialog').waitFor({ state: 'visible' });
            if (!(await page.getByTestId('confirm-dialog').innerText()).includes(parent.devices[0]))
              throw Error('OWN_DEVICE_CONFIRMATION_REQUIRED');
            await closeDialog();
            if (traffic.filter((x) => x.method === 'POST').length !== before)
              throw Error('CANCELLED_COMMAND_CREATED_WRITE');
            proved([`dashboard.button.${binding}`], { guard: 'OWN_DEVICE_CONFIRM_CANCEL_ZERO_POST' });
          }
        if (p.pageState === 'device-operate')
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
            await page.getByTestId('quick-' + button).click();
            if ((await page.getByTestId('command-select').inputValue()) !== command)
              throw Error('WRONG_COMMAND_BINDING');
            if (['AGITATOR_FORWARD', 'AGITATOR_REVERSE', 'HEATING_ON', 'SHUTDOWN', 'FACTORY_RESET'].includes(command)) {
              await page.getByTestId('command-confirm-text').fill('WRONG');
              if (!(await page.getByTestId('command-submit').isDisabled()))
                throw Error('HIGH_RISK_CONFIRMATION_BYPASS');
            }
            proved([`device-operate.button.${button}`], {
              guard: 'CATALOG_BINDING_AND_INVALID_CONFIRMATION_REJECTION_NO_SUBMIT',
            });
          }
        if (p.pageState === 'settings') {
          await page.getByTestId('user-invite-open').click();
          await page.getByTestId('invite-email').waitFor({ state: 'visible' });
          if ((await page.getByRole('dialog').locator('input[type=password]').count()) !== 0)
            throw Error('PLATFORM_PASSWORD_IN_INVITE');
          await closeDialog();
          proved(['settings.button.addPlatformUser'], { guard: 'INVITE_HAS_EMAIL_NO_PLATFORM_PASSWORD' });
          await page.getByTestId('tab-device-users').click();
          await page.getByTestId('device-user-create').click();
          await page.getByTestId('create-password').waitFor({ state: 'visible' });
          await closeDialog();
          proved(['settings.button.addDeviceUser'], { guard: 'DEVICE_USER_FORM_PASSWORD_PRESENT_CANCELLED' });
        }
      } catch (e) {
        row.behaviorProbes.push({
          result: 'FAIL',
          errorName: e.name,
          code: /^[A-Z_]+$/.test(e.message) ? e.message : 'BEHAVIOR_TARGET_FAILED',
        });
        row.gate = 'FAIL';
      }
      row.actualApiResponses = traffic.slice(startTraffic);
      r.pages.push(row);
      save();
      console.log(JSON.stringify({ pageState: row.pageState, width, gate: row.gate }));
    }
    await context.close();
  }
  r.behaviorExecutionsPassed = r.pages.flatMap((p) => p.elements).filter((e) => e.behaviorGate === 'PASS').length;
  r.gate = 'PARTIAL';
  r.unexecutedBehaviorElements = matrix.pages
    .flatMap((p) => p.elements)
    .filter(
      (e) =>
        ['Adopt', 'Adapt'].includes(e.disposition) &&
        !VIEWPORTS.every((width) =>
          r.pages.some((p) => p.width === width && p.elements.some((x) => x.id === e.id && x.behaviorGate === 'PASS')),
        ),
    ).length;
} catch (e) {
  r.gate = 'FAIL';
  r.failure = { name: e.name, code: 'SURVEY_FAILED' };
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (r.identity.created) {
    try {
      let globalSignOut = 'NOT_RUN';
      if (auth?.session) {
        try {
          await createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }).globalSignOut(
            auth.session.accessToken,
          );
          globalSignOut = 'PASS';
        } catch {
          globalSignOut = 'FAIL';
        }
      }
      await call(sdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: username });
      let absent = false;
      try {
        await call(sdk.AdminGetUserCommand, { UserPoolId: pool, Username: username });
      } catch (e) {
        absent = e.name === 'UserNotFoundException';
      }
      r.cleanup.push({ type: 'dedicated-identity', result: absent ? 'PASS' : 'FAIL', globalSignOut });
    } catch (e) {
      r.cleanup.push({ type: 'dedicated-identity', result: 'FAIL', errorName: e.name });
    }
  }
  r.finishedAt = new Date().toISOString();
  save();
}
process.exitCode = r.gate === 'PARTIAL' && r.cleanup.every((x) => x.result === 'PASS') ? 2 : 1;
