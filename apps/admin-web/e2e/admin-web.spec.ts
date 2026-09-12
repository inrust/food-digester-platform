import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

type Role = 'PlatformSuperAdmin' | 'PlatformOperator' | 'Auditor' | 'CustomerAdmin' | 'CustomerViewer';

function jwt(expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.signature`;
}

async function seedSession(page: Page, role: Role, options: { expired?: boolean; customerId?: string } = {}) {
  const accessToken = options.expired ? 'expired-session-token' : jwt();
  await page.addInitScript(
    ({ role: selectedRole, accessToken: token, customerId }) => {
      sessionStorage.setItem(
        'fdp.admin.session.v1',
        JSON.stringify({
          username: `e2e-${selectedRole}`,
          roles: [selectedRole],
          customerId,
          idToken: 'redacted-id-token',
          accessToken: token,
          refreshToken: 'redacted-refresh-token',
          expiresInSeconds: token === 'expired-session-token' ? 1 : 3600,
          obtainedAtMs: token === 'expired-session-token' ? 0 : Date.now(),
        }),
      );
    },
    { role, accessToken, customerId: options.customerId ?? (role.startsWith('Customer') ? 'cust-a' : null) },
  );
}

const section = (requestId = 'req-e2e') => ({
  status: 'READY',
  errorCode: null,
  requestId,
  dataUpdatedAt: '2026-09-10T00:00:00Z',
});

const dashboard = {
  generatedAt: '2026-09-10T00:00:00Z',
  sections: { summary: section(), latestAlarms: section(), deviceCards: section() },
  contracts: { effectiveTotal: 1 },
  devices: { total: 1, online: 0, onlineRatePct: 0, licenseDistribution: { Active: 1 } },
  esgToday: {
    summaryDate: '2026-09-10',
    carbonReductionKg: 1,
    powerConsumptionKwh: 2,
    feedingWeightKg: 3,
  },
  latestAlarms: [],
  deviceCards: [
    {
      deviceId: 'dev-offline',
      serialNumber: 'SN-OFFLINE',
      alias: null,
      model: 'FD-100',
      lifecycleStatus: 'Active',
      operationalStatus: 'Active',
      connectivity: 'OFFLINE',
      licenseStatus: 'Active',
      firmwareVersion: '1.0.0',
      signalStrength: null,
      networkType: null,
      consumables: [],
      capabilities: {
        schemaVersion: '1.0',
        commands: [
          { command: 'START', allowed: false, denyReason: 'DEVICE_OFFLINE' },
          { command: 'STOP', allowed: false, denyReason: 'DEVICE_OFFLINE' },
          { command: 'REBOOT', allowed: false, denyReason: 'DEVICE_OFFLINE' },
        ],
        ota: { allowed: false, denyReason: 'OTA_ENTITLEMENT_REQUIRED' },
      },
    },
  ],
};

const p0Device = {
  id: 'dev-p0',
  serialNumber: 'SN-P0',
  model: 'FD-100',
  hardwareVersion: 'HW-1',
  manufacturer: 'BioNexa',
  manufactureDate: '2026-09-01',
  alias: 'P0 设备',
  firmwareVersion: '1.0.0',
  customer: { id: 'cust-a', name: '租户 A' },
  site: { id: 'site-a', name: '上海站点', region: 'CN', subregion: 'SH' },
  lifecycleStatus: 'Active',
  operationalStatus: 'Active',
  connectivity: 'ONLINE',
  lastHeartbeatAt: '2026-09-10T00:00:00Z',
  certificate: { certificateId: 'cert-1', fingerprint: 'AA:BB', status: 'ACTIVE' },
  license: null,
  contract: null,
  retirement: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-10T00:00:00Z',
};

const p0Console = {
  generatedAt: '2026-09-10T00:00:00Z',
  device: {
    deviceId: 'dev-p0',
    serialNumber: 'SN-P0',
    alias: 'P0 设备',
    model: 'FD-100',
    lifecycleStatus: 'Active',
    operationalStatus: 'Active',
    connectivity: 'ONLINE',
    licenseStatus: null,
    firmwareVersion: '1.0.0',
  },
  components: {
    observedAt: '2026-09-10T00:00:00Z',
    stale: false,
    status: { overall: 'NORMAL', motor: null, heater: null, shredder: null, deodorizer: null },
  },
  metrics: { observedAt: '2026-09-10T00:00:00Z', stale: false, metrics: {} },
  network: {
    observedAt: '2026-09-10T00:00:00Z',
    stale: false,
    networkType: 'WIFI',
    signalStrength: -40,
    networkStatus: 'CONNECTED',
  },
  consumables: [],
  recentAlarms: [],
  esgLast7Days: [],
  contract: null,
  latestMedia: { mediaId: 'media-p1', mediaType: 'IMAGE', captureTime: '2026-09-10T00:00:00Z' },
};

const p1License = {
  licenseId: 'license-p1',
  deviceId: 'dev-p0',
  customerId: 'cust-a',
  status: 'Revoked',
  validFrom: '2026-01-01',
  validTo: '2026-08-31',
  entitlements: [{ code: 'OTA', enabled: false }],
  signature: 'v1.signature',
  version: 4,
  effective: false,
  createdBy: 'admin',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const p0Alarm = {
  alarmId: 'alarm-p0',
  customerId: 'cust-a',
  siteId: 'site-a',
  deviceId: 'dev-p0',
  severity: 'CRITICAL',
  status: 'ACTIVE',
  code: 'TEMP_HIGH',
  category: 'TEMPERATURE',
  message: '温度过高',
  detectedTime: '2026-09-10T00:00:00Z',
  component: 'heater',
  currentValue: 91,
  threshold: 80,
  unit: '°C',
  recommendedAction: '检查设备',
  acknowledgedBy: null,
  acknowledgedAt: null,
  acknowledgeReason: null,
  clearedBy: null,
  clearedAt: null,
  clearReason: null,
};

async function routeP0Apis(page: Page, options: { alarmRows?: boolean } = {}) {
  await page.route('**/api/v1/admin/customers**', (route) =>
    json(route, {
      data: [
        {
          id: 'cust-a',
          name: '租户 A',
          status: 'ACTIVE',
          version: 1,
          createdAt: '2026-09-10T00:00:00Z',
          updatedAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  await page.route('**/api/v1/admin/sites**', (route) =>
    json(route, {
      data: [
        {
          id: 'site-a',
          customerId: 'cust-a',
          name: '上海站点',
          status: 'ACTIVE',
          region: 'CN',
          subregion: 'SH',
          address: null,
          timezone: 'Asia/Shanghai',
          contactName: null,
          contactPhone: null,
          contactEmail: null,
          deviceCount: 1,
          version: 1,
          createdAt: '2026-09-10T00:00:00Z',
          updatedAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  await page.route('**/api/v1/admin/devices**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/console')) return json(route, { data: p0Console, meta: {} });
    if (path.endsWith('/activities'))
      return json(route, {
        data: [
          {
            activityId: 'activity-p1',
            kind: 'EVENT',
            level: 'INFO',
            occurredAt: '2026-09-10T00:00:00Z',
            summary: 'SYNC',
            detail: {},
          },
        ],
        meta: { nextCursor: null },
      });
    if (path.endsWith('/assignments')) return json(route, { data: [], meta: {} });
    if (path.endsWith('/dev-p0')) return json(route, { data: p0Device, meta: {} });
    const nextCursor = url.searchParams.get('limit') === '50' && !url.searchParams.has('cursor') ? 'p0-next' : null;
    return json(route, {
      data: nextCursor === null && url.searchParams.has('cursor') ? [] : [p0Device],
      meta: { nextCursor },
    });
  });
  await page.route('**/api/v1/admin/media/media-p1/download-url', (route) =>
    json(route, {
      data: {
        mediaId: 'media-p1',
        downloadUrl: 'https://media.example.test/latest.png',
        downloadUrlExpiresAt: '2026-09-10T00:15:00Z',
      },
      meta: {},
    }),
  );
  await page.route('https://media.example.test/latest.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgo=', 'base64') }),
  );
  await page.route('**/api/v1/admin/licenses**', (route) => {
    const url = new URL(route.request().url());
    const nextCursor = !url.searchParams.has('cursor') ? 'p1-next' : null;
    return json(route, { data: nextCursor ? [p1License] : [], meta: { nextCursor } });
  });
  await page.route('**/api/v1/admin/configurations**', (route) => json(route, { data: [], meta: {} }));
  await page.route('**/api/v1/admin/device-users**', (route) => json(route, { data: [], meta: {} }));
  await page.route('**/api/v1/admin/events**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/tamper-events**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/alarms**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/acknowledge')) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return json(route, { data: { alarm: { ...p0Alarm, status: 'ACKNOWLEDGED' }, replayed: false }, meta: {} });
    }
    if (path.endsWith('/alarm-p0')) return json(route, { data: p0Alarm, meta: {} });
    return json(route, { data: options.alarmRows ? [p0Alarm] : [], meta: { nextCursor: null } });
  });
}

async function routeFe11To15Apis(page: Page) {
  await routeP0Apis(page);
  const operableDevice = {
    ...p0Device,
    license: {
      licenseId: 'license-fe12',
      status: 'Active',
      validFrom: '2026-01-01',
      validTo: '2027-01-01',
      entitlements: ['REMOTE_CONTROL', 'OTA_UPDATE'],
    },
  };
  await page.route('**/api/v1/admin/devices**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/console')) return json(route, { data: p0Console });
    if (path.endsWith('/dev-p0')) return json(route, { data: operableDevice });
    return json(route, { data: [operableDevice], meta: { nextCursor: null } });
  });
  await page.route('**/api/v1/admin/esg/calculation-versions', (route) => json(route, { data: [] }));
  await page.route('**/api/v1/admin/esg/daily-summary**', (route) =>
    json(route, { data: [], meta: { nextCursor: null } }),
  );
  await page.route('**/api/v1/admin/esg/reports**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/esg/exports**', (route) =>
    json(route, {
      data: {
        exportId: 'export-fe11',
        dataset: 'DAILY_SUMMARY',
        status: 'COMPLETED',
        filters: {},
        rowCount: 0,
        downloadUrl: 'https://exports.example.test/esg.csv',
        urlExpiresAt: '2099-09-10T00:15:00Z',
        urlExpired: false,
        error: null,
        requestedBy: 'e2e-PlatformSuperAdmin',
        createdAt: '2026-09-10T00:00:00Z',
        completedAt: '2026-09-10T00:00:01Z',
      },
    }),
  );
  const command = {
    commandId: 'cmd-fe12',
    deviceId: 'dev-p0',
    customerId: 'cust-a',
    command: 'REBOOT',
    category: 'DEVICE',
    highRisk: false,
    status: 'SUCCEEDED',
    requestedBy: 'e2e-PlatformSuperAdmin',
    requestTime: '2026-09-10T00:00:00Z',
    timeoutSec: 300,
    expiresAt: '2026-09-10T00:05:00Z',
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:02Z',
  };
  await page.route('**/api/v1/admin/commands**', (route) =>
    json(route, { data: [command], meta: { nextCursor: null } }),
  );
  await page.route('**/api/v1/admin/devices/dev-p0/commands', (route) =>
    json(route, { data: { ...command, status: 'AUTHORIZED', replayed: false } }, 201),
  );
  await page.route('**/api/v1/admin/devices/dev-p0/activities**', (route) =>
    json(route, { data: [], meta: { nextCursor: null } }),
  );
  await page.route('**/api/v1/admin/ota/packages**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/upload-sessions'))
      return json(route, {
        data: {
          packageId: 'pkg-fe13',
          status: 'UPLOADED',
          model: 'FD-100',
          version: '2.0.0',
          packageType: 'FIRMWARE',
          sizeBytes: 4,
          sha256: 'a'.repeat(64),
          objectKey: 'firmware/pkg-fe13.bin',
          uploadUrl: 'https://uploads.example.test/pkg-fe13',
          uploadUrlExpiresAt: '2099-09-10T00:15:00Z',
          createdAt: '2026-09-10T00:00:00Z',
        },
      });
    if (path.endsWith('/pkg-fe13/complete'))
      return json(route, {
        data: {
          packageId: 'pkg-fe13',
          model: 'FD-100',
          version: '2.0.0',
          packageType: 'FIRMWARE',
          sizeBytes: 4,
          sha256: 'a'.repeat(64),
          status: 'VERIFIED',
          objectKey: 'firmware/pkg-fe13.bin',
          uploadedBy: 'e2e-PlatformSuperAdmin',
          createdAt: '2026-09-10T00:00:00Z',
        },
      });
    return json(route, {
      data: [
        {
          packageId: 'pkg-verified',
          model: 'FD-100',
          version: '1.9.0',
          packageType: 'FIRMWARE',
          sizeBytes: 4,
          sha256: 'b'.repeat(64),
          status: 'VERIFIED',
          objectKey: 'firmware/pkg-verified.bin',
          uploadedBy: 'operator-1',
          createdAt: '2026-09-09T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    });
  });
  await page.route('https://uploads.example.test/pkg-fe13', (route) => route.fulfill({ status: 200, body: '' }));
  const campaign = {
    campaignId: 'campaign-fe13',
    name: 'E2E 灰度',
    packageId: 'pkg-verified',
    targetModel: 'FD-100',
    strategy: 'CANARY',
    status: 'RUNNING',
    createdBy: 'e2e-PlatformSuperAdmin',
    finalRolloutApprovedAt: null,
    finalRolloutApprovedBy: null,
    finalRolloutEligibleCount: null,
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  };
  await page.route('**/api/v1/admin/ota/campaigns**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/targets')) return json(route, { data: [], meta: { nextCursor: null } });
    if (path.endsWith('/campaign-fe13'))
      return json(route, {
        data: {
          ...campaign,
          targetCounts: {
            total: 1,
            PENDING: 1,
            NOTIFIED: 0,
            DOWNLOADING: 0,
            INSTALLING: 0,
            SUCCEEDED: 0,
            FAILED: 0,
            ROLLED_BACK: 0,
            CANCELLED: 0,
          },
        },
      });
    if (route.request().method() === 'POST') return json(route, { data: campaign }, 201);
    return json(route, { data: [campaign], meta: { nextCursor: null } });
  });
  await page.route('**/api/v1/admin/media**', (route) =>
    json(route, {
      data: [
        {
          mediaId: 'media-fe14',
          deviceId: 'dev-p0',
          customerId: 'cust-a',
          mediaType: 'IMAGE',
          captureTime: '2026-09-10T00:00:00Z',
          fileName: 'capture.png',
          sizeKb: 12,
          durationSec: 0,
          status: 'AVAILABLE',
          createdAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  await page.route('**/api/v1/admin/media/media-fe14/download-url', (route) =>
    json(route, {
      data: {
        mediaId: 'media-fe14',
        downloadUrl: 'https://media.example.test/fe14.png',
        downloadUrlExpiresAt: '2099-09-10T00:15:00Z',
      },
    }),
  );
  const auditLog = {
    auditId: 'audit-fe15',
    actorId: 'operator-1',
    actorRole: 'PlatformOperator',
    customerId: 'cust-a',
    objectType: 'Device',
    objectId: 'dev-p0',
    action: 'COMMAND_CREATED',
    result: 'SUCCESS',
    createdAt: '2026-09-10T00:00:00Z',
  };
  await page.route('**/api/v1/admin/audit-logs**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/audit-fe15'))
      return json(route, {
        data: {
          ...auditLog,
          reason: null,
          requestId: 'req-fe15',
          ip: '127.0.0.1',
          userAgent: 'playwright',
          beforeValue: { token: 'must-redact' },
          afterValue: { status: 'AUTHORIZED' },
        },
      });
    return json(route, { data: [auditLog], meta: { nextCursor: null } });
  });
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('无 Token 安全回登录；五角色菜单和受限路由均由组合根守卫', async ({ browser }) => {
  const anonymous = await browser.newPage();
  await anonymous.goto('/customers');
  await expect(anonymous).toHaveURL(/\/login\?returnTo=/);
  await expect(anonymous.getByRole('heading', { name: '厨余机云平台' })).toBeVisible();
  await anonymous.close();

  const cases: { role: Role; visible: string; forbidden: string }[] = [
    { role: 'PlatformSuperAdmin', visible: '客户管理', forbidden: '/not-a-route' },
    { role: 'PlatformOperator', visible: '客户管理', forbidden: '/settings' },
    { role: 'Auditor', visible: '客户管理', forbidden: '/settings' },
    { role: 'CustomerAdmin', visible: '用户管理', forbidden: '/customers' },
    { role: 'CustomerViewer', visible: '站点管理', forbidden: '/customers' },
  ];
  for (const item of cases) {
    const page = await browser.newPage();
    await seedSession(page, item.role);
    await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard, meta: {} }));
    await page.goto('/dashboard');
    await expect(page.getByText(item.visible, { exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('redacted-refresh-token');
    await page.goto(item.forbidden);
    if (item.forbidden === '/not-a-route') await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    else await expect(page.getByRole('heading', { name: '403' })).toBeVisible();
    await page.close();
  }
});

test('刷新失败清会话，API 403 保留会话并呈现无权', async ({ browser }) => {
  const expiredPage = await browser.newPage();
  await seedSession(expiredPage, 'PlatformSuperAdmin', { expired: true });
  await expiredPage.route('https://cognito-idp.us-east-1.amazonaws.com/', (route) =>
    json(route, { __type: 'NotAuthorizedException' }, 400),
  );
  await expiredPage.goto('/dashboard');
  await expect(expiredPage).toHaveURL(/\/login/);
  expect(await expiredPage.evaluate(() => sessionStorage.getItem('fdp.admin.session.v1'))).toBeNull();
  await expiredPage.close();

  const forbiddenPage = await browser.newPage();
  await seedSession(forbiddenPage, 'PlatformSuperAdmin');
  await forbiddenPage.route('**/api/v1/admin/dashboard/overview', (route) =>
    json(route, { error: { code: 'FORBIDDEN', message: 'denied', requestId: 'req-403' } }, 403),
  );
  await forbiddenPage.goto('/dashboard');
  await expect(forbiddenPage.getByTestId('error-forbidden')).toContainText('无权访问');
  expect(await forbiddenPage.evaluate(() => sessionStorage.getItem('fdp.admin.session.v1'))).not.toBeNull();
  await forbiddenPage.close();
});

test('Customer scope 与 Dashboard 离线/无 entitlement 动作在真实浏览器失败关闭', async ({ page }) => {
  await seedSession(page, 'CustomerViewer', { customerId: 'cust-a' });
  await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard, meta: {} }));
  await page.route('**/api/v1/admin/sites**', (route) =>
    json(route, {
      data: [
        {
          id: 'site-a',
          customerId: 'cust-a',
          name: 'A 租户站点',
          region: null,
          subregion: null,
          address: null,
          timezone: 'Asia/Shanghai',
          contactName: null,
          contactPhone: null,
          contactEmail: null,
          status: 'ACTIVE',
          deviceCount: 0,
          version: 1,
          createdAt: '2026-09-10T00:00:00Z',
          updatedAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  await page.goto('/dashboard');
  await expect(page.getByTestId('action-START-dev-offline')).toBeDisabled();
  await expect(page.getByTestId('deny-START-dev-offline')).toContainText('设备离线');
  await expect(page.getByTestId('action-upgrade-dev-offline')).toBeDisabled();
  await page.goto('/sites');
  await expect(page.getByText('A 租户站点')).toBeVisible();
  await expect(page.getByTestId('create-site')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('cust-b');
});

test('Onboarding 审批双击只提交一次，展示录入来源和证书状态', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  const request = {
    requestId: 'onb-1',
    serialNumber: 'SN-1',
    submittedBy: 'DEVICE:SN-1',
    model: 'FD-100',
    hardwareVersion: 'HW-1',
    manufacturer: 'BioNexa',
    manufactureDate: '2026-09-01',
    status: 'PENDING',
    rejectReason: null,
    reviewedBy: null,
    reviewedAt: null,
    version: 1,
    createdAt: '2026-09-10T00:00:00Z',
    certificateProvisioningStatus: 'NOT_STARTED',
  };
  let approvals = 0;
  await page.route('**/api/v1/admin/devices**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await page.route('**/api/v1/admin/onboarding/requests**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/approve')) {
      approvals += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return json(route, {
        data: { ...request, status: 'APPROVED', version: 2, certificateProvisioningStatus: 'QUEUED' },
        meta: {},
      });
    }
    if (url.includes('?')) return json(route, { data: [request], meta: { nextCursor: null } });
    return json(route, { data: request, meta: {} });
  });
  await page.goto('/devices/groups');
  await page.getByTestId('detail-onb-1').click();
  await expect(page.getByTestId('detail-submitted-by')).toHaveText('DEVICE:SN-1');
  await expect(page.getByTestId('detail-certificate-status')).toHaveText('NOT_STARTED');
  await page.getByTestId('approve-button').click();
  await page.getByRole('button', { name: '确认批准' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => approvals).toBe(1);
});

test('Customer/Site CRUD 关键路径：创建、非法时区、关联停用提示与 409', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  const customer = {
    id: 'cust-a',
    name: '租户 A',
    status: 'ACTIVE',
    version: 1,
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  };
  let customers = [customer];
  await page.route('**/api/v1/admin/customers**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/deactivate')) {
      const updated = { ...customers.find((item) => item.id === 'cust-new')!, status: 'SUSPENDED', version: 3 };
      customers = customers.map((item) => (item.id === updated.id ? updated : item));
      return json(route, { data: updated, meta: {} });
    }
    if (route.request().method() === 'PATCH') {
      const updated = {
        ...customers.find((item) => item.id === 'cust-new')!,
        name: '新客户（已更新）',
        version: 2,
      };
      customers = customers.map((item) => (item.id === updated.id ? updated : item));
      return json(route, { data: updated, meta: {} });
    }
    if (route.request().method() === 'POST') {
      const created = { ...customer, id: 'cust-new', name: '新客户' };
      customers = [...customers, created];
      return json(route, { data: created, meta: {} }, 201);
    }
    return json(route, { data: customers, meta: { nextCursor: null } });
  });
  const site = {
    id: 'site-a',
    customerId: 'cust-a',
    name: '有关联设备站点',
    region: 'CN',
    subregion: 'SH',
    address: null,
    timezone: 'Asia/Shanghai',
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    status: 'ACTIVE',
    deviceCount: 3,
    version: 1,
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
  };
  let sites = [site];
  let siteCreates = 0;
  await page.route('**/api/v1/admin/sites**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/deactivate')) {
      const updated = { ...sites.find((item) => item.id === 'site-a')!, status: 'SUSPENDED', version: 3 };
      sites = sites.map((item) => (item.id === updated.id ? updated : item));
      return json(route, { data: updated, meta: {} });
    }
    if (route.request().method() === 'PATCH') {
      const updated = { ...sites.find((item) => item.id === 'site-new')!, name: '新站点（已更新）', version: 2 };
      sites = sites.map((item) => (item.id === updated.id ? updated : item));
      return json(route, { data: updated, meta: {} });
    }
    if (route.request().method() === 'POST') {
      siteCreates += 1;
      if (siteCreates > 1) {
        return json(route, { error: { code: 'CONFLICT', message: 'Site already exists', requestId: 'req-409' } }, 409);
      }
      const created = { ...site, id: 'site-new', name: '冲突站点', deviceCount: 0 };
      sites = [...sites, created];
      return json(route, { data: created, meta: {} }, 201);
    }
    return json(route, { data: sites, meta: { nextCursor: null } });
  });

  await page.goto('/customers');
  await page.getByTestId('create-customer').click();
  await page.getByLabel('客户名称').fill('新客户');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('cell', { name: '新客户' })).toBeVisible();
  await page.getByTestId('edit-customer').click();
  await page.getByLabel('客户名称').fill('新客户（已更新）');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('customer-detail')).toContainText('新客户（已更新）');
  await page.getByTestId('deactivate-customer').click();
  await page.getByLabel('停用原因').fill('E2E deactivation');
  await page.getByRole('button', { name: '确认停用' }).click();
  await expect(page.getByTestId('customer-status')).toHaveText('已停用');

  await page.goto('/sites');
  await page.getByTestId('create-site').click();
  const siteForm = page.getByTestId('site-form');
  await siteForm.getByLabel('所属客户').selectOption('cust-a');
  await siteForm.getByLabel('站点名称').fill('冲突站点');
  await siteForm.getByLabel('时区（IANA）').fill('Mars/Olympus');
  await siteForm.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('error-timezone')).toBeVisible();
  await siteForm.getByLabel('时区（IANA）').fill('Asia/Shanghai');
  await siteForm.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('site-detail')).toContainText('冲突站点');
  await page.getByTestId('edit-site').click();
  const editSiteForm = page.getByTestId('site-form');
  await editSiteForm.getByLabel('站点名称').fill('新站点（已更新）');
  await editSiteForm.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('site-detail')).toContainText('新站点（已更新）');
  await page.getByTestId('site-detail').getByRole('button', { name: '关闭' }).click();
  await page.getByTestId('detail-site-a').click();
  await page.getByTestId('deactivate-site').click();
  await expect(page.getByRole('dialog')).toContainText('关联设备 3 台');
  await page.getByLabel('停用原因').fill('linked device review complete');
  await page.getByRole('button', { name: '确认停用' }).click();
  await expect(page.getByTestId('site-status')).toHaveText('已停用');

  await page.getByTestId('create-site').click();
  const conflictingSiteForm = page.getByTestId('site-form');
  await conflictingSiteForm.getByLabel('所属客户').selectOption('cust-a');
  await conflictingSiteForm.getByLabel('站点名称').fill('重复站点');
  await conflictingSiteForm.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('Site already exists')).toBeVisible();
});

test('1440/768/375 响应式布局、横向表格和对话框键盘边界', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  const responsiveDashboard = {
    ...dashboard,
    deviceCards: [
      {
        ...dashboard.deviceCards[0],
        deviceId: 'dev-responsive',
        serialNumber: 'SN-RESPONSIVE',
        connectivity: 'ONLINE',
        capabilities: {
          ...dashboard.deviceCards[0].capabilities,
          commands: dashboard.deviceCards[0].capabilities.commands.map((item) => ({
            ...item,
            allowed: item.command === 'START',
            denyReason: item.command === 'START' ? null : item.denyReason,
          })),
        },
      },
    ],
  };
  await page.route('**/api/v1/admin/dashboard/overview', (route) =>
    json(route, { data: responsiveDashboard, meta: {} }),
  );
  await page.route('**/api/v1/admin/customers**', (route) =>
    json(route, {
      data: [
        {
          id: 'responsive-customer',
          name: '响应式布局验证客户',
          status: 'ACTIVE',
          version: 1,
          createdAt: '2026-09-10T00:00:00Z',
          updatedAt: '2026-09-10T00:00:00Z',
        },
      ],
      meta: { nextCursor: null },
    }),
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');
  await expect(page.getByTestId('sidebar')).toBeInViewport();
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId('dashboard-baseline')).toContainText('08:00:00');
  await page.getByLabel('显示时区').selectOption('UTC');
  await expect(page.getByTestId('dashboard-baseline')).toContainText('00:00:00');
  expect(await page.evaluate(() => localStorage.getItem('fdp.admin.time-zone.v1'))).toBe('UTC');
  const desktopCards = await page.locator('.stats-grid .stat-card').count();
  expect(desktopCards).toBeGreaterThan(1);

  await page.setViewportSize({ width: 768, height: 900 });
  await expect.poll(async () => (await page.getByTestId('sidebar').boundingBox())?.x ?? 0).toBeLessThan(-200);
  await page.getByTestId('drawer-open').click();
  await expect(page.getByTestId('sidebar')).toHaveClass(/open/);
  await expect
    .poll(async () => (await page.getByTestId('sidebar').boundingBox())?.x ?? -240)
    .toBeGreaterThanOrEqual(-1);
  await page.getByTestId('drawer-overlay').click({ position: { x: 700, y: 400 } });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/customers');
  const table = page.getByTestId('cursor-table');
  await expect(table).toBeVisible();
  expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto('/dashboard');
  await page.getByTestId('action-START-dev-responsive').click();
  const dialog = page.getByRole('dialog', { name: '确认启动' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
  expect(
    await page.locator('#root').evaluate((root) => root.inert && root.getAttribute('aria-hidden') === 'true'),
  ).toBe(true);
  await expect(page.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '确认下发' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '取消' })).toBeFocused();
});

test('FE-06 至 FE-10 六个生产路由可运行，并覆盖成功、空态、分页入口、时区与响应式', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeP0Apis(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/devices/view?deviceId=dev-p0');
  await expect(page.getByTestId('device-view-page')).toBeVisible();
  await expect(page.getByTestId('device-console')).toContainText('P0 设备');
  await expect(page.getByTestId('media-image')).toHaveAttribute('src', 'https://media.example.test/latest.png');
  await expect(page.getByTestId('activity-activity-p1')).toContainText('SYNC');
  await expect(page.getByTestId('device-console')).toContainText('08:00:00');
  await page.getByLabel('显示时区').selectOption('UTC');
  await expect(page.getByTestId('device-console')).toContainText('00:00:00');

  await page.goto('/devices/manage?deviceId=dev-p0');
  await expect(page.getByTestId('device-manage-page')).toContainText('P0 设备');

  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/licenses');
  await expect(page.getByTestId('licenses-page')).toBeVisible();
  await expect(page.getByRole('button', { name: '下一页' })).toBeEnabled();
  const nextPage = page.waitForRequest((request) => request.url().includes('cursor=p1-next'));
  await page.getByRole('button', { name: '下一页' }).click();
  await nextPage;
  await expect(page.getByTestId('table-empty')).toBeVisible();

  await page.goto('/configurations');
  await expect(page.getByTestId('configurations-page')).toBeVisible();
  await expect(page.getByTestId('config-empty')).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/device-users');
  await expect(page.getByTestId('device-users-page')).toBeVisible();
  await expect(page.getByText('暂无设备用户')).toBeVisible();
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto('/alarms?tab=event');
  await expect(page.getByTestId('alarms-page')).toBeVisible();
  await expect(page.getByTestId('tab-event')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('table-empty')).toBeVisible();
});

test('FE-06 至 FE-10 在 403/404、Customer scope、详情焦点与重复提交场景失败关闭', async ({ browser }) => {
  const forbidden = await browser.newPage();
  await seedSession(forbidden, 'PlatformSuperAdmin');
  await forbidden.route('**/api/v1/admin/devices**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/console') || path.endsWith('/dev-p0'))
      return json(route, { error: { code: 'FORBIDDEN', message: 'denied', requestId: 'req-p0-403' } }, 403);
    return json(route, { data: [p0Device], meta: { nextCursor: null } });
  });
  await forbidden.goto('/devices/view?deviceId=dev-p0');
  await expect(forbidden.getByTestId('error-forbidden')).toContainText('无权访问');
  await forbidden.close();

  const missing = await browser.newPage();
  await seedSession(missing, 'PlatformSuperAdmin');
  await missing.route('**/api/v1/admin/customers**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await missing.route('**/api/v1/admin/sites**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  await missing.route('**/api/v1/admin/devices/**', (route) =>
    json(route, { error: { code: 'NOT_FOUND', message: 'device missing', requestId: 'req-p0-404' } }, 404),
  );
  await missing.goto('/devices/manage?deviceId=missing');
  await expect(missing.getByText('device missing')).toBeVisible();
  await missing.close();

  const customer = await browser.newPage();
  await seedSession(customer, 'CustomerViewer', { customerId: 'cust-a' });
  let scopedAlarmRequest = false;
  await routeP0Apis(customer);
  await customer.route('**/api/v1/admin/alarms**', (route) => {
    scopedAlarmRequest = new URL(route.request().url()).searchParams.get('customerId') === 'cust-a';
    return json(route, { data: [], meta: { nextCursor: null } });
  });
  await customer.goto('/alarms');
  await expect(customer.getByTestId('alarms-page')).toBeVisible();
  await expect.poll(() => scopedAlarmRequest).toBe(true);
  await expect(customer.getByTestId('filter-customer')).toHaveCount(0);
  await customer.goto('/configurations');
  await expect(customer.getByRole('heading', { name: '403' })).toBeVisible();
  await customer.close();

  const action = await browser.newPage();
  await seedSession(action, 'PlatformSuperAdmin');
  let acknowledgements = 0;
  await routeP0Apis(action, { alarmRows: true });
  await action.route('**/api/v1/admin/alarms/alarm-p0/acknowledge', async (route) => {
    acknowledgements += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return json(route, { data: { alarm: { ...p0Alarm, status: 'ACKNOWLEDGED' }, replayed: false }, meta: {} });
  });
  await action.goto('/alarms');
  const criticalRow = action.getByTestId('severity-alarm-p0').locator('xpath=ancestor::tr');
  await expect(criticalRow).toHaveClass(/severity-critical/);
  expect(await criticalRow.evaluate((row) => getComputedStyle(row.querySelector('td')!).backgroundColor)).toBe(
    'rgb(254, 243, 242)',
  );
  await action.getByTestId('filter-severity').selectOption('CRITICAL');
  await action.getByTestId('filter-search').click();
  await expect(action).toHaveURL(/severity=CRITICAL/);
  await action.goBack();
  await expect(action).not.toHaveURL(/severity=CRITICAL/);
  await action.goForward();
  await expect(action).toHaveURL(/severity=CRITICAL/);
  await action.getByTestId('alarm-detail-alarm-p0').click();
  await action.getByTestId('alarm-acknowledge').click();
  await expect(action.getByRole('dialog', { name: '确认告警' })).toBeVisible();
  await expect(action.getByLabel('确认原因')).toBeFocused();
  await action.getByLabel('确认原因').fill('P0 E2E');
  await action.getByRole('button', { name: '确认告警' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => acknowledgements).toBe(1);
  await action.close();
});

test('FE-11 至 FE-15 七个生产路由由真实控制器驱动，并覆盖媒体签发与审计详情', async ({ page }) => {
  await seedSession(page, 'PlatformSuperAdmin');
  await routeFe11To15Apis(page);

  const routes = [
    ['/esg/overview', 'esg-overview-page'],
    ['/esg/devices', 'esg-devices-page'],
    ['/devices/operate?deviceId=dev-p0', 'device-operate-page'],
    ['/ota/campaigns', 'ota-campaigns-page'],
    ['/ota/packages', 'ota-packages-page'],
    ['/media', 'media-page'],
    ['/audit-logs', 'audit-logs-page'],
  ] as const;
  for (const [path, testId] of routes) {
    await page.goto(path);
    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.locator('body')).not.toContainText('该页面尚未接入当前管理后台组合根');
  }

  await page.goto('/esg/overview');
  await page.getByTestId('esg-export-csv').click();
  await expect(page.getByTestId('esg-export-download')).toHaveAttribute('href', 'https://exports.example.test/esg.csv');

  await page.goto('/devices/operate?deviceId=dev-p0');
  await expect(page.getByTestId('quick-reboot')).toBeEnabled();
  await page.getByTestId('quick-reboot').click();
  await page.getByTestId('command-submit').click();
  await expect(page.getByTestId('action-notice')).toContainText('已受理');

  await page.goto('/ota/campaigns');
  await expect(page.getByTestId('campaign-create-open')).toBeEnabled();
  await page.getByTestId('campaign-create-open').click();
  await page.getByTestId('campaign-name').fill('E2E 灰度');
  await page.getByTestId('campaign-package').selectOption('pkg-verified');
  await page.getByTestId('campaign-device').selectOption('dev-p0');
  await page.getByTestId('campaign-create-submit').click();
  await expect(page.getByTestId('action-notice')).toContainText('首批 1 台进入灰度');

  await page.goto('/media');
  await page.getByTestId('media-open-media-fe14').click();
  await expect(page.getByTestId('media-preview-image')).toHaveAttribute('src', 'https://media.example.test/fe14.png');

  await page.goto('/ota/packages');
  await page.getByTestId('upload-session-open').click();
  const uploadForm = page.getByTestId('upload-form');
  await uploadForm.getByTestId('upload-model').fill('FD-100');
  await uploadForm.getByTestId('upload-version').fill('2.0.0');
  await uploadForm.getByTestId('upload-size').fill('4');
  await uploadForm.getByTestId('upload-sha256').fill('a'.repeat(64));
  await uploadForm.getByTestId('upload-signature').fill('signed-e2e');
  await uploadForm.getByTestId('upload-session-submit').click();
  await page
    .getByTestId('upload-file')
    .setInputFiles({ name: 'firmware.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('FDP!') });
  await page.getByTestId('upload-complete-submit').click();
  await expect(page.getByTestId('verified-result')).toContainText('可发布');

  await page.goto('/audit-logs');
  await page.getByTestId('audit-detail-audit-fe15').click();
  await expect(page.getByTestId('audit-detail-request-id')).toHaveText('req-fe15');
  await expect(page.getByTestId('audit-detail-before')).toContainText('[REDACTED]');
  await expect(page.locator('body')).not.toContainText('must-redact');
});

test('FE-11 至 FE-15 API 403 与路由角色边界在真实浏览器失败关闭', async ({ browser }) => {
  const denied = await browser.newPage();
  await seedSession(denied, 'PlatformSuperAdmin');
  await denied.route('**/api/v1/admin/media**', (route) =>
    json(route, { error: { code: 'FORBIDDEN', message: 'denied', requestId: 'req-fe14-403' } }, 403),
  );
  await denied.goto('/media');
  await expect(denied.getByTestId('error-forbidden')).toContainText('无权访问');
  await denied.close();

  const customer = await browser.newPage();
  await seedSession(customer, 'CustomerAdmin', { customerId: 'cust-a' });
  await customer.goto('/audit-logs');
  await expect(customer.getByRole('heading', { name: '403' })).toBeVisible();
  await customer.close();
});
