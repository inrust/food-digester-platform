// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EvidenceImageEntry } from '../src/pages/alarms/EvidenceImageEntry.js';
import type { EvidenceImage } from '@fdp/contracts/rest/image-types.js';
import { ApiClientError, UnauthenticatedError } from '../src/api/errors.js';
import type { MediaDownloadUrlView } from '../src/pages/media/types.js';
import { I18nProvider } from '../src/i18n/i18n.js';
const evidence: EvidenceImage = { mediaId: 'media-one', captureTime: '2026-11-07T00:00:00Z', status: 'AVAILABLE' };
const download = (id = evidence.mediaId, ttl = 900000): MediaDownloadUrlView => ({
  mediaId: id,
  downloadUrl: `https://archive.invalid/${id}.jpg?signature=local`,
  downloadUrlExpiresAt: new Date(Date.now() + ttl).toISOString(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const open = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('evidence-open-source'));
  });
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

test.each([
  ['noPermission', false, evidence],
  ['unlinked', true, null],
  ['notProvided', true, undefined],
  ['deleted', true, { ...evidence, status: 'DELETED' as const }],
] as const)('state %s never requests or exposes a signed URL', async (status, canRead, item) => {
  const requestUrl = vi.fn(async () => download());
  render(<EvidenceImageEntry sourceId="source" evidence={item} canRead={canRead} requestUrl={requestUrl} />);
  expect(screen.getByTestId(`evidence-${status}`)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('img')).toBeNull();
  expect(requestUrl).not.toHaveBeenCalled();
  if (!canRead) expect(document.body.textContent).not.toContain(evidence.captureTime);
});
test('AVAILABLE uses only explicit authorized access; close discards the URL and reopen obtains a new link', async () => {
  const requestUrl = vi.fn(async () => download());
  render(<EvidenceImageEntry sourceId="source" evidence={evidence} canRead requestUrl={requestUrl} />);
  expect(requestUrl).not.toHaveBeenCalled();
  await open();
  expect(screen.getByTestId('evidence-image').getAttribute('src')).toContain('https://archive.invalid/media-one.jpg');
  expect(requestUrl).toHaveBeenCalledWith('media-one', expect.any(AbortSignal));
  expect(screen.getByRole('link', { name: '下载图片' }).getAttribute('rel')).toBe('noreferrer');
  expect([...Object.values(localStorage), ...Object.values(sessionStorage)].join('')).not.toContain('signature=local');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '关闭图片' }));
  });
  expect(screen.queryByTestId('evidence-image')).toBeNull();
  await open();
  expect(requestUrl).toHaveBeenCalledTimes(2);
});
test.each([
  [new ApiClientError(403, 'FORBIDDEN', 'private server detail'), '读取权限'],
  [new ApiClientError(404, 'NOT_FOUND', 'private server detail'), '权限范围'],
  [new UnauthenticatedError(), '登录已失效'],
])('authorization or missing media stops without an automatic download retry: %s', async (error, copy) => {
  const requestUrl = vi.fn(async () => {
    throw error;
  });
  render(<EvidenceImageEntry sourceId="source" evidence={evidence} canRead requestUrl={requestUrl} />);
  await open();
  expect(screen.getByRole('alert').textContent).toContain(copy);
  expect(screen.getByRole('alert').textContent).not.toContain('private server detail');
  expect(screen.queryByRole('button', { name: '重新申请链接' })).toBeNull();
  expect(screen.queryByTestId('evidence-image')).toBeNull();
  expect(requestUrl).toHaveBeenCalledTimes(1);
});
test('network failure and image load failure are explicit and manually re-sign instead of retaining a broken link', async () => {
  let failed = true;
  const requestUrl = vi.fn(async () => {
    if (failed) throw new Error('offline');
    return download();
  });
  render(<EvidenceImageEntry sourceId="source" evidence={evidence} canRead requestUrl={requestUrl} />);
  await open();
  expect(screen.getByRole('alert').textContent).toContain('无法获取');
  failed = false;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '重新申请链接' }));
  });
  fireEvent.error(screen.getByTestId('evidence-image'));
  expect(screen.getByRole('alert').textContent).toContain('图片加载失败');
  expect(screen.queryByRole('link')).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '重新申请链接' }));
  });
  expect(requestUrl).toHaveBeenCalledTimes(3);
  expect(screen.getByTestId('evidence-image')).toBeTruthy();
});
test('URL expiry independently removes image and download link and requires fresh authorization', async () => {
  vi.useFakeTimers();
  const requestUrl = vi.fn(async () => download('media-one', 1000));
  render(<EvidenceImageEntry sourceId="source" evidence={evidence} canRead requestUrl={requestUrl} />);
  await open();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(screen.getByTestId('evidence-image')).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.queryByTestId('evidence-image')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('过期');
  expect(requestUrl).toHaveBeenCalledTimes(1);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '重新申请链接' }));
  });
  expect(requestUrl).toHaveBeenCalledTimes(2);
});
test.each(['source', 'permission', 'deleted', 'association', 'close'] as const)(
  'pending response cannot revive an image after %s changes',
  async (kind) => {
    const pending = deferred<MediaDownloadUrlView>();
    let signal: AbortSignal | undefined;
    const requestUrl = vi.fn(async (_id: string, value?: AbortSignal) => {
      signal = value;
      return pending.promise;
    });
    const view = render(<EvidenceImageEntry sourceId="source" evidence={evidence} canRead requestUrl={requestUrl} />);
    await open();
    if (kind === 'close') fireEvent.click(screen.getByRole('button', { name: '关闭图片' }));
    else
      view.rerender(
        <EvidenceImageEntry
          sourceId={kind === 'source' ? 'other' : 'source'}
          evidence={
            kind === 'deleted'
              ? { ...evidence, status: 'DELETED' }
              : kind === 'association'
                ? { ...evidence, mediaId: 'other-media' }
                : evidence
          }
          canRead={kind !== 'permission'}
          requestUrl={requestUrl}
        />,
      );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(download());
    });
    expect(screen.queryByTestId('evidence-image')).toBeNull();
    expect(screen.queryByTestId('evidence-modal')).toBeNull();
  },
);
test('timeout exits an unresponsive transport and its late result cannot replace a successful manual retry', async () => {
  vi.useFakeTimers();
  const pending = deferred<MediaDownloadUrlView>();
  let calls = 0;
  const requestUrl = vi.fn(async () => (calls++ === 0 ? pending.promise : download()));
  render(<EvidenceImageEntry sourceId="source" evidence={evidence} canRead requestUrl={requestUrl} />);
  await open();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12000);
  });
  expect(screen.getByRole('alert').textContent).toContain('无法获取');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '重新申请链接' }));
  });
  await act(async () => {
    pending.resolve(download('other'));
  });
  expect(screen.getByTestId('evidence-image').getAttribute('src')).toContain('media-one.jpg');
});
test.each(['identity', 'scheme', 'credentials', 'expiry', 'already-expired'] as const)(
  'invalid download %s never renders a resource',
  async (kind) => {
    const reply = download();
    const requestUrl = vi.fn(async () => ({
      ...reply,
      ...(kind === 'identity' ? { mediaId: 'other' } : {}),
      ...(kind === 'scheme' ? { downloadUrl: 'javascript:alert(1)' } : {}),
      ...(kind === 'credentials' ? { downloadUrl: 'https://user:pass@archive.invalid/a.jpg' } : {}),
      ...(kind === 'expiry' ? { downloadUrlExpiresAt: 'bad' } : {}),
      ...(kind === 'already-expired' ? { downloadUrlExpiresAt: new Date(Date.now() - 1).toISOString() } : {}),
    }));
    render(<EvidenceImageEntry sourceId="source" evidence={evidence} canRead requestUrl={requestUrl} />);
    await open();
    expect(screen.queryByTestId('evidence-image')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  },
);
test('English image failure and access states use translated copy', async () => {
  render(
    <I18nProvider initialLanguage="en">
      <EvidenceImageEntry
        sourceId="source"
        evidence={evidence}
        canRead
        requestUrl={async () => {
          throw new Error('offline');
        }}
      />
    </I18nProvider>,
  );
  await open();
  expect(screen.getByRole('dialog').textContent).toContain('Archived image');
  expect(screen.getByRole('alert').textContent).toContain('Could not obtain');
  expect(screen.getByRole('button', { name: 'Request a new link' })).toBeTruthy();
});
