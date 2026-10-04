import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { seedSession, json, routeFe11To15Apis, dashboard, jwt } from './qa05-api-fixtures.js';
import type { Role } from './qa05-api-fixtures.js';

const ROLES: Role[] = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
const platform = ROLES.slice(0, 3);
const routes: [string, Role[]][] = [
  ['/dashboard', ROLES],
  ['/devices/view', ROLES],
  ['/devices/groups', ROLES],
  ['/devices/manage', ROLES],
  ['/devices/operate', ['PlatformSuperAdmin', 'PlatformOperator', 'CustomerAdmin']],
  ['/customers', platform],
  ['/sites', ROLES],
  ['/licenses', platform],
  ['/configurations', platform],
  ['/device-users', ['PlatformSuperAdmin', 'Auditor', 'CustomerAdmin', 'CustomerViewer']],
  ['/alarms', ROLES],
  ['/media', ROLES],
  ['/audit-logs', ['PlatformSuperAdmin', 'Auditor']],
  ['/esg/overview', ROLES],
  ['/esg/devices', ROLES],
  ['/contracts', platform],
  ['/contracts/new', ['PlatformSuperAdmin']],
  ['/contracts/detail', platform],
  ['/consumables', ['PlatformSuperAdmin', 'PlatformOperator', 'CustomerAdmin', 'CustomerViewer']],
  ['/settings', ['PlatformSuperAdmin', 'CustomerAdmin']],
  ['/ota/packages', platform],
  ['/ota/campaigns', platform],
];
for (const role of ROLES)
  test(`QA05 role route and button matrix ${role}`, async ({ page, qa05 }) => {
    await seedSession(page, role);
    await page.route('**/api/v1/admin/**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
    await routeFe11To15Apis(page);
    await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard }));
    await page.goto('/dashboard');
    for (const [path, allowed] of routes.filter(
      ([p]) =>
        !['/devices/manage', '/contracts/new', '/contracts/detail', '/ota/packages', '/ota/campaigns'].includes(p),
    ))
      await expect(page.getByTestId(`menu-item-${path}`)).toHaveCount(allowed.includes(role) ? 1 : 0);
    const matrix = [];
    for (const [path, allowed] of routes) {
      await page.goto(path);
      if (allowed.includes(role)) {
        await expect(page.getByTestId('page-content')).toBeVisible();
        await expect(page.getByRole('heading', { name: '403', exact: true })).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText('该页面尚未接入当前管理后台组合根');
      } else await expect(page.getByRole('heading', { name: '403', exact: true })).toBeVisible();
      matrix.push({ path, allowed: allowed.includes(role) });
    }
    const buttons = [];
    for (const [path, id, allowed, hidden] of [
      ['/customers', 'create-customer', platform.slice(0, 2), true],
      ['/sites', 'create-site', platform.slice(0, 2), true],
      ['/device-users', 'device-user-create', ['PlatformSuperAdmin', 'CustomerAdmin'], true],
      ['/settings', 'user-invite-open', ['PlatformSuperAdmin'], true],
      ['/consumables', 'consumable-request-create-open', platform.slice(0, 2), false],
      ['/licenses', 'license-create', platform.slice(0, 2), true],
      ['/configurations', 'config-create', platform.slice(0, 2), true],
      ['/contracts', 'contract-new-open', ['PlatformSuperAdmin'], false],
      ['/ota/packages', 'upload-session-open', platform.slice(0, 2), false],
      ['/ota/campaigns', 'campaign-create-open', platform.slice(0, 2), false],
    ] as [string, string, string[], boolean][]) {
      if (!routes.find(([p]) => p === path)![1].includes(role)) continue;
      await page.goto(path);
      const button = page.getByTestId(id);
      if (allowed.includes(role)) await expect(button).toBeEnabled();
      else if (hidden) await expect(button).toHaveCount(0);
      else await expect(button).toBeDisabled();
      buttons.push({ path, id, enabled: allowed.includes(role) });
    }
    qa05.proof.role = role;
    qa05.proof.routeMatrix = matrix;
    qa05.proof.buttons = buttons;
  });

