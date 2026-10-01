import type { Page, Route } from '@playwright/test';

export type Role = 'PlatformSuperAdmin' | 'PlatformOperator' | 'Auditor' | 'CustomerAdmin' | 'CustomerViewer';

export function jwt(expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.signature`;
}

export async function seedSession(page: Page, role: Role, options: { expired?: boolean; customerId?: string } = {}) {
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

/** FE-19：禁止由 overflow:hidden 掩盖正文裁切，同时保留 CursorTable 的显式横向滚动边界。 */
export async function layoutViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const violations: string[] = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      violations.push(`document:${document.documentElement.scrollWidth}>${document.documentElement.clientWidth}`);
    }
    for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const hasDirectText = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent?.trim().length ?? 0) > 0,
      );
      if (!hasDirectText) continue;
      const clipsX = ['hidden', 'clip'].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
      const clipsY = ['hidden', 'clip'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      if (clipsX || clipsY) {
        const identity = element.getAttribute('data-testid') ?? element.id ?? element.className ?? element.tagName;
        violations.push(`${String(identity)}:${element.scrollWidth}x${element.scrollHeight}`);
      }
    }
    return violations;
  });
}

export const section = (requestId = 'req-e2e') => ({
  status: 'READY',
  errorCode: null,
  requestId,
  dataUpdatedAt: '2026-09-10T00:00:00Z',
});

export const dashboard = {
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

export const p0Device = {
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

export const p0Console = {
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

export const p1License = {
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

export const p0Alarm = {
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

export async function routeP0Apis(page: Page, options: { alarmRows?: boolean } = {}) {
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

export async function routeFe11To15Apis(page: Page) {
  await page.route('https://media.example.test/fe14.png', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
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

export async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(structuredClone(body)) });
}
