import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, routeP0Apis, seedSession } from './qa05-api-fixtures.js';

const configurationId = 'cmp-model-plan';
const time = '2026-09-06T09:00:00Z';
const summary = {
  configurationId,
  name: 'Fixture model plan',
  targetModel: 'CMP-MODEL',
  targetDeviceId: null,
  versionCount: 3,
  latestPublishedVersion: 2,
  createdBy: 'fixture-admin',
  createdAt: time,
};
const versions = [1, 2, 3].map((version) => ({
  configurationId,
  versionId: 'fixture-version-' + version,
  version,
  status: version === 3 ? 'DRAFT' : 'PUBLISHED',
  createdAt: time,
  effectiveAt: version === 1 ? time : version === 2 ? '2026-10-01T00:00:00Z' : null,
  changeNote: null,
  payload: { heartbeatInterval: 60, telemetryInterval: 30, cameraRefreshInterval: 5, temperatureThreshold: 85 },
}));
const empty = { ...summary, configurationId: 'cmp-empty-plan', name: 'Fixture empty plan', versionCount: 0 };
const planOpener = (page: Page) => page.getByTestId('config-detail-open-' + configurationId);

test('CMP-17/D5 shows paged Sync winners and unknown application separately from per-version delivery', async ({
  page,
  qa05,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await seedSession(page, 'Auditor');
  await routeP0Apis(page);
  const deviceReads: { id: string; query: string }[] = [];
  const statusReads: number[] = [];
  let releaseFirstStatus: () => void = () => {};
  const firstStatusPending = new Promise<void>((resolve) => {
    releaseFirstStatus = resolve;
  });
  await page.route('**/api/v1/admin/configurations**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/effective-devices')) {
      const id = url.pathname.split('/').at(-2) ?? '';
      deviceReads.push({ id, query: url.search });
      const secondPage = url.searchParams.has('cursor');
      const device = {
        model: 'CMP-MODEL',
        alias: null,
        deviceAppliedConfiguration: null,
      };
      const data =
        id === empty.configurationId
          ? []
          : secondPage
            ? [
                {
                  ...device,
                  deviceId: 'cmp-unconfigured',
                  serialNumber: 'SN-UNCONFIGURED',
                  cloudEffectiveConfiguration: null,
                },
              ]
            : [
                {
                  ...device,
                  deviceId: 'cmp-override',
                  serialNumber: 'SN-OVERRIDE',
                  cloudEffectiveConfiguration: {
                    configurationId: 'cmp-device-plan',
                    name: 'Fixture device override',
                    source: 'DEVICE',
                    version: 4,
                    effectiveAt: time,
                  },
                },
                {
                  ...device,
                  deviceId: 'cmp-model-device',
                  serialNumber: 'SN-MODEL',
                  cloudEffectiveConfiguration: {
                    configurationId,
                    name: summary.name,
                    source: 'MODEL',
                    version: 1,
                    effectiveAt: time,
                  },
                },
              ];
      return json(route, {
        data,
        meta: { nextCursor: secondPage || data.length === 0 ? null : 'cmp-next', timestamp: time },
      });
    }
    if (url.pathname.endsWith('/status')) {
      const version = Number(url.pathname.split('/').at(-2));
      statusReads.push(version);
      if (version === 1) await firstStatusPending;
      return json(route, {
        data: {
          configurationId,
          version,
          effectiveAt: versions[version - 1]?.effectiveAt,
          status: 'PUBLISHED',
          targets: [{ deviceId: 'cmp-model-device', notificationStatus: version === 1 ? 'PUBLISHED' : 'PENDING' }],
        },
      });
    }
    if (url.pathname.endsWith('/' + configurationId))
      return json(route, { data: { ...summary, versions, derivedContext: null } });
    if (url.pathname.endsWith('/' + empty.configurationId))
      return json(route, { data: { ...empty, versions: [], derivedContext: null } });
    return json(route, { data: [summary, empty] });
  });

  await page.goto('/configurations');
  await planOpener(page).click();
  const load = page.getByTestId('config-devices-load');
  await load.click();
  const targets = page.getByRole('region', { name: '目标设备的配置版本', exact: true });
  const table = targets.getByRole('table');
  const override = table.getByRole('row').filter({ hasText: 'SN-OVERRIDE' });
  await expect(override).toContainText('Fixture device override · v4');
  await expect(override).toContainText('来源：设备定向');
  const modelRow = table.getByRole('row').filter({ hasText: 'SN-MODEL' });
  await expect(modelRow).toContainText('Fixture model plan · v1');
  await expect(modelRow).toContainText('来源：型号定向');
  await expect(table.getByText('未知（无匹配回执）')).toHaveCount(2);
  expect(await layoutViolations(page)).toEqual([]);
  await targets.getByRole('button', { name: '下一页' }).click();
  await expect(table.getByRole('row').filter({ hasText: 'SN-UNCONFIGURED' })).toContainText('无生效配置');
  await targets.getByRole('button', { name: '上一页' }).click();
  await expect(override).toBeVisible();

  try {
    await page.getByTestId('config-expand-1').click();
    await page.getByTestId('config-sync-1').click();
    await expect(page.getByTestId('config-sync-loading-1')).toBeVisible();
    await page.getByTestId('config-expand-2').click();
    await page.getByTestId('config-sync-2').click();
    await expect(page.getByTestId('config-sync-targets-2')).toContainText('待投递');
  } finally {
    releaseFirstStatus();
  }
  await page.getByTestId('config-expand-1').click();
  await expect(page.getByTestId('config-sync-targets-1')).toContainText('已投递');
  await page.getByTestId('config-expand-2').click();
  await expect(page.getByTestId('config-sync-targets-2')).toContainText('待投递');
  await expect(modelRow).toContainText('未知（无匹配回执）');
  await page.getByTestId('config-expand-3').click();
  await expect(page.getByTestId('config-publish-3')).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.getByTestId('config-detail-open-' + empty.configurationId).click();
  await load.click();
  await expect(targets.getByText('此方案当前没有目标设备。')).toBeVisible();
  expect(deviceReads).toEqual([
    { id: configurationId, query: '?limit=25' },
    { id: configurationId, query: '?limit=25&cursor=cmp-next' },
    { id: configurationId, query: '?limit=25' },
    { id: empty.configurationId, query: '?limit=25' },
  ]);
  expect(statusReads).toEqual([1, 2]);
  qa05.proof = { deviceReads, statusReads };
});

