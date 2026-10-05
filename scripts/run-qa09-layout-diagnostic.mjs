import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
export function validateLayoutDiagnosticFixture(fixture, version) {
  if (
    version.gate !== 'PASS' ||
    !/^[a-f0-9]{40}$/.test(version.sourceCommit ?? '') ||
    fixture.fixtureMode !== 'REAL_RDS_ONBOARDED_STATE_FOR_BUSINESS_APIS_NO_DEVICE_AUTH_CLAIM' ||
    fixture.sourceCommit !== version.sourceCommit ||
    fixture.gate !== 'RUNNING' ||
    !/^qa09-[a-f0-9]{16}$/.test(fixture.prefix) ||
    fixture.devices?.some((id) => !id.startsWith(fixture.prefix + '-')) ||
    !fixture.devices?.length
  )
    throw Error('OWN_RUNNING_FIXTURE_REQUIRED');
}

/** Each cleanup action must still run when another action fails. Never throw from finally. */
export async function cleanupLayoutDiagnosticIdentity(call) {
  const receipt = { type: 'identity', result: 'FAIL', globalSignOut: 'FAIL', deletion: 'FAIL', absence: 'FAIL' };
  try {
    await call(sdk.AdminUserGlobalSignOutCommand, {});
    receipt.globalSignOut = 'PASS';
  } catch {
    /* Keep the failed action, but still attempt deletion and readback. */
  }
  try {
    await call(sdk.AdminDeleteUserCommand, {});
    receipt.deletion = 'PASS';
  } catch {
    /* Readback independently determines whether the identity remains. */
  }
  try {
    await call(sdk.AdminGetUserCommand, {});
  } catch (error) {
    if (error.name === 'UserNotFoundException') receipt.absence = 'PASS';
  }
  if ([receipt.globalSignOut, receipt.deletion, receipt.absence].every((result) => result === 'PASS'))
    receipt.result = 'PASS';
  return receipt;
}

