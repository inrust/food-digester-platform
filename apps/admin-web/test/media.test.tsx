// @vitest-environment jsdom
/**
 * FE-14 Media 页测试：
 * - 元数据列表 + 类型/设备/状态/时间筛选（时间转 UTC ISO；Customer 角色无 customerId 筛选）；
 * - 受控查看：IMAGE → img、VIDEO → video（录制文件，无实时流语义）；下载链接 15 分钟短期；
 * - 链接过期 → 重新申请（实时重签，不持久缓存）；关闭预览即弃用 URL；
 * - DELETED（DEC-005 元数据保留）不提供下载；未知媒体类型安全降级（仅元数据）；
 * - 跨 Customer/越权：403/404 经 ErrorNotice 正确呈现。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError, ForbiddenError } from '../src/api/errors.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { MediaPage } from '../src/pages/media/MediaPage.js';
import type { MediaPageProps } from '../src/pages/media/MediaPage.js';
import { createMediaDownloadUrl, listMedia } from '../src/pages/media/media-api.js';
import type { MediaListFilter } from '../src/pages/media/media-api.js';
import {
  DOWNLOAD_URL_TTL_SEC,
  isDownloadUrlExpired,
  isKnownMediaType,
  localDateTimeToUtcIso,
  mediaTypeLabel,
} from '../src/pages/media/media-state.js';
import type { MediaDownloadUrlView, MediaView } from '../src/pages/media/types.js';

afterEach(cleanup);

function makeMedia(overrides: Partial<MediaView> = {}): MediaView {
  return {
    mediaId: 'med-001',
    deviceId: 'dev-001',
    customerId: 'cust-1',
    mediaType: 'IMAGE',
    captureTime: '2026-09-06T03:50:00Z',
    fileName: 'snapshot-001.jpg',
    sizeKb: 256,
    durationSec: 0,
    status: 'AVAILABLE',
    createdAt: '2026-09-06T03:50:05Z',
    ...overrides,
  };
}

function makeDownloadUrl(overrides: Partial<MediaDownloadUrlView> = {}): MediaDownloadUrlView {
  return {
    mediaId: 'med-001',
    downloadUrl: 'https://s3.example.com/presigned-get/med-001',
    // 缺省为未来 15 分钟（DEC-024 900s），避免真实时钟下立即过期；过期测试显式覆盖
    downloadUrlExpiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SEC * 1000).toISOString(),
    ...overrides,
  };
}

function renderPage(overrides: Partial<MediaPageProps> = {}) {
  const calls = {
    filterApplied: [] as MediaListFilter[],
    urlRequested: [] as string[],
    refreshed: 0,
  };
  const props: MediaPageProps = {
    role: 'PlatformSuperAdmin',
    media: {
      rows: [
        makeMedia(),
        makeMedia({ mediaId: 'med-002', mediaType: 'VIDEO', fileName: 'clip-002.mp4', durationSec: 12 }),
        makeMedia({ mediaId: 'med-003', fileName: 'old-003.jpg', status: 'DELETED' }),
      ],
      nextCursor: null,
    },
    filter: {},
    onApplyFilter: (f) => calls.filterApplied.push(f),
    onLoadMore: () => {},
    onRefresh: () => {
      calls.refreshed += 1;
    },
    onRequestDownloadUrl: async (mediaId) => {
      calls.urlRequested.push(mediaId);
      return makeDownloadUrl({ mediaId });
    },
    ...overrides,
  };
  const utils = render(<MediaPage {...props} />);
  return { calls, unmount: utils.unmount };
}

// ---------- 列表与筛选 ----------

test('列表渲染元数据；类型/设备/状态/时间筛选经回调应用（时间转 UTC ISO）', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  assert.ok(screen.getByText('snapshot-001.jpg'));
  assert.ok(screen.getByText('clip-002.mp4'));
  // 视频时长展示，图片为 —
  assert.ok(screen.getByText('12s'));

  await user.selectOptions(screen.getByTestId('media-filter-type'), 'VIDEO');
  await user.selectOptions(screen.getByTestId('media-filter-status'), 'AVAILABLE');
  await user.type(screen.getByTestId('media-filter-device'), 'dev-001');
  await user.type(screen.getByTestId('media-filter-customer'), 'cust-9');
  fireEvent.change(screen.getByTestId('media-filter-from'), { target: { value: '2026-09-01T10:00' } });
  fireEvent.change(screen.getByTestId('media-filter-to'), { target: { value: '2026-09-02T10:00' } });
  await user.click(screen.getByTestId('media-filter-search'));

  assert.deepEqual(calls.filterApplied, [
    {
      deviceId: 'dev-001',
      mediaType: 'VIDEO',
      status: 'AVAILABLE',
      customerId: 'cust-9',
      from: localDateTimeToUtcIso('2026-09-01T10:00', 'Asia/Shanghai'),
      to: localDateTimeToUtcIso('2026-09-02T10:00', 'Asia/Shanghai'),
    },
  ]);
});

test('Customer 角色不暴露 customerId 筛选（服务端强制租户隔离）', () => {
  const { unmount } = renderPage({ role: 'CustomerAdmin' });
  assert.equal(screen.queryByTestId('media-filter-customer'), null);
  unmount();
  renderPage({ role: 'PlatformOperator' });
  assert.ok(screen.getByTestId('media-filter-customer'));
});

test('时间范围倒置时失败关闭且不发起筛选', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  fireEvent.change(screen.getByTestId('media-filter-from'), { target: { value: '2026-09-02T10:00' } });
  fireEvent.change(screen.getByTestId('media-filter-to'), { target: { value: '2026-09-01T10:00' } });
  assert.ok(screen.getByText('起始时间不得晚于截止时间'));
  assert.equal((screen.getByTestId('media-filter-search') as HTMLButtonElement).disabled, true);
  await user.click(screen.getByTestId('media-filter-search'));
  assert.deepEqual(calls.filterApplied, []);
});

test('手动刷新回源（获取最新设备媒体）', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('media-refresh'));
  assert.equal(calls.refreshed, 1);
});

// ---------- 受控查看与下载 ----------

test('图片查看：实时签发短期 URL → img 渲染 + 下载链接 + 有效期提示', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('media-open-med-001'));
  assert.deepEqual(calls.urlRequested, ['med-001']);
  const image = await screen.findByTestId('media-preview-image');
  assert.equal(image.getAttribute('src'), 'https://s3.example.com/presigned-get/med-001');
  const link = screen.getByTestId('media-download-link');
  assert.equal(link.getAttribute('href'), 'https://s3.example.com/presigned-get/med-001');
  assert.equal(link.getAttribute('download'), 'snapshot-001.jpg');
  assert.ok(screen.getByText(/链接有效期至/));
});

test('视频查看：录制文件受控查看（video 元素）；页面无实时流语义', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByTestId('media-open-med-002'));
  const video = await screen.findByTestId('media-preview-video');
  assert.ok(video.hasAttribute('controls'));
  // DEC-009：无实时/直播/RTSP 字样，无播放/停止按钮
  const pageText = screen.getByTestId('media-page').textContent ?? '';
  assert.ok(!/实时画面|直播|RTSP/i.test(pageText));
  assert.equal(within(screen.getByTestId('media-page')).queryByRole('button', { name: /^(播放|停止)$/ }), null);
});

test('DELETED：不提供查看/下载，仅元数据保留', () => {
  renderPage();
  assert.equal(screen.queryByTestId('media-open-med-003'), null);
  assert.ok(screen.getByTestId('media-deleted-med-003').textContent?.includes('元数据保留'));
});

test('链接过期后重新申请：注入时钟判定过期 → 重新申请实时重签', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({
    now: () => new Date('2026-09-06T04:20:00Z'),
    onRequestDownloadUrl: async (mediaId) => {
      calls.urlRequested.push(mediaId);
      return makeDownloadUrl({ mediaId, downloadUrlExpiresAt: '2026-09-06T04:15:00Z' });
    },
  });
  await user.click(screen.getByTestId('media-open-med-001'));
  // URL 04:15 过期，当前 04:20 → 过期提示 + 重新申请
  await screen.findByTestId('media-url-expired');
  assert.ok(screen.getByText(/下载链接已过期/));
  await user.click(screen.getByTestId('media-url-renew'));
  assert.deepEqual(calls.urlRequested, ['med-001', 'med-001']);
});

test('关闭预览即弃用授权 URL（不持久缓存）：重开重新申请', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  await user.click(screen.getByTestId('media-open-med-001'));
  await screen.findByTestId('media-preview-image');
  await user.keyboard('{Escape}');
  assert.equal(screen.queryByTestId('media-preview-modal'), null);
  await user.click(screen.getByTestId('media-open-med-001'));
  await screen.findByTestId('media-preview-image');
  assert.deepEqual(calls.urlRequested, ['med-001', 'med-001']);
});

test('未知媒体类型安全降级：不渲染 img/video、不提供下载，仅元数据', async () => {
  const user = userEvent.setup();
  renderPage({
    media: {
      rows: [makeMedia({ mediaId: 'med-x', mediaType: 'AUDIO' as MediaView['mediaType'], fileName: 'odd.bin' })],
      nextCursor: null,
    },
  });
  // 列表文案降级为“未知类型”
  assert.ok(screen.getByText('未知类型'));
  await user.click(screen.getByTestId('media-open-med-x'));
  await screen.findByTestId('media-type-fallback');
  assert.ok(screen.getByTestId('media-type-fallback').textContent?.includes('仅展示元数据'));
  assert.equal(screen.queryByTestId('media-preview-image'), null);
  assert.equal(screen.queryByTestId('media-preview-video'), null);
  assert.equal(screen.queryByTestId('media-download-link'), null);
});

// ---------- 越权与错误 ----------

test('跨 Customer 资源不可访问：列表 403 → 无权界面；下载 404 → 错误可读并可重试', async () => {
  const user = userEvent.setup();
  const { unmount } = renderPage({
    media: { rows: null, error: new ForbiddenError('FORBIDDEN', 'The caller is not allowed', 'req-403') },
  });
  assert.ok(screen.getByTestId('error-forbidden').textContent?.includes('无权访问'));
  assert.ok(screen.getByText('requestId：req-403'));
  unmount();

  // 下载 404（跨 Customer 或已删除）：错误呈现 + 可重新申请
  let fail = true;
  const calls: string[] = [];
  renderPage({
    media: { rows: [makeMedia()], nextCursor: null },
    onRequestDownloadUrl: async (mediaId) => {
      calls.push(mediaId);
      if (fail) throw new ApiClientError(404, 'NOT_FOUND', 'Media not found', 'req-404');
      return makeDownloadUrl({ mediaId });
    },
  });
  await user.click(screen.getByTestId('media-open-med-001'));
  await screen.findByTestId('media-url-error');
  assert.ok(screen.getByText('Media not found'));
  assert.ok(screen.getByText('requestId：req-404'));
  fail = false;
  await user.click(screen.getByTestId('media-url-request'));
  await screen.findByTestId('media-preview-image');
  assert.deepEqual(calls, ['med-001', 'med-001']);
});

// ---------- 纯逻辑与 API 装配 ----------

test('过期判定与类型守卫边界', () => {
  const now = new Date('2026-09-06T04:15:00Z');
  assert.equal(isDownloadUrlExpired('2026-09-06T04:15:00Z', now), true);
  assert.equal(isDownloadUrlExpired('2026-09-06T04:15:01Z', now), false);
  assert.equal(isDownloadUrlExpired('not-a-date', now), true);
  assert.equal(DOWNLOAD_URL_TTL_SEC, 900);
  assert.equal(isKnownMediaType('IMAGE'), true);
  assert.equal(isKnownMediaType('AUDIO'), false);
  assert.equal(mediaTypeLabel('VIDEO'), '视频');
  assert.equal(mediaTypeLabel('AUDIO'), '未知类型');
  assert.equal(localDateTimeToUtcIso('', 'Asia/Shanghai'), null);
  assert.equal(localDateTimeToUtcIso('garbage', 'Asia/Shanghai'), null);
});

function stubApi(): { api: ApiClient; calls: { path: string; options: ApiRequestOptions }[] } {
  const calls: { path: string; options: ApiRequestOptions }[] = [];
  const api: ApiClient = {
    request: async <T,>(path: string, options: ApiRequestOptions = {}) => {
      calls.push({ path, options });
      return { data: {}, meta: {} } as T;
    },
  };
  return { api, calls };
}

test('API 装配：listMedia 查询串；download-url 路径', async () => {
  const { api, calls } = stubApi();
  await listMedia(
    api,
    {
      deviceId: 'dev-1',
      mediaType: 'IMAGE',
      status: 'AVAILABLE',
      customerId: 'c1',
      from: '2026-09-01T00:00:00Z',
      to: null,
    },
    'cur-1',
  );
  assert.equal(
    calls[0]?.path,
    '/admin/media?deviceId=dev-1&mediaType=IMAGE&status=AVAILABLE&customerId=c1&from=2026-09-01T00%3A00%3A00Z&cursor=cur-1',
  );

  await createMediaDownloadUrl(api, 'med-1');
  assert.equal(calls[1]?.path, '/admin/media/med-1/download-url');
  assert.equal(calls[1]?.options.method, undefined);
});
