import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { json, layoutViolations, seedSession } from './qa05-api-fixtures.js';

const rows = [
  ['a', 3, 'device-one'],
  ['b', 1, 'device-one'],
  ['c', 2, 'device-two'],
  ['d', 2, 'device-one'],
  ['e', 2, 'device-one'],
  ['f', 1, 'device-two'],
].map(([id, hour, deviceId]) => ({
  mediaId: String(id),
  deviceId: String(deviceId),
  customerId: 'cust-a',
  mediaType: 'IMAGE',
  captureTime: '2026-09-05T0' + hour + ':00:00.000Z',
  fileName: id + '.jpg',
  sizeKb: 1,
  durationSec: 0,
  status: 'AVAILABLE',
  createdAt: '2026-09-05T08:00:00.000Z',
}));

test('CMP-23 media requests the current order and ignores a late response after switching direction', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await seedSession(page, 'CustomerViewer', { customerId: 'cust-a' });
  const requests: Record<string, string>[] = [];
  let releaseOldPage!: () => void;
  const delayed = new Promise<void>((resolve) => {
    releaseOldPage = resolve;
  });
  let failAscendingPage = true;
  await page.route('**/api/v1/admin/media?*', async (route) => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    requests.push(query);
    const direction = query['captureTimeOrder'];
    const cursor = query['cursor'];
    const device = query['deviceId'];
    if (direction !== 'asc' && direction !== 'desc') return json(route, { error: { code: 'VALIDATION_FAILED' } }, 400);
    const active = rows.filter((row) => device === undefined || row.deviceId === device);
    active.sort((left, right) => {
      const order = left.captureTime.localeCompare(right.captureTime) || left.mediaId.localeCompare(right.mediaId);
      return direction === 'asc' ? order : -order;
    });
    if (cursor === 'desc:4') await delayed;
    if (cursor === 'asc:2' && failAscendingPage) {
      failAscendingPage = false;
      return json(route, { error: { code: 'UNAVAILABLE', message: 'fixture page failed' } }, 503);
    }
    const start = cursor === undefined ? 0 : Number(cursor.split(':')[1]);
    const end = start + 2;
    return json(route, {
      data: active.slice(start, end),
      meta: { nextCursor: active.length > end ? direction + ':' + end : null },
    });
  });

  await page.goto('/media');
  const result = page.getByTestId('media-list-section');
  const files = result.locator('tbody tr:not(.ant-table-placeholder) td:first-child');
  const next = result.getByRole('button', { name: '下一页' });
  const sortHeader = result.locator('th[aria-sort]');
  const sortButton = sortHeader.getByRole('button');
  await expect(sortHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(sortButton).toHaveAccessibleName('按采集时间升序排序');
  await expect(files).toHaveText(['a.jpg', 'e.jpg']);
  expect(requests).toEqual([{ captureTimeOrder: 'desc' }]);
  expect(await layoutViolations(page)).toEqual([]);

  await next.click();
  await expect(files).toHaveText(['a.jpg', 'e.jpg', 'd.jpg', 'c.jpg']);
  expect(requests.at(-1)).toEqual({ captureTimeOrder: 'desc', cursor: 'desc:2' });
  await next.click();
  await expect.poll(() => requests.at(-1)).toEqual({ captureTimeOrder: 'desc', cursor: 'desc:4' });
  await expect(next).toBeDisabled();

  await sortButton.focus();
  await page.keyboard.press('Enter');
  await expect(sortHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(sortButton).toHaveAccessibleName('按采集时间降序排序');
  await expect(sortButton).toBeFocused();
  await expect(files).toHaveText(['b.jpg', 'f.jpg']);
  expect(requests.at(-1)).toEqual({ captureTimeOrder: 'asc' });
  const lateArrives = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get('cursor') === 'desc:4',
  );
  releaseOldPage();
  await lateArrives;

  await next.click();
  await expect(result.getByRole('alert')).toContainText('fixture page failed');
  await expect(files).toHaveText(['b.jpg', 'f.jpg']);
  await next.click();
  await expect(files).toHaveText(['b.jpg', 'f.jpg', 'c.jpg', 'd.jpg']);
  expect(requests.at(-1)).toEqual({ captureTimeOrder: 'asc', cursor: 'asc:2' });

  await expect(page.getByTestId('media-filter-customer')).toHaveCount(0);
  await page.getByTestId('media-filter-device').fill('device-one');
  await page.getByTestId('media-filter-search').click();
  await expect(files).toHaveText(['b.jpg', 'd.jpg']);
  expect(requests.at(-1)).toEqual({ captureTimeOrder: 'asc', deviceId: 'device-one' });
  await next.click();
  await expect(files).toHaveText(['b.jpg', 'd.jpg', 'e.jpg', 'a.jpg']);
  expect(requests.at(-1)).toEqual({ captureTimeOrder: 'asc', deviceId: 'device-one', cursor: 'asc:2' });

  await sortButton.click();
  await expect(files).toHaveText(['a.jpg', 'e.jpg']);
  expect(requests.at(-1)).toEqual({ captureTimeOrder: 'desc', deviceId: 'device-one' });
});
