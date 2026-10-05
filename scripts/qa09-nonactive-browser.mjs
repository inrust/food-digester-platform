import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { GROUPS, ABSENCE, VIEWPORTS, validateBindings } from './qa08-bindings.mjs';

export function semanticSummary(matrix, executions) {
  validateBindings(matrix);
  const allowed = new Set([...Object.keys(GROUPS), ...Object.keys(ABSENCE).map((id) => 'absence:' + id)]);
  if (
    new Set(executions.map((r) => r.group + ':' + r.width)).size !== executions.length ||
    executions.some(
      (r) => !allowed.has(r.group) || !VIEWPORTS.includes(r.width) || !['PASS', 'FAIL', 'NOT_RUN'].includes(r.result),
    )
  )
    throw Error('INVALID_TARGET_EXECUTION_ROWS');
  const elements = matrix.pages.flatMap((p) =>
    p.elements
      .filter((e) => ['Adopt', 'Adapt'].includes(e.disposition))
      .map((e) => {
        const group = Object.entries(GROUPS).find(([, ids]) => ids.includes(e.id))?.[0] ?? `absence:${e.id}`;
        const rows = VIEWPORTS.map((width) => executions.find((x) => x.group === group && x.width === width));
        const result = rows.some((r) => r?.result === 'FAIL')
          ? 'FAIL'
          : rows.every((r) => r?.result === 'PASS')
            ? 'PASS'
            : 'NOT_RUN';
        return {
          id: e.id,
          disposition: e.disposition,
          group,
          result,
          executions: rows.map((r, i) => r ?? { width: VIEWPORTS[i], result: 'NOT_RUN', reason: 'NO_TARGET_RECEIPT' }),
        };
      }),
  );
  if (elements.length !== 117 || new Set(elements.map((e) => e.id)).size !== 117) throw Error('INVALID_117_INVENTORY');
  const absence = Object.keys(ABSENCE).map((id) => {
    const rows = VIEWPORTS.map((width) => executions.find((r) => r.group === 'absence:' + id && r.width === width));
    return {
      id,
      result: rows.some((r) => r?.result === 'FAIL')
        ? 'FAIL'
        : rows.every((r) => r?.result === 'PASS')
          ? 'PASS'
          : 'NOT_RUN',
    };
  });
  return {
    absence,
    elements,
    counts: Object.fromEntries(
      ['PASS', 'FAIL', 'NOT_RUN'].map((v) => [v, elements.filter((e) => e.result === v).length]),
    ),
    gate: [...elements, ...absence].some((e) => e.result === 'FAIL')
      ? 'FAIL'
      : [...elements, ...absence].every((e) => e.result === 'PASS')
        ? 'PASS'
        : 'PARTIAL',
  };
}
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
export async function runNonActiveBrowser(ctx, output) {
  const { chromium, expect } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))(
    '@playwright/test',
  );
  const matrix = JSON.parse(readFileSync('contracts/prototype-traceability.yaml'));
  const r = {
    task: 'QA-09',
    scope: 'REAL_NONACTIVE_BUSINESS_SEMANTICS',
    sourceCommit: ctx.sourceCommit,
    prefix: ctx.prefix,
    startedAt: new Date().toISOString(),
    browser: 'Playwright Chromium',
    apiMock: false,
    sessionMutation: false,
    credentialsExported: false,
    fullQa09Accepted: false,
    executions: [],
    pages: [],
    traffic: [],
    networkFailures: [],
    consoleErrorCategories: [],
    cleanupByParent: true,
    gate: 'RUNNING',
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  const role = 'PlatformSuperAdmin',
    base = '/api/v1/admin';
  const api = (id, method, path, status, body, headers) =>
    ctx.api(id, role, method, base + path, status, body, headers);
  const own = ctx.devices[0],
    now = Date.now();
  const contract = (
    await api('semantic-contract-create', 'POST', '/contracts', 201, {
      contractNumber: ctx.prefix + '-semantic',
      name: ctx.prefix + '-semantic',
      customerId: ctx.customers[0].id,
      startAt: new Date(now - 86400000).toISOString(),
      endAt: new Date(now + 90 * 86400000).toISOString(),
    })
  ).data;
  const cp = '/contracts/' + contract.contractId;
  await api(
    'semantic-contract-activate',
    'POST',
    cp + '/activate',
    200,
    { reason: ctx.prefix },
    { 'If-Match': String(contract.version) },
  );
  await api('semantic-contract-bind', 'POST', cp + '/devices/bind', 201, { deviceIds: [own], reason: ctx.prefix });
  const pending = (
    await api('semantic-consumable-create', 'POST', '/consumable-requests', 201, {
      deviceId: own,
      consumableType: 'CARBON_FILTER',
      note: ctx.prefix,
    })
  ).data;
  const du = (
    await ctx.api('semantic-device-user-create', 'CustomerAdmin', 'POST', base + '/device-users', 201, {
      username: ctx.prefix + '-browser',
      password: `A!z9${randomBytes(20).toString('base64url')}`,
      displayName: ctx.prefix + '-browser',
    })
  ).data;
  const sitePath = '/sites/' + ctx.sites[0].id;
  const site = (await api('semantic-site-read', 'GET', sitePath, 200)).data;
  await api(
    'semantic-site-region',
    'PATCH',
    sitePath,
    200,
    { region: ctx.prefix + '-region', subregion: ctx.prefix + '-subregion' },
    { 'If-Match': String(site.version) },
  );
  const dev = (await api('semantic-device-before', 'GET', '/devices/' + own, 200)).data;
  await ctx.api(
    'operator-legal-alias-write',
    'PlatformOperator',
    'PATCH',
    base + '/devices/' + own + '/metadata',
    200,
    { alias: ctx.prefix + '-alias' },
    { 'If-Match': dev.updatedAt },
  );
  const observed = (await api('operator-alias-readback', 'GET', '/devices/' + own, 200)).data;
  if (observed.alias !== ctx.prefix + '-alias' || observed.lifecycleStatus === 'Active')
    throw Error('NONACTIVE_ALIAS_PROOF_FAILED');
  const customerPath = base + '/customers/' + ctx.customers[0].id;
  const customer = (await ctx.api('operator-customer-before', 'PlatformOperator', 'GET', customerPath, 200)).data;
  await ctx.api(
    'operator-legal-customer-patch',
    'PlatformOperator',
    'PATCH',
    customerPath,
    200,
    { name: customer.name },
    { 'If-Match': String(customer.version) },
  );
  const customerAfter = (await ctx.api('operator-customer-readback', 'PlatformOperator', 'GET', customerPath, 200))
    .data;
  if (customerAfter.name !== customer.name || customerAfter.version <= customer.version)
    throw Error('CUSTOMER_WRITE_NOT_PERSISTED');
  await ctx.api(
    'customer-admin-legal-password-rotation',
    'CustomerAdmin',
    'PATCH',
    base + '/device-users/' + du.deviceUserId,
    200,
    { password: `A!z9${randomBytes(20).toString('base64url')}`, reason: ctx.prefix },
    { 'If-Match': String(du.version) },
  );
  const userRead = (
    await ctx.api(
      'customer-admin-password-readback',
      'CustomerAdmin',
      'GET',
      base + '/device-users/' + du.deviceUserId,
      200,
    )
  ).data;
  if (userRead.version <= du.version || JSON.stringify(userRead).includes('password'))
    throw Error('DEVICE_USER_ROTATION_PROOF_FAILED');
  const extraSite = (
    await ctx.api('operator-legal-site-create', 'PlatformOperator', 'POST', base + '/sites', 201, {
      customerId: ctx.customers[1].id,
      name: ctx.prefix + '-operator-site',
      timezone: 'Asia/Shanghai',
    })
  ).data;
  ctx.sites.push(extraSite);
  const extraPath = base + '/sites/' + extraSite.id;
  const updatedSite = (
    await ctx.api(
      'operator-legal-site-patch',
      'PlatformOperator',
      'PATCH',
      extraPath,
      200,
      { address: ctx.prefix },
      { 'If-Match': String(extraSite.version) },
    )
  ).data;
  if ((await ctx.api('operator-site-readback', 'PlatformOperator', 'GET', extraPath, 200)).data.address !== ctx.prefix)
    throw Error('SITE_WRITE_NOT_PERSISTED');
  await ctx.api(
    'operator-legal-site-deactivate',
    'PlatformOperator',
    'POST',
    extraPath + '/deactivate',
    200,
    { reason: ctx.prefix },
    { 'If-Match': String(updatedSite.version) },
  );
  if (
    (await ctx.api('operator-site-status-readback', 'PlatformOperator', 'GET', extraPath, 200)).data.status !==
    'SUSPENDED'
  )
    throw Error('SITE_DEACTIVATION_NOT_PERSISTED');
  let license = (
    await ctx.api('nonactive-license-create', 'PlatformOperator', 'POST', base + '/licenses', 201, {
      deviceId: ctx.devices[1],
      validFrom: new Date(now - 86400000).toISOString(),
      validTo: new Date(now + 30 * 86400000).toISOString(),
      entitlements: ['REMOTE_CONTROL', 'ESG_REPORTING'],
      reason: ctx.prefix,
    })
  ).data;
  const licensePath = base + '/licenses/' + license.licenseId;
  license = (
    await ctx.api('nonactive-license-issue', 'PlatformOperator', 'POST', licensePath + '/issue', 200, undefined, {
      'If-Match': String(license.version),
    })
  ).data;
  if (
    (await ctx.api('nonactive-license-issued-readback', 'PlatformOperator', 'GET', licensePath, 200)).data.status !==
    'Issued'
  )
    throw Error('LICENSE_ISSUE_NOT_PERSISTED');
  license = (
    await ctx.api(
      'nonactive-server-license-activate',
      'PlatformOperator',
      'POST',
      licensePath + '/activate',
      200,
      undefined,
      { 'If-Match': String(license.version) },
    )
  ).data;
  if (
    (await ctx.api('nonactive-server-license-active-readback', 'PlatformOperator', 'GET', licensePath, 200)).data
      .status !== 'Active'
  )
    throw Error('SERVER_LICENSE_ACTIVATION_NOT_PERSISTED');
  await ctx.api(
    'nonactive-license-revoke',
    'PlatformOperator',
    'POST',
    licensePath + '/revoke',
    200,
    { reason: ctx.prefix },
    { 'If-Match': String(license.version) },
  );
  if (
    (await ctx.api('nonactive-license-revoked-readback', 'PlatformOperator', 'GET', licensePath, 200)).data.status !==
    'Revoked'
  )
    throw Error('LICENSE_REVOKE_NOT_PERSISTED');
  if (
    (await api('nonactive-license-device-readback', 'GET', '/devices/' + ctx.devices[1], 200)).data.lifecycleStatus ===
    'Active'
  )
    throw Error('UNEXPECTED_DEVICE_ACTIVE');
  r.fixture = {
    deviceId: own,
    contractId: contract.contractId,
    requestId: pending.requestId,
    deviceUserId: du.deviceUserId,
    lifecycleStatus: observed.lifecycleStatus,
  };
  r.sources = [
    'scripts/qa09-nonactive-browser.mjs',
    'scripts/qa08-bindings.mjs',
    'contracts/prototype-traceability.yaml',
  ].map((path) => {
    const b = readFileSync(path);
    return { path, sha256: createHash('sha256').update(b).digest('hex'), sourceBase64: b.toString('base64') };
  });
  save();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of VIEWPORTS) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 1000 } });
      const page = await context.newPage();
      page.on('requestfailed', (req) => {
        const u = new URL(req.url());
        if (u.origin === 'https://api.bio-nexa.com')
          r.networkFailures.push({
            width,
            method: req.method(),
            path: u.pathname,
            code: req.failure()?.errorText ?? 'UNKNOWN',
          });
      });
      page.on('console', (message) => {
        if (message.type() === 'error')
          r.consoleErrorCategories.push({
            width,
            category: /CORS|Access-Control/i.test(message.text()) ? 'CORS' : 'OTHER',
            textSha256: createHash('sha256').update(message.text()).digest('hex'),
          });
      });
      page.on('response', (res) => {
        const u = new URL(res.url());
        if (u.origin === 'https://api.bio-nexa.com')
          r.traffic.push({
            width,
            method: res.request().method(),
            path: u.pathname,
            status: res.status(),
            requestId: res.headers()['x-amzn-requestid'] ?? null,
          });
      });
      const login = ctx.logins.get(role);
      await page.goto('https://admin.bio-nexa.com/login');
      await page.getByLabel('用户名').fill(login.username);
      await page.getByLabel('密码', { exact: true }).fill(login.password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL('**/dashboard', { timeout: 30000 });
      const close = async () => {
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
      };
      for (const p of matrix.pages) {
        const go = async () => {
          let route = p.routeId;
          if (p.pageState === 'contract-detail') route += '?contractId=' + contract.contractId;
          if (p.pageState === 'device-manage') route += '?deviceId=' + own;
          await page.goto('https://admin.bio-nexa.com' + route, { waitUntil: 'domcontentloaded' });
          await expect(page.getByTestId(roots[p.pageState])).toBeVisible({ timeout: 20000 });
          await page.waitForLoadState('networkidle', { timeout: 15000 });
          if (['device-view', 'device-operate', 'esg-device'].includes(p.pageState)) {
            await page.locator('#scope-region').selectOption(ctx.prefix + '-region');
            await page.locator('#scope-subregion').selectOption(ctx.prefix + '-subregion');
            await page.locator('#scope-site').selectOption(ctx.sites[0].id);
            await page.locator('#scope-device').selectOption(own);
            if (p.pageState !== 'device-operate')
              await page.getByTestId(p.pageState === 'device-view' ? 'view-apply' : 'esg-device-apply').click();
            await page.waitForLoadState('networkidle');
          }
        };
        const columns = async (table, names) => {
          for (const name of names)
            await expect(page.getByTestId(table).getByRole('columnheader', { name, exact: true })).toBeVisible();
        };
        const axes = async (table) => {
          const current = (await api('browser-axis-readback-' + table + '-' + width, 'GET', '/devices/' + own, 200))
            .data;
          const row = page.getByTestId(table).getByRole('row').filter({ hasText: own });
          for (const [axis, value] of Object.entries({
            connectivity: current.connectivity,
            lifecycle: current.lifecycleStatus,
            operational: current.operationalStatus,
            license: current.license?.status ?? null,
          }))
            await expect(row.locator('[data-axis="' + axis + '"]')).toHaveAttribute('data-value', value ?? 'unknown');
        };
        const navigate = async (id, suffix) => {
          await page.getByTestId(id).click();
          await expect(page).toHaveURL(new RegExp(suffix));
        };
        const groups = [
          ...Object.keys(GROUPS).filter((k) => k.startsWith(p.pageState + '.')),
          ...Object.keys(ABSENCE)
            .filter((k) => k.startsWith(p.pageState + '.'))
            .map((k) => 'absence:' + k),
        ];
        for (const group of groups) {
          const row = { group, width, role, result: 'RUNNING', startedAt: new Date().toISOString() },
            start = r.traffic.length;
          try {
            await go();
            if (group.startsWith('absence:')) {
              const id = group.slice(8);
              if (id === 'settings.modal.passwordInput') {
                await page.getByTestId('user-invite-open').click();
                await expect(page.getByRole('dialog').locator('input[type="password"]')).toHaveCount(0);
                await close();
              } else if (id === 'settings.field.permissionCheckboxes') {
                const boxes = page.locator('input[data-testid^="rbac-"]');
                expect(await boxes.count()).toBeGreaterThan(0);
                for (const box of await boxes.all()) await expect(box).toBeDisabled();
              } else {
                const root = page.getByTestId('page-content');
                await expect(root.getByRole('button', { name: new RegExp(ABSENCE[id]) })).toHaveCount(0);
                await expect(root.getByRole('columnheader', { name: new RegExp(ABSENCE[id]) })).toHaveCount(0);
              }
            } else
              switch (group) {
                case 'dashboard.summary': {
                  for (const id of ['metric-contracts', 'metric-devices', 'metric-online', 'metric-carbon'])
                    await expect(page.getByTestId(id)).toBeVisible();
                  const data = (await api('browser-dashboard-readback-' + width, 'GET', '/dashboard/overview', 200))
                    .data;
                  for (const [id, value] of Object.entries({
                    'metric-contracts': data.contracts.effectiveTotal,
                    'metric-devices': data.devices.total,
                    'metric-online': data.devices.online,
                    'metric-carbon': data.esgToday.carbonReductionKg,
                  }))
                    await expect(page.getByTestId(id)).toContainText(String(value));
                  row.proof = 'METRICS_MATCH_REAL_API_VALUES';
                  row.apiKeys = Object.keys(data);
                  break;
                }
                case 'dashboard.collections':
                  await expect(page.getByTestId('latest-alarms')).toBeVisible();
                  await expect(page.getByTestId('device-card-' + own)).toContainText(ctx.prefix + '-alias');
                  break;
                case 'dashboard.commands':
                  row.result = 'NOT_RUN';
                  row.reason = 'START_STOP_REBOOT_REQUIRE_ACTIVE';
                  break;
                case 'dashboard.upgrade':
                  if (await page.getByTestId('action-upgrade-' + own).isDisabled()) {
                    row.result = 'NOT_RUN';
                    row.reason = 'OTA_REQUIRES_ACTIVE_ONLINE';
                    break;
                  }
                  await navigate('action-upgrade-' + own, '/ota/campaigns$');
                  break;
                case 'device-view.scope':
                case 'esg-device.scope':
                  await expect(page.locator('#scope-device')).toHaveValue(own);
                  await page.locator('#scope-region').selectOption('');
                  for (const id of ['#scope-subregion', '#scope-site', '#scope-device'])
                    await expect(page.locator(id)).toHaveValue('');
                  await expect(page.locator('#scope-subregion')).toBeDisabled();
                  break;
                case 'device-view.console':
                  for (const id of ['console-components', 'console-consumables', 'console-alarms', 'console-esg7d'])
                    await expect(page.getByTestId(id)).toBeVisible();
                  row.proof = 'NONACTIVE_EMPTY_DATA_SEMANTICS_ONLY';
                  row.result = 'NOT_RUN';
                  row.reason = 'REAL_SENSOR_CONSUMABLE_ALARM_ESG_DATA_NOT_PROVIDED';
                  break;
                case 'device-view.media':
                  row.result = 'NOT_RUN';
                  row.reason = 'NO_OWN_MEDIA_UPLOAD_DEVICE';
                  break;
                case 'device-operate.commands':
                  row.result = 'NOT_RUN';
                  row.reason = 'ACTUATION_REQUIRES_ACTIVE';
                  break;
                case 'device-operate.configuration':
                  await navigate('goto-config-threshold', '/configurations$');
                  break;
                case 'device-operate.alias':
                  await page.getByTestId('goto-alias').click();
                  await page.getByTestId('alias-edit').click();
                  await page.getByTestId('alias-input').fill(ctx.prefix + '-alias');
                  await page.getByTestId('alias-save').click();
                  await expect(page.getByTestId('alias-current')).toContainText(ctx.prefix + '-alias');
                  if (
                    (await api('browser-alias-persisted-' + width, 'GET', '/devices/' + own, 200)).data.alias !==
                    ctx.prefix + '-alias'
                  )
                    throw Error('ALIAS_NOT_PERSISTED');
                  break;
                case 'device-operate.activities':
                  if ((await page.getByTestId('activity-table').locator('table').count()) === 0) {
                    row.result = 'NOT_RUN';
                    row.reason = 'NO_OWN_ACTIVITY_ROWS';
                    break;
                  }
                  await columns('activity-table', ['时间', '级别', '内容']);
                  await page.getByTestId('activity-filter-level').selectOption('INFO');
                  await page.getByTestId('activity-filter-search').click();
                  await page.waitForLoadState('networkidle');
                  row.proof = 'FILTER_ONLY_EXPORT_NOT_RUN';
                  row.result = 'NOT_RUN';
                  row.reason = 'EXPORT_COMPLETION_NOT_EXECUTED';
                  break;
                case 'device-group.filters':
                  await page.getByTestId('device-keyword').fill(ctx.prefix);
                  await page.getByTestId('device-search').click();
                  await expect(page.getByTestId('device-groups-page')).toContainText(own);
                  await page.getByTestId('device-reset').click();
                  await expect(page.getByTestId('device-keyword')).toHaveValue('');
                  break;
                case 'device-group.columns':
                  await columns('device-groups-page', [
                    '序号',
                    '设备区域',
                    '设备子区域',
                    '设备唯一ID',
                    '设备别名',
                    '关联合约名称',
                    '租期期限',
                    '软件版本',
                  ]);
                  await expect(page.getByTestId('device-groups-page')).toContainText(own);
                  await expect(page.getByTestId('device-groups-page')).toContainText(ctx.prefix + '-region');
                  await expect(page.getByTestId('device-groups-page')).toContainText(ctx.prefix + '-alias');
                  await axes('device-groups-page');
                  break;
                case 'device-group.manage':
                  await navigate('manage-' + own, '/devices/manage\\?deviceId=' + own);
                  await expect(page.getByTestId('device-manage-page')).toContainText(own);
                  break;
                case 'device-group.onboarding':
                  row.result = 'NOT_RUN';
                  row.reason = 'NO_OWN_PENDING_CSR_IN_THIS_BUSINESS_FIXTURE';
                  break;
                case 'device-manage.configuration': {
                  const draft = (
                    await ctx.api(
                      'browser-config-draft-' + width,
                      'PlatformOperator',
                      'POST',
                      base + '/configurations/' + ctx.configId + '/versions',
                      201,
                      {
                        payload: {
                          heartbeatInterval: 60,
                          telemetryInterval: 30,
                          cameraRefreshInterval: 1,
                          temperatureThreshold: 80,
                        },
                      },
                    )
                  ).data;
                  await navigate('goto-current-config', '/configurations$');
                  await page.getByTestId('config-detail-open-' + ctx.configId).click();
                  await expect(page.getByTestId('config-detail')).toContainText(ctx.prefix);
                  await page.getByTestId('config-publish-' + draft.version).click();
                  await expect(page.getByTestId('config-publish')).toBeEnabled();
                  await close();
                  await go();
                  await navigate('goto-publish-config', '/configurations$');
                  break;
                }
                case 'device-manage.ota':
                  for (const [id, path] of [
                    ['goto-ota-packages', '/ota/packages$'],
                    ['goto-ota-campaigns', '/ota/campaigns$'],
                  ]) {
                    await go();
                    await navigate(id, path);
                  }
                  break;
                case 'device-manage.certificate':
                  row.result = 'NOT_RUN';
                  row.reason = 'NO_CERTIFICATE_IN_ONBOARDED_DB_FIXTURE';
                  break;
                case 'device-manage.back':
                  await navigate('manage-back', '/devices/groups$');
                  break;
                case 'device-consumable.filters':
                  await page.getByTestId('consumable-filter-keyword').fill(ctx.prefix);
                  await page.getByTestId('consumable-search').click();
                  await expect(page.getByTestId('consumable-table')).toContainText(own);
                  await page.getByTestId('consumable-reset').click();
                  await expect(page.getByTestId('consumable-filter-keyword')).toHaveValue('');
                  break;
                case 'device-consumable.columns':
                  await columns('consumable-table', [
                    '设备区域',
                    '设备子区域',
                    '设备唯一ID',
                    '设备别名',
                    '碳包预估剩余百分比',
                    '活性菌预估剩余百分比',
                  ]);
                  for (const id of ['consumable-carbon-', 'consumable-bio-']) {
                    await expect(page.getByTestId(id + own)).toContainText('unknown');
                    await expect(page.getByTestId(id + own).locator('.consumable-bar')).toHaveCount(0);
                  }
                  break;
                case 'device-consumable.contact':
                  await page.getByTestId('consumable-contact-' + own).click();
                  await expect(page.getByTestId('consumable-contact-info-' + own)).toBeVisible();
                  break;
                case 'device-consumable.requests': {
                  await columns('consumable-requests-table', ['用户申请时间', '处理状态']);
                  const fresh = (
                    await api('browser-consumable-new-' + width, 'POST', '/consumable-requests', 201, {
                      deviceId: ctx.devices[width === 375 ? 3 : 4],
                      consumableType: 'BIO_ADDITIVE',
                      note: ctx.prefix,
                    })
                  ).data;
                  await go();
                  for (const action of ['process', 'complete']) {
                    await page.getByTestId(`consumable-${action}-${fresh.requestId}`).click();
                    await page.getByTestId('consumable-action-note').fill(ctx.prefix);
                    await Promise.all([
                      page.waitForResponse(
                        (res) =>
                          res.request().method() === 'POST' && res.url().endsWith('/' + action) && res.status() === 200,
                      ),
                      page.getByTestId('consumable-action-submit').click(),
                    ]);
                    await page.waitForLoadState('networkidle');
                  }
                  const read = (
                    await api(
                      'browser-consumable-completed-' + width,
                      'GET',
                      '/consumable-requests/' + fresh.requestId,
                      200,
                    )
                  ).data;
                  expect(read.status).toBe('COMPLETED');
                  break;
                }
                case 'contract-modify.columns':
                  await columns('contract-list', ['合约编号', '客户', '设备数量', '服务期限', '状态（合约）']);
                  await expect(page.getByTestId('contract-device-count-' + contract.contractId)).toHaveText('1');
                  await expect(page.getByTestId('contract-status-' + contract.contractId)).toContainText('生效');
                  break;
                case 'contract-modify.new':
                  await navigate('contract-new-open', '/contracts/new$');
                  break;
                case 'contract-modify.detail':
                  await page.getByTestId('contract-open-' + contract.contractId).click();
                  await expect(page.getByTestId('contract-devices-table')).toContainText(own);
                  await page.getByTestId('contract-edit-open').click();
                  await expect(page.getByTestId('contract-edit-name')).toHaveValue(ctx.prefix + '-semantic');
                  await close();
                  await page.getByTestId('contract-renew-open').click();
                  await expect(page.getByTestId('contract-renew-submit')).toBeDisabled();
                  await close();
                  await page.getByTestId('contract-unbind-check-' + own).check();
                  await page.getByTestId('contract-unbind-open').click();
                  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
                  await close();
                  break;
                case 'contract-new.fields':
                  await page.getByTestId('contract-number-input').fill(ctx.prefix + '-form');
                  await page.getByTestId('contract-name-input').fill(ctx.prefix);
                  await page.getByTestId('contract-customer-select').selectOption(ctx.customers[0].id);
                  await page.getByTestId('contract-start-input').fill('2026-10-01T00:00');
                  await page.getByTestId('contract-end-input').fill('2027-10-01T00:00');
                  await expect(page.getByTestId('contract-create-submit')).toBeEnabled();
                  break;
                case 'contract-new.submit': {
                  await page.getByTestId('contract-number-input').fill(ctx.prefix + '-ui-' + width);
                  await page.getByTestId('contract-name-input').fill(ctx.prefix + '-ui-' + width);
                  await page.getByTestId('contract-customer-select').selectOption(ctx.customers[0].id);
                  await page.getByTestId('contract-start-input').fill('2026-10-01T00:00');
                  await page.getByTestId('contract-end-input').fill('2027-10-01T00:00');
                  await page.getByTestId('contract-create-submit').click();
                  const d = ctx.devices[width === 375 ? 3 : 4];
                  await expect(page.getByTestId('contract-new-device-' + d)).toBeVisible();
                  await page.getByTestId('contract-new-device-' + d).check();
                  await page.getByTestId('contract-bind-reason').fill(ctx.prefix);
                  await page.getByTestId('contract-bind-submit').click();
                  await expect(page.getByTestId('contract-new-done')).toBeEnabled();
                  break;
                }
                case 'contract-new.cancel':
                  await navigate('contract-create-cancel', '/contracts$');
                  break;
                case 'contract-detail.devices':
                  await columns('contract-devices-table', [
                    '区域',
                    '子区域',
                    '唯一 ID',
                    '别名',
                    '软件版本',
                    '四轴状态',
                    '授权状态（License，独立）',
                  ]);
                  await expect(page.getByTestId('contract-devices-table')).toContainText(own);
                  await expect(page.getByTestId('contract-devices-table')).toContainText(ctx.prefix + '-alias');
                  await axes('contract-devices-table');
                  break;
                case 'contract-detail.back':
                  await navigate('contract-detail-back', '/contracts$');
                  break;
                case 'esg-overview.period':
                case 'esg-device.period':
                  for (const period of ['day', 'week', 'month']) {
                    const id = (group.startsWith('esg-device') ? 'esg-device-period-' : 'period-') + period;
                    await page.getByTestId(id).click();
                    await expect(page.getByTestId(id)).toHaveAttribute('aria-pressed', 'true');
                  }
                  break;
                case 'esg-overview.columns':
                  if ((await page.getByTestId('esg-summary-table').getByRole('columnheader').count()) === 0) {
                    row.result = 'NOT_RUN';
                    row.reason = 'NO_OWN_ESG_ROWS';
                    break;
                  }
                  await columns('esg-summary-table', ['日期间', '投料量 (kg)', '能耗 (kWh)', '估算 CO2e (kg)']);
                  await expect(page.getByTestId('esg-disclaimer')).toContainText('估算');
                  row.proof = 'EMPTY_DATA_TABLE_AND_ESTIMATE_DISCLOSURE';
                  break;
                case 'esg-device.metrics':
                  if ((await page.getByTestId('esg-device-metrics').getByRole('columnheader').count()) === 0) {
                    row.result = 'NOT_RUN';
                    row.reason = 'NO_OWN_ESG_ROWS';
                    break;
                  }
                  await columns('esg-device-metrics', [
                    '投料 (kg)',
                    '出料 (kg)',
                    '减量 (kg)',
                    '能耗 (kWh)',
                    'O2 (%)',
                    'CO2 (ppm)',
                    'CH4 (ppm)',
                    'N2O (ppm)',
                    '估算 CO2e (kg)',
                  ]);
                  row.proof = 'EMPTY_DATA_COLUMN_SEMANTICS';
                  break;
                case 'esg-overview.export':
                case 'esg-device.export':
                  row.result = 'NOT_RUN';
                  row.reason = 'NO_OWN_TELEMETRY_EXPORT_IN_THIS_FIXTURE';
                  break;
                case 'settings.platform':
                  await page.getByTestId('user-invite-open').click();
                  await expect(page.getByTestId('invite-email')).toBeVisible();
                  await expect(page.getByRole('dialog').locator('input[type="password"]')).toHaveCount(0);
                  await close();
                  row.result = 'NOT_RUN';
                  row.reason = 'INVITE_FORM_ONLY_NO_EMAIL_SEND_OR_PLATFORM_USER_MUTATION';
                  break;
                case 'settings.device-users': {
                  await page.getByTestId('tab-device-users').click();
                  await page.getByTestId('device-user-keyword').fill(ctx.prefix);
                  await page.getByTestId('device-user-search').click();
                  await page.getByTestId('device-user-filter-reset').click();
                  await expect(page.getByTestId('device-user-keyword')).toHaveValue('');
                  await page.getByTestId('device-user-create').click();
                  const uiName = ctx.prefix + '-ui-user-' + width;
                  await page.getByTestId('create-user-customer').selectOption(ctx.customers[0].id);
                  await page.getByTestId('create-username').fill(uiName);
                  await page.getByTestId('create-display-name').fill(uiName);
                  await page.getByTestId('create-password').fill(`A!z9${randomBytes(20).toString('base64url')}`);
                  await page.getByTestId('create-user-reason').fill(ctx.prefix);
                  await page.getByTestId('create-user-submit').click();
                  await expect(page.getByRole('dialog')).toHaveCount(0);
                  const listing = (
                    await api(
                      'browser-user-create-readback-' + width,
                      'GET',
                      '/device-users?customerId=' + ctx.customers[0].id + '&keyword=' + uiName,
                      200,
                    )
                  ).data;
                  const uiUser = listing.find((x) => x.username === uiName);
                  expect(uiUser?.deviceUserId).toBeTruthy();
                  await page.getByTestId('device-user-detail-' + uiUser.deviceUserId).click();
                  await page.getByTestId('device-user-password-reset').click();
                  await page.getByTestId('reset-password').fill(`A!z9${randomBytes(20).toString('base64url')}`);
                  await page.getByTestId('reset-reason').fill(ctx.prefix);
                  await Promise.all([
                    page.waitForResponse(
                      (res) =>
                        res.request().method() === 'PATCH' &&
                        res.url().endsWith('/device-users/' + uiUser.deviceUserId) &&
                        res.status() === 200,
                    ),
                    page.getByTestId('reset-submit').click(),
                  ]);
                  await expect(page.getByRole('dialog')).toHaveCount(0);
                  const resetRead = (
                    await api(
                      'browser-user-reset-readback-' + width,
                      'GET',
                      '/device-users/' + uiUser.deviceUserId,
                      200,
                    )
                  ).data;
                  expect(resetRead.version).toBeGreaterThan(uiUser.version);
                  await page.getByTestId('device-user-disable').click();
                  await page.getByTestId('confirm-dialog').locator('textarea').fill(ctx.prefix);
                  await Promise.all([
                    page.waitForResponse(
                      (res) =>
                        res.request().method() === 'POST' &&
                        res.url().endsWith('/device-users/' + uiUser.deviceUserId + '/disable') &&
                        res.status() === 200,
                    ),
                    page.getByTestId('confirm-dialog').locator('button.danger-button').click(),
                  ]);
                  await expect(page.getByRole('dialog')).toHaveCount(0);
                  expect(
                    (
                      await api(
                        'browser-user-disabled-readback-' + width,
                        'GET',
                        '/device-users/' + uiUser.deviceUserId,
                        200,
                      )
                    ).data.status,
                  ).toBe('DISABLED');
                  break;
                }
                default:
                  throw Error('UNBOUND_TARGET_GROUP');
              }
            if (row.result === 'RUNNING') row.result = 'PASS';
          } catch (e) {
            row.result = 'FAIL';
            row.errorName = e.name;
            const notices = await page
              .locator('.error-notice')
              .allTextContents()
              .catch(() => []);
            row.noticeDiagnostics = notices.map((value) => ({
              sha256: createHash('sha256').update(value).digest('hex'),
              detailVersionUnavailable: value.includes('详情版本不可用'),
              networkFailure: /网络|Network|fetch/i.test(value),
              validationFailed: value.includes('VALIDATION_FAILED'),
            }));
            row.failure = String(e.message).replaceAll(ctx.prefix, '<own-prefix>').slice(0, 180);
          }
          row.requests = r.traffic.slice(start);
          row.finishedAt = new Date().toISOString();
          r.executions.push(row);
          console.log(JSON.stringify({ group, width, result: row.result, reason: row.reason ?? null }));
          Object.assign(r, semanticSummary(matrix, r.executions));
          save();
        }
        try {
          await go();
          const root = page.getByTestId(roots[p.pageState]);
          const dom = await root.evaluate((el) => ({
            headings: [...el.querySelectorAll('h1,h2,h3,h4')].map((x) => x.textContent),
            columns: [...el.querySelectorAll('th')].map((x) => x.textContent),
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
          }));
          r.pages.push({
            pageState: p.pageState,
            width,
            domSha256: createHash('sha256').update(JSON.stringify(dom)).digest('hex'),
            horizontalOverflow: dom.overflow,
          });
          if (p.pageState === 'contract-new') {
            const bytes = await root.screenshot();
            const path = output + '-' + width + '.png';
            writeFileSync(path, bytes);
            r.pages.at(-1).screenshot = { path, sha256: createHash('sha256').update(bytes).digest('hex') };
          }
        } catch {
          r.pages.push({ pageState: p.pageState, width, gate: 'FAIL' });
        }
        save();
      }
      await context.close();
    }
  } finally {
    await browser.close();
    r.finishedAt = new Date().toISOString();
    Object.assign(r, semanticSummary(matrix, r.executions));
    r.layoutGate =
      r.pages.length === 24 && r.pages.every((p) => p.gate !== 'FAIL' && p.horizontalOverflow === false)
        ? 'PASS'
        : 'FAIL';
    if (r.layoutGate === 'FAIL') r.gate = 'FAIL';
    save();
  }
  return r;
}
