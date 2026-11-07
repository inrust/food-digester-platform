import { expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from './qa05-fixture.js';
import {
  json,
  layoutViolations,
  p0Console,
  p0Device,
  routeP0Apis,
  routeFe11To15Apis,
  seedSession,
} from './qa05-api-fixtures.js';
const image = readFileSync(
  new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url),
).toString('base64');
const streamId = '10000000-0000-4000-8000-000000000001',
  frameId = '20000000-0000-4000-8000-000000000001';
for (const [width, language, pageState] of [
  [1440, 'en', 'view'],
  [375, 'zh-CN', 'view'],
  [1440, 'en', 'operate'],
] as const) {
  test(`IMG-14 image preview lifecycle and layout ${pageState} ${width} ${language}`, async ({ page, qa05 }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await seedSession(page, pageState === 'operate' ? 'PlatformOperator' : 'CustomerViewer');
    await routeP0Apis(page);
    if (pageState === 'operate') await routeFe11To15Apis(page);
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
    await page.route('**/api/v1/admin/devices/dev-second', (route) =>
      json(route, { data: { ...p0Device, id: 'dev-second', alias: 'Second device' }, meta: {} }),
    );
    await page.route('**/api/v1/admin/devices/dev-second/console', (route) =>
      json(route, {
        data: { ...p0Console, device: { ...p0Console.device, deviceId: 'dev-second', alias: 'Second device' } },
        meta: {},
      }),
    );
    const calls: { method: string; path: string; viewer: string | null }[] = [];
    await page.route('**/api/v1/admin/devices/*/live-image/**', (route) => {
      const url = new URL(route.request().url()),
        method = route.request().method();
      calls.push({ method, path: url.pathname, viewer: url.searchParams.get('viewerId') });
      const at = Date.now(),
        meta = { timestamp: new Date(at).toISOString(), requestId: 'img14-e2e' };
      if (method === 'DELETE') return route.fulfill({ status: 204, body: '' });
      if (method === 'PUT')
        return json(route, {
          data: {
            streamId,
            leaseExpiresAt: new Date(at + 30000).toISOString(),
            renewAfterSeconds: 10,
            readIntervalMs: 2000,
          },
          meta,
        });
      return json(route, {
        data: {
          state: 'READY',
          streamId,
          frameId,
          mimeType: 'image/jpeg',
          imageBase64: image,
          capturedAt: new Date(at).toISOString(),
          expiresAt: new Date(at + 10000).toISOString(),
        },
        meta,
      });
    });
    await page.goto(`/devices/${pageState}?deviceId=dev-p0`);
    await expect(page.getByTestId('live-image-toggle')).toBeVisible();
    expect(calls).toHaveLength(0);
    await page.getByTestId('live-image-toggle').click();
    const frame = page.getByTestId('live-image-frame');
    await expect(frame).toBeVisible();
    await expect.poll(() => frame.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect.poll(() => calls.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('live-image-preview').getByRole('heading')).toHaveText(
      language === 'en' ? 'Live image preview' : '实时图片预览',
    );
    expect(await layoutViolations(page)).toEqual([]);
    const capture = await page.getByTestId('live-image-preview').screenshot();
    writeFileSync(`/tmp/fdp-img14-${pageState}-${width}.png`, capture);
    await info.attach(`live-image-${pageState}-${width}.png`, { body: capture, contentType: 'image/png' });
    const stored = await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].join(''),
    );
    expect(stored).not.toContain(image);
    const firstViewer = calls.find((call) => call.method === 'PUT')!.path;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(frame).toHaveCount(0);
    await expect.poll(() => calls.filter((call) => call.method === 'DELETE').length).toBe(1);
    const pausedReads = calls.filter((call) => call.method === 'GET').length;
    await page.waitForTimeout(2200);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(pausedReads);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(frame).toBeVisible();
    expect(calls.filter((call) => call.method === 'PUT').at(-1)!.path).not.toBe(firstViewer);
    await page.evaluate((state) => {
      history.pushState(null, '', `/devices/${state}?deviceId=dev-second`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, pageState);
    await expect(frame).toHaveCount(0);
    await expect(page.getByTestId('live-image-preview')).toContainText('Second device');
    await expect.poll(() => calls.filter((call) => call.method === 'DELETE').length).toBe(2);
    await page.getByTestId('live-image-toggle').click();
    await expect(frame).toBeVisible();
    expect(calls.filter((call) => call.method === 'PUT').at(-1)!.path).toContain('/dev-second/');
    await page.evaluate((state) => {
      history.pushState(null, '', `/devices/${state}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, pageState);
    await expect(page.getByTestId('live-image-preview')).toHaveCount(0);
    await expect.poll(() => calls.filter((call) => call.method === 'DELETE').length).toBe(3);
    qa05.proof.imagePreviewLifecycle = {
      width,
      language,
      readRequests: calls.filter((call) => call.method === 'GET').length,
      released: 3,
    };
  });
}
