import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, seedSession } from './qa05-api-fixtures.js';

test('CMP-34 settings expose API runtime facts and FE-18 reads only the consumable warning and major thresholds', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await seedSession(page, 'PlatformSuperAdmin');
  const base = { version: 7, updatedBy: 'fixture-user', updatedAt: '2026-09-10T00:00:00Z' };
  const threshold = {
    ...base,
    key: 'alarm.thresholds',
    value: {
      CONSUMABLE_REMAINING_PERCENT: { warning: 40, major: 60, critical: 90 },
      TEMPERATURE_HIGH: { warning: 72, major: 82 },
    },
    runtimeStatus: 'ACTIVE',
    runtimeConsumer: 'FE-18',
  };
  const settings = [
    threshold,
    {
      ...base,
      key: 'command.confirmation',
      value: { ttlSec: 45, maxFutureSec: 5 },
      runtimeStatus: 'ACTIVE',
      runtimeConsumer: 'BE-CMD-01',
    },
    {
      ...base,
      key: 'dictionary.displayNames',
      value: { command: { STOP: 'Fixture label' } },
      runtimeStatus: 'STORED_ONLY',
      runtimeConsumer: null,
    },
    {
      ...base,
      key: 'notification.business',
      value: { eventTypes: ['CRITICAL_ALERT_RAISED'], channels: ['EMAIL'] },
      runtimeStatus: 'STORED_ONLY',
      runtimeConsumer: null,
    },
  ];
  const reading = (remainingPercent: number) => ({
    remainingPercent,
    remainingDisplay: remainingPercent + '%',
    stale: false,
    observedAt: base.updatedAt,
  });
  await page.route('**/api/v1/admin/users**', (route) => json(route, { data: [], meta: { nextCursor: null } }));
  const settingRequests: string[] = [];
  await page.route('**/api/v1/admin/settings**', (route) => {
    const path = new URL(route.request().url()).pathname;
    settingRequests.push(route.request().method() + ':' + path);
    return json(route, { data: path.endsWith('/settings') ? settings : threshold });
  });
  await page.route('**/api/v1/admin/consumables**', (route) =>
    json(route, {
      data: [
        {
          deviceId: 'cmp-t09-device',
          serialNumber: 'CMP-T09',
          model: 'T09',
          alias: null,
          lifecycleStatus: 'Active',
          site: null,
          connectivity: 'ONLINE',
          consumables: { CARBON_FILTER: reading(50), BIO_ADDITIVE: reading(85) },
        },
      ],
      meta: { nextCursor: null },
    }),
  );
  await page.route('**/api/v1/admin/consumable-requests**', (route) => json(route, { data: [] }));

  await page.goto('/settings');
  await page.getByTestId('tab-business-settings').click();
  const cards = page.getByTestId('business-settings-tab');
  await expect(cards.getByRole('article')).toHaveCount(4);
  await expect(cards.getByTestId('setting-consumer-alarm.thresholds')).toContainText('FE-18');
  await expect(cards.getByTestId('setting-alarm.thresholds')).toContainText(
    /CONSUMABLE_REMAINING_PERCENT.*warning.*major/,
  );
  await expect(cards.getByTestId('setting-command.confirmation')).toContainText(/ttlSec.*maxFutureSec/);
  await expect(cards.getByTestId('setting-consumer-command.confirmation')).toContainText('BE-CMD-01');
  await expect(cards.getByTestId('setting-edit-command.confirmation')).toHaveCount(0);
  for (const key of ['dictionary.displayNames', 'notification.business']) {
    await expect(cards.getByTestId(`setting-runtime-${key}`)).toContainText('仅存储');
    await expect(cards.getByTestId(`setting-consumer-${key}`)).toContainText('尚无运行时消费方');
    await expect(cards.getByTestId(`setting-edit-${key}`)).toBeEnabled();
  }
  await expect(cards.getByTestId('setting-edit-alarm.thresholds')).toBeEnabled();
  expect(await layoutViolations(page)).toEqual([]);

  await page.goto('/consumables');
  await expect(page.getByTestId('consumable-carbon-cmp-t09-device').locator('.consumable-bar')).toHaveAttribute(
    'data-level',
    'mid',
  );
  await expect(page.getByTestId('consumable-bio-cmp-t09-device').locator('.consumable-bar')).toHaveAttribute(
    'data-level',
    'ok',
  );
  expect(settingRequests).toEqual(['GET:/api/v1/admin/settings', 'GET:/api/v1/admin/settings/alarm.thresholds']);
});
