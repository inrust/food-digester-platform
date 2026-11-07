// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LiveImagePreview } from '../src/pages/devices/LiveImagePreview.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { ApiClientError } from '../src/api/errors.js';
import { I18nProvider } from '../src/i18n/i18n.js';
const streamId = '10000000-0000-4000-8000-000000000001',
  frameId = '20000000-0000-4000-8000-000000000001';
let visible = 'visible';
beforeEach(() => {
  visible = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible as DocumentVisibilityState);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
function fixture() {
  let fail = false;
  const request = vi.fn(async (_path: string, options: ApiRequestOptions = {}) => {
    if (options.method === 'DELETE') return undefined;
    if (fail) throw new ApiClientError(403, 'FORBIDDEN', 'denied');
    const at = Date.now();
    return {
      data:
        options.method === 'PUT'
          ? {
              streamId,
              leaseExpiresAt: new Date(at + 30000).toISOString(),
              renewAfterSeconds: 10,
              readIntervalMs: 2000,
            }
          : {
              state: 'READY',
              streamId,
              frameId,
              mimeType: 'image/jpeg',
              imageBase64: '/9j/2Q==',
              capturedAt: new Date(at).toISOString(),
              expiresAt: new Date(at + 10000).toISOString(),
            },
      meta: { timestamp: new Date(at).toISOString(), requestId: 'r' },
    };
  });
  const api = { request: request as ApiClient['request'] };
  return {
    api,
    request,
    fail: () => {
      fail = true;
    },
  };
}
const open = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('live-image-toggle'));
  });
};
test('entry starts closed, displays JPEG only while open, and close/unmount releases without persisting a frame', async () => {
  const f = fixture();
  const view = render(<LiveImagePreview api={f.api} deviceId="d-one" label="Device one" />);
  expect(f.request).not.toHaveBeenCalled();
  expect(screen.queryByTestId('live-image-frame')).toBeNull();
  await open();
  expect(screen.getByTestId('live-image-frame').getAttribute('src')).toBe('data:image/jpeg;base64,/9j/2Q==');
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  await open();
  expect(screen.queryByTestId('live-image-frame')).toBeNull();
  expect(f.request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  await open();
  view.unmount();
  expect(f.request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
});
test('hidden tab stops immediately and visible tab obtains a new viewer before showing any frame', async () => {
  const f = fixture();
  render(<LiveImagePreview api={f.api} deviceId="d-one" label="Device one" />);
  await open();
  const old = f.request.mock.calls.find((call) => call[1]?.method === 'PUT')![0];
  await act(async () => {
    visible = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(screen.queryByTestId('live-image-frame')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('暂停');
  expect(f.request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  await act(async () => {
    visible = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const next = f.request.mock.calls.filter((call) => call[1]?.method === 'PUT').at(-1)![0];
  expect(next).not.toBe(old);
  expect(screen.getByTestId('live-image-frame')).toBeTruthy();
});
test('pagehide releases, pageshow reacquires, and switching device resets to closed', async () => {
  const f = fixture(),
    view = render(<LiveImagePreview api={f.api} deviceId="d-one" label="One" />);
  await open();
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(screen.queryByTestId('live-image-frame')).toBeNull();
  expect(f.request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  await act(async () => {
    window.dispatchEvent(new Event('pageshow'));
  });
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(2);
  view.rerender(<LiveImagePreview api={f.api} deviceId="d-two" label="Two" />);
  expect(screen.queryByTestId('live-image-frame')).toBeNull();
  expect(screen.getByTestId('live-image-toggle').textContent).toContain('打开');
  await open();
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT').at(-1)![0]).toContain('/d-two/');
});
test('opening while already hidden makes no request until visible', async () => {
  visible = 'hidden';
  const f = fixture();
  render(<LiveImagePreview api={f.api} deviceId="d-one" label="One" />);
  await open();
  expect(f.request).not.toHaveBeenCalled();
  expect(screen.queryByTestId('live-image-frame')).toBeNull();
  await act(async () => {
    visible = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(screen.getByTestId('live-image-frame')).toBeTruthy();
});
test('authorization failure stops with no frame and an explicit user reconnect action', async () => {
  const f = fixture();
  f.fail();
  render(<LiveImagePreview api={f.api} deviceId="d-one" label="One" />);
  await open();
  expect(screen.queryByTestId('live-image-frame')).toBeNull();
  expect(screen.getByTestId('error-forbidden')).toBeTruthy();
  expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy();
});
test('English UI uses translated labels and decode error stops the lease', async () => {
  const f = fixture();
  render(
    <I18nProvider initialLanguage="en">
      <LiveImagePreview api={f.api} deviceId="d-one" label="One" />
    </I18nProvider>,
  );
  expect(screen.getByRole('button', { name: 'Open image preview' })).toBeTruthy();
  await open();
  await act(async () => {
    fireEvent.error(screen.getByTestId('live-image-frame'));
  });
  expect(screen.queryByTestId('live-image-frame')).toBeNull();
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  expect(f.request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
});

test.each(['en', 'zh-CN'] as const)(
  'terminal permission denial stays stopped across visibility changes with localized copy (%s)',
  async (language) => {
    const f = fixture();
    f.fail();
    render(
      <I18nProvider initialLanguage={language}>
        <LiveImagePreview api={f.api} deviceId="d-one" label="One" />
      </I18nProvider>,
    );
    await open();
    expect(screen.getByRole('alert').textContent).toContain(language === 'en' ? 'access was revoked' : '权限已失效');
    expect(screen.getByRole('alert').textContent).not.toContain('denied');
    const count = f.request.mock.calls.length;
    await act(async () => {
      visible = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      visible = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(f.request).toHaveBeenCalledTimes(count);
    expect(screen.queryByTestId('live-image-frame')).toBeNull();
  },
);
test('frame expiry has its own localized state even while the next read is stalled', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const original = f.api.request;
    let reads = 0;
    f.api.request = async <T,>(path: string, options: ApiRequestOptions = {}) => {
      if (!options.method && reads++ > 0) return new Promise<T>(() => {});
      return original<T>(path, options);
    };
    render(<LiveImagePreview api={f.api} deviceId="d-one" label="One" />);
    await open();
    expect(screen.getByTestId('live-image-frame')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.queryByTestId('live-image-frame')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('画面已过期');
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
test('rate-limit waiting survives hiding and reopening; old image is cleared immediately', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const original = f.api.request;
    let reads = 0;
    f.api.request = async <T,>(path: string, options: ApiRequestOptions = {}) => {
      if (!options.method && reads++ === 1)
        throw new ApiClientError(429, 'RATE_LIMITED', 'private server detail', 'r', 15000);
      return original<T>(path, options);
    };
    render(<LiveImagePreview api={f.api} deviceId="d-one" label="One" />);
    await open();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByTestId('live-image-frame')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('自动重连');
    expect(screen.queryByText(/private server detail/)).toBeNull();
    await act(async () => {
      visible = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      visible = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await open();
    await open(); // Close/reopen still preserves the rate-limit deadline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14999);
    });
    expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(2);
    expect(screen.getByTestId('live-image-frame')).toBeTruthy();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test('batched pagehide/pageshow cannot leave a visible preview with its old stopped engine', async () => {
  const f = fixture();
  render(<LiveImagePreview api={f.api} deviceId="d-one" label="One" />);
  await open();
  const first = f.request.mock.calls.find((call) => call[1]?.method === 'PUT')![0];
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
  });
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(2);
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT').at(-1)![0]).not.toBe(first);
  expect(screen.getByTestId('live-image-frame')).toBeTruthy();
});
test('batched close/reopen restarts one engine and still uses a fresh viewer', async () => {
  const f = fixture();
  render(<LiveImagePreview api={f.api} deviceId="d-one" label="One" />);
  await open();
  await act(async () => {
    fireEvent.click(screen.getByTestId('live-image-toggle'));
    fireEvent.click(screen.getByTestId('live-image-toggle'));
  });
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(2);
  expect(screen.getByTestId('live-image-frame')).toBeTruthy();
});
