import { expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from './qa05-fixture.js';
import { json, routeP0Apis, seedSession } from './qa05-api-fixtures.js';
const image = readFileSync(
  new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url),
).toString('base64');
const streamId = '10000000-0000-4000-8000-000000000001';
const frameId = '20000000-0000-4000-8000-000000000001';
const start = Date.parse('2026-11-07T00:00:00Z');
const meta = (at: number) => ({ timestamp: new Date(at).toISOString(), requestId: 'img15-local' });
const lease = (at: number) => ({
  data: { streamId, leaseExpiresAt: new Date(at + 30000).toISOString(), renewAfterSeconds: 10, readIntervalMs: 2000 },
  meta: meta(at),
});
const ready = (at: number) => ({
  data: {
    state: 'READY',
    streamId,
    frameId,
    mimeType: 'image/jpeg',
    imageBase64: image,
    capturedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 10000).toISOString(),
  },
  meta: meta(at),
});
async function setup(page: Page, language: string) {
  await seedSession(page, 'CustomerViewer');
  await routeP0Apis(page);
  await page.addInitScript((lang) => localStorage.setItem('fdp.admin.lang.v1', lang), language);
  await page.route('**/api/v1/admin/media/media-p1/download-url', (route) =>
    json(route, {
      data: {
        mediaId: 'media-p1',
        downloadUrl: `data:image/jpeg;base64,${image}`,
        downloadUrlExpiresAt: '2099-01-01T00:00:00Z',
      },
      meta: {},
    }),
  );
  await page.clock.install({ time: new Date(start) });
  await page.clock.pauseAt(new Date(start));
}
async function visibility(page: Page, value: string) {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}
test('IMG-15 independent frame deadline, stalled read and ignored late prior-session reply', async ({ page, qa05 }) => {
  await setup(page, 'en');
  let now = start,
    reads = 0,
    pending: Route | undefined;
  const calls: { method: string; path: string }[] = [];
  await page.route('**/api/v1/admin/devices/*/live-image/**', async (route) => {
    const method = route.request().method();
    calls.push({ method, path: new URL(route.request().url()).pathname });
    if (method === 'DELETE') return route.fulfill({ status: 204 });
    if (method === 'PUT') return json(route, lease(now));
    if (reads++ === 1) {
      pending = route;
      return;
    }
    return json(route, ready(now));
  });
  await page.goto('/devices/view?deviceId=dev-p0');
  const toggle = page.getByTestId('live-image-toggle'),
    frame = page.getByTestId('live-image-frame');
  await toggle.click();
  await expect(frame).toBeVisible();
  now += 2000;
  await page.clock.runFor(2000);
  await expect.poll(() => pending !== undefined).toBe(true);
  now += 8000;
  await page.clock.runFor(8000);
  await expect(frame).toHaveCount(0);
  await expect(page.getByTestId('live-image-preview').getByRole('status')).toContainText('previous image expired');
  await toggle.click();
  await toggle.click();
  await expect(frame).toBeVisible();
  const puts = calls.filter((call) => call.method === 'PUT');
  expect(puts.at(-1)!.path).not.toBe(puts[0]!.path);
  await json(pending!, ready(start));
  await expect(frame).toBeVisible();
  await expect.poll(() => frame.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join('')),
  ).not.toContain(image);
  qa05.proof.imageDeadline = { independentExpiry: true, freshViewer: true, lateReplyIgnored: true };
});
for (const language of ['en', 'zh-CN']) {
  test(`IMG-15 rate limit cooldown survives hide/reopen and permission revocation stops (${language})`, async ({
    page,
    qa05,
  }, info) => {
    await setup(page, language);
    let now = start,
      puts = 0,
      reads = 0;
    await page.route('**/api/v1/admin/devices/*/live-image/**', (route) => {
      const method = route.request().method();
      if (method === 'DELETE') return route.fulfill({ status: 204 });
      if (method === 'PUT') {
        if (puts++ === 0)
          return route.fulfill({
            status: 429,
            contentType: 'application/json',
            headers: { 'Retry-After': '6' },
            body: JSON.stringify({
              error: { code: 'RATE_LIMITED', message: 'private upstream detail', requestId: 'img15-local' },
            }),
          });
        return json(route, lease(now));
      }
      if (reads++ === 0) return json(route, ready(now));
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'FORBIDDEN', message: 'private upstream detail', requestId: 'img15-local' },
        }),
      });
    });
    await page.goto('/devices/view?deviceId=dev-p0');
    const toggle = page.getByTestId('live-image-toggle'),
      preview = page.getByTestId('live-image-preview');
    await toggle.click();
    await expect(preview.getByRole('status')).toContainText(
      language === 'en' ? 'Reconnecting automatically' : '自动重连',
    );
    await visibility(page, 'hidden');
    await visibility(page, 'visible');
    await toggle.click();
    await toggle.click();
    now += 5999;
    await page.clock.runFor(5999);
    expect(puts).toBe(1);
    now += 1;
    await page.clock.runFor(1);
    await expect(page.getByTestId('live-image-frame')).toBeVisible();
    now += 2000;
    await page.clock.runFor(2000);
    await expect(page.getByTestId('live-image-frame')).toHaveCount(0);
    await expect(preview.getByRole('alert')).toContainText(language === 'en' ? 'access was revoked' : '权限已失效');
    await expect(preview).not.toContainText('private upstream detail');
    const stoppedPuts = puts;
    await visibility(page, 'hidden');
    await visibility(page, 'visible');
    now += 60000;
    await page.clock.runFor(60000);
    expect(puts).toBe(stoppedPuts);
    const capture = await preview.screenshot();
    writeFileSync(`/tmp/fdp-img15-${language}.png`, capture);
    await info.attach(`img15-${language}.png`, { body: capture, contentType: 'image/png' });
    qa05.proof.imageRecovery = { language, retryAfterSeconds: 6, stoppedAfter403: true };
  });
}