test('QA05 login SRP MFA error success logout without persisting password', async ({ page, qa05 }) => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = `${encode({ alg: 'none' })}.${encode({ 'cognito:username': qa05.prefix, 'cognito:groups': ['PlatformSuperAdmin'], exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
  const operations: string[] = [];
  await page.route('https://cognito-idp.us-east-1.amazonaws.com/', async (route) => {
    const input = route.request().postDataJSON();
    const op = route.request().headers()['x-amz-target']!.split('.').pop()!;
    operations.push(op);
    expect(JSON.stringify(input)).not.toContain('QA05-Synthetic-Password-42!');
    if (op === 'GlobalSignOut') return json(route, {});
    if (op === 'InitiateAuth')
      return json(route, {
        ChallengeName: 'PASSWORD_VERIFIER',
        Session: qa05.prefix,
        ChallengeParameters: {
          USER_ID_FOR_SRP: qa05.prefix,
          SALT: 'a',
          SRP_B: '2',
          SECRET_BLOCK: Buffer.from('local-test').toString('base64'),
        },
      });
    if (input.ChallengeName === 'PASSWORD_VERIFIER')
      return json(route, { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: qa05.prefix, ChallengeParameters: {} });
    if (input.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE === '000000')
      return json(route, { __type: 'CodeMismatchException' }, 400);
    return json(route, {
      AuthenticationResult: {
        AccessToken: jwt(),
        IdToken: idToken,
        RefreshToken: 'qa05-synthetic-refresh',
        ExpiresIn: 3600,
        TokenType: 'Bearer',
      },
    });
  });
  await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard }));
  await page.goto('/login');
  await page.locator('#username').fill(qa05.prefix);
  await page.locator('#password').fill('QA05-Synthetic-Password-42!');
  await page.locator('button[type=submit]').click();
  await expect(page.locator('#confirmation-code')).toBeVisible();
  await page.locator('#confirmation-code').fill('000000');
  await page.locator('button[type=submit]').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.locator('#confirmation-code').fill('123456');
  await page.locator('button[type=submit]').click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByTestId('user-badge')).toContainText(qa05.prefix);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(
    'QA05-Synthetic-Password-42!',
  );
  await page.getByTestId('logout-button').click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => sessionStorage.getItem('fdp.admin.session.v1'))).toBeNull();
  expect(operations).toEqual([
    'InitiateAuth',
    'RespondToAuthChallenge',
    'RespondToAuthChallenge',
    'RespondToAuthChallenge',
    'GlobalSignOut',
  ]);
  qa05.proof.login = true;
  qa05.proof.mfaRetry = true;
  qa05.proof.logout = true;
});

test('QA05 ESG cursor totals export snapshot timezone and empty state', async ({ page, qa05 }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeFe11To15Apis(page);
  let exported: Record<string, unknown> | undefined;
  let empty = false;
  const seen: Record<string, string>[] = [];
  const rows = [1, 2].map((i) => ({
    deviceId: `${qa05.prefix}-${i}`,
    customerId: 'cust-a',
    summaryDate: '2026-10-01',
    feedingWeightKg: 10 * i,
    dischargeWeightKg: 5 * i,
    reductionWeightKg: 5 * i,
    powerConsumptionKwh: i,
    carbonReductionKg: 2 * i,
    dataCompletenessPct: 100,
    missingRecordCount: 0,
    calculationVersionId: null,
  }));
  await page.route('**/api/v1/admin/esg/daily-summary**', (route) => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    seen.push(query);
    return json(route, {
      data: empty ? [] : [rows[query['cursor'] === 'next' ? 1 : 0]],
      meta: { nextCursor: !empty && !query['cursor'] ? 'next' : null },
    });
  });
  await page.route('**/api/v1/admin/esg/exports**', (route) => {
    exported = route.request().postDataJSON();
    return json(
      route,
      {
        data: {
          exportId: qa05.prefix,
          dataset: 'DAILY_SUMMARY',
          status: 'COMPLETED',
          filters: exported,
          rowCount: 2,
          downloadUrl: 'https://exports.example.test/qa05.csv',
          urlExpiresAt: '2099-01-01T00:00:00Z',
          urlExpired: false,
          error: null,
          requestedBy: qa05.prefix,
          createdAt: '2026-10-01T00:00:00Z',
          completedAt: '2026-10-01T00:00:01Z',
        },
      },
      202,
    );
  });
  await page.goto('/esg/overview');
  await page.getByTestId('time-zone-select').selectOption('America/New_York');
  await page.getByTestId('esg-from-date').fill('2026-10-01');
  await page.getByTestId('esg-to-date').fill('2026-10-01');
  await page.getByTestId('esg-apply').click();
  await expect(page.getByTestId('esg-summary-table')).toContainText('30');
  await page.getByTestId('esg-export-csv').click();
  await expect(page.getByTestId('esg-export-download')).toBeVisible();
  expect(exported).toMatchObject({ from: '2026-10-01T04:00:00.000Z', to: '2026-10-02T03:59:59.999Z' });
  expect(seen.some((q) => q['cursor'] === 'next' && q['from'] === exported!['from'])).toBe(true);
  await page.reload();
  await expect(page.getByTestId('time-zone-select')).toHaveValue('America/New_York');
  empty = true;
  await page.reload();
  await expect(page.getByTestId('esg-empty')).toBeVisible();
  qa05.proof.cursorExport = true;
  qa05.proof.timezone = true;
  qa05.proof.empty = true;
});

test('QA05 Command dangerous confirmation terminal result and publish failure', async ({ page, qa05 }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeFe11To15Apis(page);
  let command: any = null;
  let writes = 0;
  await page.route('**/api/v1/admin/devices/dev-p0/commands', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.confirmation).toEqual({ confirmText: 'SHUTDOWN' });
    writes++;
    command = {
      commandId: `${qa05.prefix}-${writes}`,
      deviceId: 'dev-p0',
      customerId: 'cust-a',
      command: 'SHUTDOWN',
      category: 'DEVICE',
      highRisk: true,
      status: writes === 1 ? 'AUTHORIZED' : 'PUBLISH_FAILED',
      requestedBy: qa05.prefix,
      requestTime: '2026-10-01T00:00:00Z',
      timeoutSec: 300,
      expiresAt: '2026-10-01T00:05:00Z',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    };
    await json(route, { data: { ...command, replayed: false } }, 201);
  });
  await page.route('**/api/v1/admin/commands**', (route) =>
    new URL(route.request().url()).pathname.endsWith(command?.commandId ?? 'no-command')
      ? json(route, { data: { ...command, attempts: [], acks: [] } })
      : json(route, { data: command ? [command] : [], meta: { nextCursor: null } }),
  );
  await page.goto('/devices/operate?deviceId=dev-p0');
  await expect(page.getByTestId('quick-reboot')).toBeEnabled();
  for (let i = 1; i <= 2; i++) {
    await page.getByTestId('quick-reboot').click();
    await page.getByTestId('command-select').selectOption('SHUTDOWN');
    await page.getByTestId('command-confirm-text').fill('wrong');
    await expect(page.getByTestId('command-submit')).toBeDisabled();
    expect(writes).toBe(i - 1);
    await page.getByTestId('command-confirm-text').fill('SHUTDOWN');
    await page.getByTestId('command-submit').click();
    await expect.poll(() => writes).toBe(i);
    if (i === 1) {
      command.status = 'SUCCEEDED';
      await page.getByTestId('cmd-filter-status').selectOption('SUCCEEDED');
    }
    await expect(page.getByTestId(`command-detail-${command.commandId}`)).toBeVisible();
    await page.getByTestId(`command-detail-${command.commandId}`).click();
    await expect(page.getByTestId('command-detail-status')).toHaveText(i === 1 ? '执行成功' : '发布失败');
  }
  qa05.proof.dangerousConfirmation = true;
  qa05.proof.commandTerminal = true;
  qa05.proof.publishFailure = true;
});

test('QA05 Media expiry renew 403 and audit read-only zero writes', async ({ page, qa05 }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeFe11To15Apis(page);
  let signs = 0;
  let writes = 0;
  await page.route('https://media.example.test/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await page.route('**/api/v1/admin/media/media-fe14/download-url', (route) => {
    signs++;
    if (signs === 3)
      return json(route, { error: { code: 'FORBIDDEN', message: 'denied', requestId: qa05.prefix } }, 403);
    return json(route, {
      data: {
        mediaId: 'media-fe14',
        downloadUrl: `https://media.example.test/${qa05.prefix}.png`,
        downloadUrlExpiresAt: signs === 1 ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
      },
    });
  });
  await page.goto('/media');
  await page.getByTestId('media-open-media-fe14').click();
  await expect(page.getByTestId('media-url-expired')).toBeVisible();
  await expect(page.getByTestId('media-preview-image')).toHaveCount(0);
  await page.getByTestId('media-url-renew').click();
  await expect(page.getByTestId('media-preview-image')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('media-open-media-fe14').click();
  await expect(page.getByTestId('media-url-error')).toContainText('无权访问');
  await expect(page.getByTestId('media-preview-image')).toHaveCount(0);
  await expect(page.getByTestId('media-download-link')).toHaveCount(0);
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/audit-logs') && request.method() !== 'GET') writes++;
  });
  await page.goto('/audit-logs');
  await page.getByTestId('audit-detail-audit-fe15').click();
  await expect(page.getByTestId('audit-detail-before')).toContainText('[REDACTED]');
  await page.getByTestId('audit-filter-action').fill('COMMAND_CREATED');
  expect(writes).toBe(0);
  await expect(page.locator('body')).not.toContainText('must-redact');
  qa05.proof.mediaExpiry = true;
  qa05.proof.mediaRenew = true;
  qa05.proof.media403 = true;
  qa05.proof.auditReadOnly = true;
});
