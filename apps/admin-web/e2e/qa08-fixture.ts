import { randomUUID, randomInt, createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { jwt, p0Device, p0Console, dashboard, json } from './qa05-api-fixtures.js';
export interface Qa08 {
  prefix: string;
  f: any;
  calls: { path: string; method: string; query: Record<string, string>; body: any }[];
  groups: string[];
  absence: string[];
  menus: string[];
  guards: Record<string, boolean>;
  snapshot(page: Page, pageState: string, width: number): Promise<void>;
  snapshotHash?: string;
}
export const test = base.extend<{ qa08: Qa08 }>({
  qa08: [
    async ({ page, context }, use, info) => {
      const prefix = `QA08-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        n = randomInt(101, 899),
        at = '2026-10-01T12:00:00Z';
      const f: any = {
        prefix,
        n,
        at,
        deviceId: `${prefix}-DEV`,
        serial: `${prefix}-SERIAL`,
        alias: `${prefix}-ALIAS`,
        customerId: `${prefix}-CUSTOMER`,
        customer: `${prefix}-CUSTOMER-NAME`,
        siteId: `${prefix}-SITE`,
        region: `${prefix}-R`,
        subregion: `${prefix}-S`,
        contractId: `${prefix}-CONTRACT`,
        contractName: `${prefix}-CONTRACT-NAME`,
        contractNumber: `${prefix}-NUMBER`,
        requestId: `${prefix}-REQUEST`,
        userId: `${prefix}-USER`,
        deviceUserId: `${prefix}-DEVICEUSER`,
        configId: `${prefix}-CONFIG`,
        activity: `${prefix}-ACTIVITY`,
        phone: `555-${n}`,
        firmware: `${n}.2.3`,
      };
      f.contract = {
        contractId: f.contractId,
        contractNumber: f.contractNumber,
        name: f.contractName,
        customerId: f.customerId,
        contact: `${prefix}@example.test`,
        startAt: '2026-01-01T00:00:00Z',
        endAt: '2027-01-01T00:00:00Z',
        status: 'EFFECTIVE',
        derivedStatus: 'EFFECTIVE',
        version: 2,
        createdBy: prefix,
        createdAt: at,
        updatedAt: at,
      };
      f.device = {
        qa08Unknown: `${prefix}-UNMAPPED`,
        ...p0Device,
        id: f.deviceId,
        serialNumber: f.serial,
        alias: f.alias,
        firmwareVersion: f.firmware,
        customer: { id: f.customerId, name: f.customer },
        site: { id: f.siteId, name: f.siteId, region: f.region, subregion: f.subregion },
        license: { licenseId: `${prefix}-LICENSE`, status: 'Active', entitlements: ['REMOTE_CONTROL', 'OTA_UPDATE'] },
        contract: {
          contractId: f.contractId,
          name: f.contractName,
          startAt: f.contract.startAt,
          endAt: f.contract.endAt,
        },
        lastHeartbeatAt: at,
      };
      f.console = {
        ...p0Console,
        generatedAt: at,
        device: { ...p0Console.device, deviceId: f.deviceId, serialNumber: f.serial, alias: f.alias },
        components: {
          observedAt: at,
          stale: false,
          status: { overall: 'NORMAL', temperature: 'NORMAL', humidity: 'NORMAL', weight: 'NORMAL', gas: 'NORMAL' },
        },
        metrics: {
          observedAt: at,
          stale: false,
          metrics: { currentAmp: { avg: n, min: n - 1, max: n + 1, unit: 'A' } },
        },
        consumables: [
          {
            consumableType: 'CARBON_FILTER',
            remainingPercent: 31,
            remainingDisplay: '31%',
            stale: false,
            observedAt: at,
          },
        ],
        recentAlarms: [
          {
            alarmId: `${prefix}-ALARM`,
            severity: 'MAJOR',
            status: 'ACTIVE',
            code: f.activity,
            message: f.activity,
            detectedTime: at,
          },
        ],
        esgLast7Days: [
          { summaryDate: '2026-10-01', carbonReductionKg: n, powerConsumptionKwh: n + 1, feedingWeightKg: n + 2 },
        ],
        latestMedia: { mediaId: `${prefix}-MEDIA`, mediaType: 'IMAGE', captureTime: at },
      };
      f.request = {
        requestId: f.requestId,
        serialNumber: `${prefix}-ONBOARDING`,
        submittedBy: prefix,
        model: 'BNX-QA',
        hardwareVersion: 'HW-QA',
        manufacturer: prefix,
        manufactureDate: '2026-01-01',
        status: 'PENDING',
        rejectReason: null,
        reviewedBy: null,
        reviewedAt: null,
        version: 1,
        createdAt: at,
        certificateProvisioningStatus: 'NOT_STARTED',
      };
      f.user = {
        userId: f.userId,
        username: prefix,
        email: `${prefix}@example.test`,
        displayName: prefix,
        roles: ['PlatformOperator'],
        customerId: null,
        status: 'ACTIVE',
        enabled: true,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      f.deviceUser = {
        deviceUserId: f.deviceUserId,
        username: prefix,
        displayName: prefix,
        customerId: f.customerId,
        status: 'ACTIVE',
        version: 1,
        createdAt: at,
        updatedAt: at,
        activeDeviceCount: 1,
        assignments: [],
        syncStates: [],
      };
      f.config = {
        configurationId: f.configId,
        name: `${prefix}-CONFIG-NAME`,
        targetModel: null,
        targetDeviceId: f.deviceId,
        versionCount: 1,
        latestPublishedVersion: null,
        createdBy: prefix,
        createdAt: at,
        derivedContext: null,
        versions: [
          {
            versionId: `${prefix}-VERSION`,
            configurationId: f.configId,
            version: 1,
            status: 'DRAFT',
            payload: {
              heartbeatInterval: 60,
              telemetryInterval: 10,
              cameraRefreshInterval: 30,
              temperatureThreshold: 60,
            },
            effectiveAt: null,
            changeNote: prefix,
            createdAt: at,
          },
        ],
      };
      const calls: Qa08['calls'] = [],
        unhandled: string[] = [];
      const q: Qa08 = {
        prefix,
        f,
        calls,
        groups: [],
        absence: [],
        menus: [],
        guards: {},
        snapshot: async (current, state, width) => {
          const value = await current.getByTestId('page-content').evaluate((el) => ({
            headings: [...el.querySelectorAll('h1,h2,h3,h4,h5')].map((n) => n.textContent?.trim()),
            columns: [...el.querySelectorAll('th')].map((n) => n.textContent?.trim()),
            buttons: [...el.querySelectorAll('button')].map((n) => ({
              id: n.getAttribute('data-testid'),
              name: n.textContent?.trim(),
              disabled: (n as HTMLButtonElement).disabled,
            })),
            labels: [...el.querySelectorAll('label')].map((n) => n.textContent?.trim()),
            axes: [...el.querySelectorAll('[data-axis]')].map((n) => ({
              axis: n.getAttribute('data-axis'),
              value: n.getAttribute('data-value'),
            })),
          }));
          const canonical = JSON.parse(JSON.stringify(value).replaceAll(prefix, '<fixture>'));
          const path = resolve('e2e/qa08-snapshots', `${state}-${width}.json`),
            body = JSON.stringify(canonical, null, 2) + '\n';
          if (process.env.QA08_UPDATE === '1') writeFileSync(path, body);
          else expect(canonical).toEqual(JSON.parse(readFileSync(path, 'utf8')));
          q.snapshotHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
        },
      };
      await page.addInitScript(
        ({ token, customerId }) => {
          if (sessionStorage.getItem('fdp.admin.session.v1')) return;
          sessionStorage.setItem(
            'fdp.admin.session.v1',
            JSON.stringify({
              username: 'qa08-browser',
              roles: ['PlatformSuperAdmin'],
              customerId,
              accessToken: token,
              idToken: 'redacted-id-token',
              refreshToken: 'redacted-refresh-token',
              expiresInSeconds: 3600,
              obtainedAtMs: Date.now(),
            }),
          );
        },
        { token: jwt(), customerId: f.customerId },
      );
      await page.clock.setFixedTime(new Date(at));
      context.on('page', (p) => p.on('pageerror', (e) => unhandled.push(`pageerror:${e.name}`)));
      page.on('pageerror', (e) => unhandled.push(`pageerror:${e.name}`));
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname,
          method = route.request().method();
        if (url.origin !== 'http://127.0.0.1:4173') {
          unhandled.push(`${method} ${url.hostname}${path}`);
          return route.abort();
        }
        if (!path.startsWith('/api/v1/')) return route.continue();
        const body = route.request().postData() ? route.request().postDataJSON() : null;
        calls.push({ path, method, query: Object.fromEntries(url.searchParams), body });
        const send = (data: any, status = 200) =>
          json(route, { data, meta: { nextCursor: null, requestId: prefix, timestamp: at } }, status);
        if (path.endsWith('/dashboard/overview'))
          return send({
            ...dashboard,
            generatedAt: at,
            contracts: { effectiveTotal: n },
            devices: { total: 10, online: 10, onlineRatePct: 100, licenseDistribution: { Active: 10 } },
            esgToday: { ...dashboard.esgToday, summaryDate: '2026-10-01', carbonReductionKg: n },
            latestAlarms: f.console.recentAlarms.map((a: any) => ({ ...a, deviceId: f.deviceId, code: f.activity })),
            deviceCards: Array.from({ length: 10 }, (_, i) => ({
              ...dashboard.deviceCards[0],
              deviceId: i ? `${f.deviceId}-${i}` : f.deviceId,
              serialNumber: f.serial,
              alias: f.alias,
              connectivity: 'ONLINE',
              capabilities: {
                commands: ['START', 'STOP', 'REBOOT'].map((command) => ({ command, allowed: true, denyReason: null })),
                ota: { allowed: true, denyReason: null },
              },
            })),
          });
        if (path.includes('/onboarding/requests')) {
          if (path.endsWith('/approve')) return send({ ...f.request, status: 'APPROVED' });
          if (path.endsWith('/reject')) return send({ ...f.request, status: 'REJECTED' });
          return send(path.endsWith('/requests') ? [f.request] : f.request);
        }
        if (path.endsWith('/customers'))
          return send([
            { id: f.customerId, name: f.customer, status: 'ACTIVE', version: 1, createdAt: at, updatedAt: at },
          ]);
        if (path.endsWith('/sites'))
          return send([
            {
              id: f.siteId,
              customerId: f.customerId,
              name: f.siteId,
              region: f.region,
              subregion: f.subregion,
              status: 'ACTIVE',
              timezone: 'Asia/Shanghai',
              version: 1,
              deviceCount: 1,
              createdAt: at,
              updatedAt: at,
            },
          ]);
        if (path.startsWith('/api/v1/admin/devices')) {
          if (path.endsWith('/console')) return send(f.console);
          if (path.endsWith('/metadata')) {
            f.device.alias = body.alias;
            return send({ deviceId: f.deviceId, alias: body.alias, updatedAt: at });
          }
          if (path.endsWith('/assignments')) return send([]);
          if (path.endsWith('/certificate-rotation-requests'))
            return send(
              {
                requestId: `${prefix}-ROTATE`,
                deviceId: f.deviceId,
                requestStatus: 'PENDING',
                certificateId: f.device.certificate.certificateId,
                certificateStatus: 'ACTIVE',
                expiryDate: '2027-01-01',
                requestedAt: at,
                requestedBy: prefix,
              },
              201,
            );
          if (path.endsWith('/commands'))
            return send(
              { commandId: `${prefix}-CMD`, status: 'AUTHORIZED', command: body?.command, replayed: false },
              201,
            );
          if (path.endsWith('/activities/export'))
            return send(
              {
                exportId: `${prefix}-EXPORT`,
                dataset: 'ACTIVITIES',
                status: 'COMPLETED',
                rowCount: 1,
                downloadUrl: '/fixture.csv',
                urlExpiresAt: '2027-01-01T00:00:00Z',
                urlExpired: false,
                filters: body,
                createdAt: at,
                requestedBy: prefix,
                completedAt: at,
                error: null,
              },
              202,
            );
          if (path.endsWith('/activities'))
            return send([
              {
                activityId: `${prefix}-ACT`,
                kind: 'EVENT',
                level: 'INFO',
                occurredAt: at,
                summary: f.activity,
                detail: {},
              },
            ]);
          if (path.endsWith(`/${f.deviceId}`)) return send(f.device);
          if (path.endsWith('/devices')) return send([f.device]);
        }
        if (path.includes('/media')) {
          if (path.endsWith('/download-url'))
            return send({
              mediaId: `${prefix}-MEDIA`,
              downloadUrl: '/qa08-image.svg',
              downloadUrlExpiresAt: '2027-01-01T00:00:00Z',
            });
          return send([
            {
              mediaId: `${prefix}-MEDIA`,
              deviceId: f.deviceId,
              mediaType: 'IMAGE',
              captureTime: at,
              status: 'AVAILABLE',
            },
          ]);
        }
        if (path.includes('/configurations')) return send(path.endsWith('/configurations') ? [f.config] : f.config);
        if (path.includes('/commands')) return send([]);
        if (path.includes('/ota/')) return send([]);
        if (path.includes('/esg/')) {
          if (path.endsWith('/calculation-versions')) return send([]);
          if (path.includes('/exports'))
            return send(
              {
                exportId: `${prefix}-EXPORT`,
                dataset: 'DAILY_SUMMARY',
                status: 'COMPLETED',
                filters: body ?? {},
                rowCount: 1,
                downloadUrl: '/fixture.csv',
                urlExpiresAt: '2027-01-01T00:00:00Z',
                urlExpired: false,
                error: null,
                requestedBy: prefix,
                createdAt: at,
                completedAt: at,
              },
              method === 'POST' ? 202 : 200,
            );
          if (path.includes('/daily-summary'))
            return send([
              {
                deviceId: f.deviceId,
                customerId: f.customerId,
                summaryDate: '2026-10-01',
                feedingWeightKg: n + 2,
                dischargeWeightKg: n,
                reductionWeightKg: 2,
                powerConsumptionKwh: n + 1,
                carbonReductionKg: n,
                dataCompletenessPct: 100,
                missingRecordCount: 0,
                calculationVersionId: null,
              },
            ]);
          if (path.includes('/reports'))
            return send([
              {
                reportId: `${prefix}-REPORT`,
                deviceId: f.deviceId,
                customerId: f.customerId,
                reportType: 'DAILY',
                periodStartTime: at,
                periodEndTime: at,
                feedingWeightKg: n + 2,
                dischargeWeightKg: n,
                reductionWeightKg: 2,
                powerConsumptionKwh: n + 1,
                avgO2Pct: 21,
                avgCo2Ppm: n,
                avgCh4Ppm: 1,
                avgN2oPpm: 2,
                carbonReductionKg: n,
                dataCompletenessPct: 100,
                missingRecordCount: 0,
                calculationVersionId: null,
              },
            ]);
        }
        if (path.includes('/consumables')) {
          if (path.endsWith('/contact')) return send({ name: prefix, phone: f.phone, email: `${prefix}@example.test` });
          return send([
            {
              deviceId: f.deviceId,
              serialNumber: f.serial,
              alias: f.alias,
              model: 'BNX-QA',
              lifecycleStatus: 'Active',
              connectivity: 'ONLINE',
              site: { siteId: f.siteId, name: f.siteId, region: f.region, subregion: f.subregion },
              consumables: {
                CARBON_FILTER: { remainingPercent: 31, remainingDisplay: '31%', stale: false, observedAt: at },
                BIO_ADDITIVE: { remainingPercent: null, remainingDisplay: 'unknown', stale: true, observedAt: null },
              },
            },
          ]);
        }
        if (path.includes('/consumable-requests')) {
          const status = path.endsWith('/process')
            ? 'PROCESSING'
            : path.endsWith('/complete')
              ? 'COMPLETED'
              : 'PENDING';
          const item = {
            requestId: f.requestId,
            deviceId: f.deviceId,
            customerId: f.customerId,
            consumableType: 'CARBON_FILTER',
            status,
            source: 'ADMIN',
            requestedBy: prefix,
            requestedAt: at,
            processedBy: null,
            processNote: null,
            completedAt: null,
            version: 1,
            createdAt: at,
            updatedAt: at,
          };
          return send(method === 'GET' ? [item] : item);
        }
        if (path.includes('/contracts')) {
          if (path.endsWith('/associations')) return send([]);
          if (path.endsWith('/devices/bind')) return send({ bound: [f.deviceId] });
          if (path.endsWith('/available-devices'))
            return send([
              {
                deviceId: f.deviceId,
                serialNumber: f.serial,
                model: 'BNX-QA',
                alias: f.alias,
                lifecycleStatus: 'Active',
                site: f.device.site,
              },
            ]);
          if (path.endsWith('/devices'))
            return send(
              method === 'POST'
                ? { deviceIds: [f.deviceId], associations: [] }
                : [
                    {
                      association: {
                        associationId: `${prefix}-ASSOC`,
                        deviceId: f.deviceId,
                        customerId: f.customerId,
                        validFrom: f.contract.startAt,
                        validTo: f.contract.endAt,
                        status: 'ACTIVE',
                        createdAt: at,
                        endedAt: null,
                      },
                      device: { ...f.device, deviceId: f.deviceId, licenseStatus: 'Active' },
                    },
                  ],
            );
          if (path.endsWith('/contracts'))
            return send(
              method === 'POST' ? { ...f.contract, ...body } : [{ ...f.contract, activeDeviceCount: 1 }],
              method === 'POST' ? 201 : 200,
            );
          return send(f.contract);
        }
        if (path.includes('/device-users'))
          return send(path.endsWith('/device-users') && method === 'GET' ? [f.deviceUser] : f.deviceUser);
        if (path.includes('/users')) {
          if (path.endsWith('/password-reset')) return send({ userId: f.userId, status: 'RESET_TRIGGERED' });
          return send(path.endsWith('/users') && method === 'GET' ? [f.user] : f.user);
        }
        if (path.includes('/settings')) return send([]);
        if (path.includes('/licenses')) return send([]);
        unhandled.push(`${method} ${path}`);
        return route.abort();
      });
      await page.route('**/qa08-image.svg', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        }),
      );
      try {
        await use(q);
      } finally {
        await context.close();
      }
      expect(unhandled, 'no unexpected external/API requests or page errors').toEqual([]);
      if (process.env.QA08_TRACE)
        appendFileSync(
          process.env.QA08_TRACE,
          JSON.stringify({
            title: info.title,
            status: info.status,
            prefix,
            cleanup: 'PASS',
            unhandled,
            groups: q.groups,
            absence: q.absence,
            menus: q.menus,
            guards: q.guards,
            snapshotHash: q.snapshotHash,
            viewport: info.title.endsWith('375') ? 375 : 1440,
            calls: calls.map(({ path, method, query }) => ({ path, method, query })),
            updatedSnapshots: process.env.QA08_UPDATE === '1',
          }) + '\n',
        );
    },
    { auto: true },
  ],
});