for (const [zone, input, effectiveAt] of [
  ['Asia/Shanghai', '2026-09-07T00:30', '2026-09-06T16:30:00.000Z'],
  ['UTC', '2026-09-07T00:30', '2026-09-07T00:30:00.000Z'],
  ['Asia/Shanghai', '', undefined],
] as const) {
  test(`CMP-16 publishes with ${input === '' ? 'no scheduled time' : zone} and preserves the reason`, async ({
    page,
    qa05,
  }) => {
    await seedSession(page, 'PlatformOperator');
    await page.addInitScript((value) => localStorage.setItem('fdp.admin.time-zone.v1', value), zone);
    await routeP0Apis(page);
    const writes: unknown[] = [];
    await page.route('**/api/v1/admin/configurations**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/versions/3/publish')) {
        writes.push(route.request().postDataJSON());
        return json(route, {
          data: { configurationId, version: 3, status: 'PUBLISHED', effectiveAt: effectiveAt ?? time },
        });
      }
      if (path.endsWith('/' + configurationId))
        return json(route, { data: { ...summary, versions, derivedContext: null } });
      return json(route, { data: [summary] });
    });

    await page.goto('/configurations');
    await planOpener(page).click();
    await page.getByTestId('config-expand-3').click();
    await page.getByTestId('config-publish-3').click();
    const dialog = page.getByTestId('config-publish-dialog');
    await expect(dialog).toContainText(zone);
    const field = dialog.getByTestId('publish-effective-at');
    const submit = dialog.getByTestId('config-publish');
    await expect(field).toHaveAttribute('type', 'datetime-local');
    await field.fill('2026-09-07T00:30:00.123');
    await expect(dialog.getByRole('alert')).toContainText('请输入完整有效的日期和时间');
    await expect(submit).toBeDisabled();
    expect(writes).toEqual([]);
    await field.fill(input);
    await expect(submit).toBeEnabled();
    await dialog.getByTestId('publish-reason').fill('CMP scheduled fixture');
    await submit.click();
    await expect(page.getByTestId('action-notice')).toContainText('CONFIG_CHANGED');
    expect(writes).toEqual([
      { reason: 'CMP scheduled fixture', ...(effectiveAt === undefined ? {} : { effectiveAt }) },
    ]);
    qa05.proof = { zone, input, writes };
  });
}