export async function runLayoutDiagnostic(args) {
  const [output, fixtureFile, versionFile] = args;
  if (!output || !fixtureFile || !versionFile) throw Error('DIAGNOSTIC_INPUTS_REQUIRED');
  const fixture = JSON.parse(readFileSync(fixtureFile));
  const version = JSON.parse(readFileSync(versionFile));
  validateLayoutDiagnosticFixture(fixture, version);
  const identity = spawnSync('aws', ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--output', 'json'], {
    encoding: 'utf8',
  });
  if (
    identity.status !== 0 ||
    JSON.parse(identity.stdout).Account !== '065986019555' ||
    !JSON.parse(identity.stdout).Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_')
  )
    throw Error('WRONG_AWS_IDENTITY');
  const exported = spawnSync(
    'aws',
    ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
    { encoding: 'utf8' },
  );
  if (exported.status !== 0) throw Error('SSO_CREDENTIALS_UNAVAILABLE');
  const c = JSON.parse(exported.stdout);
  const client = new sdk.CognitoIdentityProviderClient({
    region: 'ap-southeast-1',
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    },
  });
  const pool = 'ap-southeast-1_hZMX8LpFo';
  const username = fixture.prefix + '-layout-' + randomBytes(4).toString('hex') + '@example.invalid';
  const password = 'A!z9' + randomBytes(24).toString('base64url');
  const temporary = 'A!z9' + randomBytes(24).toString('base64url');
  const r = {
    task: 'QA-09',
    scope: 'OWN_DEVICE_READONLY_LAYOUT_DIAGNOSTIC',
    sourceCommit: version.sourceCommit,
    prefix: fixture.prefix,
    deviceId: fixture.devices[0],
    username,
    sourceSha256: createHash('sha256')
      .update(readFileSync(new URL(import.meta.url)))
      .digest('hex'),
    gate: 'RUNNING',
    credentialsExported: false,
    businessWrites: false,
    pages: [],
    cleanup: [],
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  const call = (Cmd, input) =>
    client.send(new Cmd({ UserPoolId: pool, Username: username, ...input }), {
      abortSignal: AbortSignal.timeout(30000),
    });
  let created = false,
    browser;
  save();
  try {
    await call(sdk.AdminCreateUserCommand, {
      MessageAction: 'SUPPRESS',
      TemporaryPassword: temporary,
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' },
      ],
    });
    created = true;
    r.identityCreated = true;
    save();
    await call(sdk.AdminAddUserToGroupCommand, { GroupName: 'PlatformSuperAdmin' });
    const flow = new AuthFlow({
      idp: createCognitoIdpClient({ region: 'ap-southeast-1', clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
      userPoolId: pool,
      sessionManager: { establish() {} },
    });
    if (
      (await flow.login(username, temporary)).status !== 'new-password-required' ||
      (await flow.submitNewPassword(password)).status !== 'authenticated'
    )
      throw Error('DIAGNOSTIC_REAL_SRP_FAILED');
    const { chromium } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))('@playwright/test');
    browser = await chromium.launch({ headless: true });
    for (const width of [375, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      await page.goto('https://admin.bio-nexa.com/login');
      await page.getByLabel('用户名').fill(username);
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
      await page.goto('https://admin.bio-nexa.com/devices/manage?deviceId=' + encodeURIComponent(r.deviceId));
      await page.getByTestId('cert-summary').waitFor({ timeout: 20000 });
      await page.waitForLoadState('networkidle');
      r.pages.push(
        await page.evaluate(() => {
          const selector = (el) =>
            el.tagName.toLowerCase() +
            (el.id ? '#' + el.id : '') +
            (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') +
            (el.getAttribute('data-testid') ? '[data-testid="' + el.getAttribute('data-testid') + '"]' : '');
          const candidates = [...document.querySelectorAll('body *')]
            .map((el) => {
              const rect = el.getBoundingClientRect(),
                s = getComputedStyle(el);
              return {
                selector: selector(el),
                parent: el.parentElement ? selector(el.parentElement) : null,
                left: rect.left,
                right: rect.right,
                width: rect.width,
                scrollWidth: el.scrollWidth,
                display: s.display,
                minWidth: s.minWidth,
                maxWidth: s.maxWidth,
                whiteSpace: s.whiteSpace,
                overflowX: s.overflowX,
                overflowWrap: s.overflowWrap,
                textLength: el.textContent?.length ?? 0,
              };
            })
            .filter((x) => x.width > 0 && (x.right > innerWidth + 1 || x.left < -1));
          return {
            width: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            candidates,
          };
        }),
      );
      save();
      await context.close();
    }
    r.layoutGate = r.pages.every((page) => page.horizontalOverflow === false) ? 'PASS' : 'FAIL';
    r.gate = r.layoutGate;
  } catch (error) {
    r.gate = 'FAIL';
    r.failure = /^[A-Z_]+$/.test(error.message) ? error.message : 'DIAGNOSTIC_EXECUTION_FAILED';
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        r.gate = 'FAIL';
        r.browserCloseFailure = true;
      }
    }
    if (created) {
      const cleanup = await cleanupLayoutDiagnosticIdentity(call);
      r.cleanup.push(cleanup);
      if (cleanup.result !== 'PASS') r.gate = 'FAIL';
    }
    r.finishedAt = new Date().toISOString();
    save();
  }
  console.log(
    JSON.stringify({
      gate: r.gate,
      layoutGate: r.layoutGate ?? 'NOT_RUN',
      cleanup: r.cleanup,
      pages: r.pages.map(({ width, documentWidth, horizontalOverflow }) => ({
        width,
        documentWidth,
        horizontalOverflow,
      })),
    }),
  );
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLayoutDiagnostic(process.argv.slice(2))
    .then((r) => {
      process.exitCode = r.gate === 'PASS' ? 0 : 1;
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          gate: 'FAIL',
          code: /^[A-Z_]+$/.test(error.message) ? error.message : 'DIAGNOSTIC_PRECHECK_FAILED',
        }),
      );
      process.exitCode = 1;
    });
}
