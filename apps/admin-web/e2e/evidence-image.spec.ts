import { expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, p0Alarm, routeP0Apis, seedSession } from './qa05-api-fixtures.js';
const jpeg = readFileSync(new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url));
const captureTime = '2026-11-07T00:00:00Z';
const evidence = (mediaId: string, status = 'AVAILABLE') => ({ mediaId, captureTime, status });
for (const [width, language] of [
  [1440, 'en'],
  [375, 'zh-CN'],
] as const) {
  test(`IMG-16 alarm image stays available after clearing ${width} ${language}`, async ({ page, qa05 }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await seedSession(page, 'PlatformOperator');
    await routeP0Apis(page);
    await page.addInitScript((lang) => localStorage.setItem('fdp.admin.lang.v1', lang), language);
    let alarm = { ...p0Alarm, evidenceImage: evidence('alarm-media') };
    await page.route('**/api/v1/admin/alarms**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/clear')) {
        alarm = { ...alarm, status: 'CLEARED' };
        return json(route, { data: { ...alarm, replayed: false }, meta: {} });
      }
      return json(route, { data: path.endsWith('/alarm-p0') ? alarm : [alarm], meta: { nextCursor: null } });
    });
    let signed = 0;
    await page.route('**/api/v1/admin/media/alarm-media/download-url', (route) => {
      signed++;
      return json(route, {
        data: {
          mediaId: 'alarm-media',
          downloadUrl: `https://archive.example.test/alarm.jpg?local=${signed}`,
          downloadUrlExpiresAt: new Date(Date.now() + 900000).toISOString(),
        },
        meta: {},
      });
    });
    await page.route('https://archive.example.test/alarm.jpg?*', (route) =>
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg }),
    );
    await page.goto('/alarms');
    await page.getByTestId('alarm-detail-alarm-p0').click();
    const entry = page.getByTestId('evidence-open-alarm-p0');
    await expect(entry).toBeVisible();
    expect(signed).toBe(0);
    await entry.click();
    const frame = page.getByTestId('evidence-image');
    await expect(frame).toBeVisible();
    await expect.poll(() => frame.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page
      .getByTestId('evidence-modal')
      .getByRole('button', { name: language === 'en' ? 'Close image' : '关闭图片', exact: true })
      .click();
    await page.getByTestId('alarm-clear').click();
    const confirm = page.getByTestId('confirm-dialog');
    await confirm.getByRole('textbox').fill('Resolved');
    await confirm.getByRole('button', { name: language === 'en' ? 'Confirm clear' : '确认清除', exact: true }).click();
    await expect(page.getByTestId('detail-status')).toHaveText(language === 'en' ? 'Cleared' : '已清除');
    await entry.click();
    await expect(frame).toBeVisible();
    expect(signed).toBe(2);
    expect(await layoutViolations(page)).toEqual([]);
    const screenshot = await page.getByTestId('evidence-modal').screenshot();
    writeFileSync(`/tmp/fdp-img16-alarm-${width}.png`, screenshot);
    await info.attach(`img16-alarm-${width}.png`, { body: screenshot, contentType: 'image/png' });
    const stored = await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].join(''),
    );
    expect(stored).not.toContain('archive.example.test');
    expect(stored).not.toContain(jpeg.toString('base64'));
    qa05.proof.evidenceAlarm = { width, language, sameOriginalAfterClear: true, signingCalls: signed };
  });
}
test('IMG-16 events distinguish associations and recover signing/image failures, with permission and missing-media errors', async ({
  page,
  qa05,
}, info) => {
  await seedSession(page, 'CustomerViewer');
  await routeP0Apis(page);
  await page.addInitScript(() => localStorage.setItem('fdp.admin.lang.v1', 'en'));
  const event = {
    deviceId: 'dev-p0',
    customerId: 'cust-a',
    eventType: 'DOOR_OPEN',
    occurredAt: captureTime,
    userId: null,
    username: null,
    source: null,
    remarks: null,
  };
  const events = [
    { ...event, eventId: 'ev-unlinked', evidenceImage: null },
    { ...event, eventId: 'ev-omitted' },
    { ...event, eventId: 'ev-deleted', evidenceImage: evidence('deleted', 'DELETED') },
    ...['retry', 'denied', 'missing'].map((id) => ({ ...event, eventId: id, evidenceImage: evidence(id) })),
  ];
  await page.route('**/api/v1/admin/events**', (route) => json(route, { data: events, meta: { nextCursor: null } }));
  let signed = 0;
  await page.route('**/api/v1/admin/media/*/download-url', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    if (id === 'denied' || id === 'missing')
      return route.fulfill({
        status: id === 'denied' ? 403 : 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: id === 'denied' ? 'FORBIDDEN' : 'NOT_FOUND',
            message: 'private upstream detail',
            requestId: 'img16-local',
          },
        }),
      });
    signed++;
    if (signed === 1)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'private upstream detail', requestId: 'img16-local' },
        }),
      });
    return json(route, {
      data: {
        mediaId: 'retry',
        downloadUrl: `https://archive.example.test/${signed === 2 ? 'broken' : 'valid'}.jpg?local=${signed}`,
        downloadUrlExpiresAt: new Date(Date.now() + 900000).toISOString(),
      },
      meta: {},
    });
  });
  await page.route('https://archive.example.test/*.jpg?*', (route) =>
    route.fulfill(
      new URL(route.request().url()).pathname === '/broken.jpg'
        ? { status: 404 }
        : { status: 200, contentType: 'image/jpeg', body: jpeg },
    ),
  );
  await page.goto('/alarms?tab=event');
  await expect(page.getByTestId('evidence-ev-unlinked')).toContainText('No image is linked');
  await expect(page.getByTestId('evidence-ev-omitted')).toContainText('information is not available');
  await expect(page.getByTestId('evidence-ev-deleted')).toContainText('deleted');
  expect(signed).toBe(0);
  await page.getByTestId('evidence-open-retry').click();
  const modal = page.getByTestId('evidence-modal');
  await expect(modal.getByRole('alert')).toContainText('Could not obtain');
  await expect(modal).not.toContainText('private upstream detail');
  await modal.getByRole('button', { name: 'Request a new link' }).click();
  await expect(modal.getByRole('alert')).toContainText('could not be loaded');
  await modal.getByRole('button', { name: 'Request a new link' }).click();
  await expect(page.getByTestId('evidence-image')).toBeVisible();
  await expect
    .poll(() => page.getByTestId('evidence-image').evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(signed).toBe(3);
  await modal.getByRole('button', { name: 'Close image', exact: true }).click();
  for (const id of ['denied', 'missing']) {
    await page.getByTestId(`evidence-open-${id}`).click();
    await expect(modal.getByRole('alert')).toContainText(id === 'denied' ? 'was denied' : 'unavailable');
    await expect(modal.getByRole('button', { name: 'Request a new link' })).toHaveCount(0);
    await expect(page.getByTestId('evidence-image')).toHaveCount(0);
    const screenshot = await modal.screenshot();
    writeFileSync(`/tmp/fdp-img16-${id}.png`, screenshot);
    await info.attach(`img16-${id}.png`, { body: screenshot, contentType: 'image/png' });
    await modal.getByRole('button', { name: 'Close image', exact: true }).click();
  }
  qa05.proof.evidenceEvents = {
    nullAndOmittedDistinct: true,
    deletedNoDownload: true,
    retries: signed,
    deniedAndMissingStop: true,
  };
});
