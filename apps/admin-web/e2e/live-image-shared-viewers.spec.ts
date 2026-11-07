import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { test } from './qa05-fixture.js';
import { json, routeP0Apis, seedSession } from './qa05-api-fixtures.js';
const jpeg = readFileSync(
  new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url),
).toString('base64');
test('IMG-19 two independent pages share a stream, one close leaves the other polling and authority denial stops the remaining page', async ({
  page,
  qa05,
}) => {
  const second = await qa05.newPage();
  const leases = new Set<string>(),
    reads = new Map<string, number>();
  const streamId = '10000000-0000-4000-8000-000000000001',
    frameId = '20000000-0000-4000-8000-000000000001';
  const start = Date.now(),
    expiresAt = new Date(start + 10000).toISOString();
  let denied = false,
    unchanged = 0;
  for (const current of [page, second]) {
    await seedSession(current, 'CustomerViewer');
    await routeP0Apis(current);
    await current.route('**/api/v1/admin/media/media-p1/download-url', (route) =>
      json(route, {
        data: {
          mediaId: 'media-p1',
          downloadUrl: `data:image/jpeg;base64,${jpeg}`,
          downloadUrlExpiresAt: '2099-01-01T00:00:00Z',
        },
        meta: {},
      }),
    );
    await current.route('**/api/v1/admin/devices/*/live-image/**', (route) => {
      const method = route.request().method(),
        url = new URL(route.request().url()),
        viewer = method === 'GET' ? url.searchParams.get('viewerId')! : url.pathname.split('/').at(-1)!;
      const error = (status: number, code: string) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code, message: 'The request failed', requestId: 'img19-browser' } }),
        });
      if (method === 'DELETE') {
        leases.delete(viewer);
        return route.fulfill({ status: 204 });
      }
      if (denied) {
        leases.clear();
        return error(403, 'FORBIDDEN');
      }
      const meta = { requestId: 'img19-browser', timestamp: new Date(Date.now()).toISOString() };
      if (method === 'PUT') {
        if (route.request().postData() !== null) return error(400, 'VALIDATION_FAILED');
        leases.add(viewer);
        return json(route, {
          data: {
            streamId,
            leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
            renewAfterSeconds: 10,
            readIntervalMs: 2000,
          },
          meta,
        });
      }
      if (!leases.has(viewer)) return error(409, 'LIVE_VIEWER_EXPIRED');
      reads.set(viewer, (reads.get(viewer) ?? 0) + 1);
      if (url.searchParams.get('knownFrameId') === frameId) {
        unchanged++;
        return json(route, { data: { state: 'UNCHANGED', streamId, frameId, expiresAt }, meta });
      }
      return json(route, {
        data: {
          state: 'READY',
          streamId,
          frameId,
          capturedAt: new Date(start).toISOString(),
          expiresAt,
          mimeType: 'image/jpeg',
          imageBase64: jpeg,
        },
        meta,
      });
    });
    await current.goto('/devices/view?deviceId=dev-p0');
    await current.getByTestId('live-image-toggle').click();
    await expect(current.getByTestId('live-image-frame')).toBeVisible();
  }
  expect(leases.size).toBe(2);
  expect(await page.getByTestId('live-image-frame').getAttribute('src')).toBe(
    await second.getByTestId('live-image-frame').getAttribute('src'),
  );
  const original = [...leases];
  await page.getByTestId('live-image-toggle').click();
  await expect.poll(() => leases.size).toBe(1);
  const survivor = [...leases][0]!;
  expect(original).toContain(survivor);
  const previousReads = reads.get(survivor) ?? 0;
  await expect.poll(() => reads.get(survivor) ?? 0, { timeout: 4000 }).toBeGreaterThan(previousReads);
  await expect(second.getByTestId('live-image-frame')).toBeVisible();
  expect(unchanged).toBeGreaterThan(0);
  denied = true;
  await expect(second.getByTestId('live-image-frame')).toHaveCount(0, { timeout: 4000 });
  await expect(second.getByTestId('error-forbidden')).toBeVisible();
  expect(leases.size).toBe(0);
  qa05.proof.sharedImageViewers = {
    sharedStream: streamId,
    distinctViewers: original.length,
    survivorPollsAfterClose: true,
    knownFrameIdUnchanged: unchanged,
    deniedStopsFrame: true,
  };
});
