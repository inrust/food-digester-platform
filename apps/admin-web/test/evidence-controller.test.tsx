// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { AlarmsController } from '../src/app/feature-controllers.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import type { SessionSnapshot } from '../src/session/session-manager.js';
import type { AlarmView } from '../src/pages/alarms/types.js';
const session: SessionSnapshot = { username: 'viewer', customerId: 'cust-a', roles: ['CustomerViewer'] };
const evidence = { mediaId: 'original-image', captureTime: '2026-11-07T00:00:00Z', status: 'AVAILABLE' as const };
const original: AlarmView = {
  alarmId: 'alarm-one',
  customerId: 'cust-a',
  deviceId: 'device-a',
  code: 'HIGH_TEMP',
  category: 'TEMP',
  severity: 'MAJOR',
  status: 'ACTIVE',
  detectedTime: evidence.captureTime,
  component: null,
  currentValue: null,
  threshold: null,
  unit: null,
  message: null,
  recommendedAction: null,
  acknowledgedBy: null,
  acknowledgedAt: null,
  acknowledgeReason: null,
  clearedBy: null,
  clearedAt: null,
  clearReason: null,
  createdAt: evidence.captureTime,
  updatedAt: evidence.captureTime,
  evidenceImage: evidence,
};
const download = {
  mediaId: evidence.mediaId,
  downloadUrl: 'https://archive.invalid/original.jpg',
  downloadUrlExpiresAt: '2099-01-01T00:00:00Z',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(handler?: (path: string, options: ApiRequestOptions) => Promise<unknown>) {
  let alarm = original;
  const request = vi.fn(async (path: string, options: ApiRequestOptions = {}) => {
    if (handler) {
      const result = await handler(path, options);
      if (result !== undefined) return result;
    }
    if (path.endsWith('/clear')) {
      alarm = { ...alarm, status: 'CLEARED', clearedAt: evidence.captureTime };
      return { data: { ...alarm, replayed: false } };
    }
    if (path.endsWith('/download-url')) return { data: download };
    if (path === '/admin/alarms/alarm-one') return { data: alarm };
    if (path.startsWith('/admin/alarms')) return { data: [alarm], meta: { nextCursor: null } };
    return { data: [], meta: { nextCursor: null } };
  });
  return { api: { request: request as ApiClient['request'] }, request };
}
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/alarms');
});
async function select() {
  const button = await screen.findByTestId('alarm-detail-alarm-one');
  await act(async () => {
    fireEvent.click(button);
  });
}
async function open() {
  const button = await screen.findByTestId('evidence-open-alarm-one');
  await act(async () => {
    fireEvent.click(button);
  });
}
test('real controller wires signed URL and clear+refresh keeps the same original image readable', async () => {
  const f = fixture();
  render(
    <AlarmsController
      api={f.api}
      session={{ ...session, roles: ['PlatformOperator'], customerId: null }}
      search=""
      onNavigate={() => {}}
    />,
  );
  await select();
  await open();
  expect(screen.getByTestId('evidence-image')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '关闭图片' }));
  });
  const user = userEvent.setup();
  await user.click(screen.getByTestId('alarm-clear'));
  const dialog = screen.getByTestId('confirm-dialog');
  await user.type(within(dialog).getByLabelText('清除原因'), 'Resolved');
  await user.click(within(dialog).getByRole('button', { name: '确认清除' }));
  expect((await screen.findByTestId('detail-status')).textContent).toBe('已清除');
  await open();
  expect(screen.getByTestId('evidence-image')).toBeTruthy();
  const calls = f.request.mock.calls.filter((call) => call[0].endsWith('/download-url'));
  expect(calls).toHaveLength(2);
  expect(
    calls.every((call) => call[0] === '/admin/media/original-image/download-url' && call[1]?.cache === 'no-store'),
  ).toBe(true);
});
test('tenant change unmounts pending evidence, and a late old signed URL never appears in the new scope', async () => {
  const pending = deferred<{ data: typeof download }>();
  const f = fixture(async (path) => (path.endsWith('/download-url') ? pending.promise : undefined));
  const view = render(<AlarmsController api={f.api} session={session} search="" onNavigate={() => {}} />);
  await select();
  await open();
  const signal = f.request.mock.calls.find((call) => call[0].endsWith('/download-url'))![1]!.signal!;
  view.rerender(
    <AlarmsController api={f.api} session={{ ...session, customerId: 'cust-b' }} search="" onNavigate={() => {}} />,
  );
  expect(signal.aborted).toBe(true);
  await act(async () => {
    pending.resolve({ data: download });
  });
  expect(screen.queryByTestId('evidence-modal')).toBeNull();
  expect(screen.queryByTestId('alarm-detail')).toBeNull();
});
test('latest request for the same alarm wins over an older detail response', async () => {
  const first = deferred<{ data: AlarmView }>();
  let reads = 0;
  const f = fixture(async (path) =>
    path === '/admin/alarms/alarm-one'
      ? reads++ === 0
        ? first.promise
        : { data: { ...original, evidenceImage: { ...evidence, status: 'DELETED' } } }
      : undefined,
  );
  render(<AlarmsController api={f.api} session={session} search="" onNavigate={() => {}} />);
  await select();
  await select();
  expect(screen.getByTestId('evidence-deleted')).toBeTruthy();
  await act(async () => {
    first.resolve({ data: original });
  });
  expect(screen.getByTestId('evidence-deleted')).toBeTruthy();
  expect(screen.queryByTestId('evidence-open-alarm-one')).toBeNull();
});
test('filter change discards old pending event pages', async () => {
  const old = deferred<{ data: unknown[]; meta: { nextCursor: null } }>();
  const f = fixture(async (path) =>
    path.startsWith('/admin/events')
      ? path.includes('deviceId=old')
        ? old.promise
        : { data: [], meta: { nextCursor: null } }
      : undefined,
  );
  const view = render(
    <AlarmsController api={f.api} session={session} search="?tab=event&deviceId=old" onNavigate={() => {}} />,
  );
  await act(async () => {});
  view.rerender(
    <AlarmsController api={f.api} session={session} search="?tab=event&deviceId=new" onNavigate={() => {}} />,
  );
  await act(async () => {});
  await act(async () => {
    old.resolve({
      data: [
        {
          eventId: 'stale-event',
          deviceId: 'old',
          customerId: 'cust-a',
          eventType: 'STALE',
          occurredAt: evidence.captureTime,
          evidenceImage: evidence,
        },
      ],
      meta: { nextCursor: null },
    });
  });
  expect(screen.queryByText('STALE')).toBeNull();
  expect(screen.queryByTestId('evidence-open-stale-event')).toBeNull();
});
test('changing the source filter closes the current evidence modal before loading a new list', async () => {
  const f = fixture();
  const view = render(<AlarmsController api={f.api} session={session} search="" onNavigate={() => {}} />);
  await select();
  await open();
  expect(screen.getByTestId('evidence-image')).toBeTruthy();
  view.rerender(<AlarmsController api={f.api} session={session} search="?deviceId=other" onNavigate={() => {}} />);
  expect(screen.queryByTestId('evidence-image')).toBeNull();
  expect(screen.queryByTestId('alarm-detail')).toBeNull();
});
test('manual refresh discovers a late association without signing until the user opens it', async () => {
  let linked = false;
  const f = fixture(async (path) =>
    path === '/admin/alarms/alarm-one' ? { data: { ...original, evidenceImage: linked ? evidence : null } } : undefined,
  );
  render(<AlarmsController api={f.api} session={session} search="" onNavigate={() => {}} />);
  await select();
  expect(screen.getByTestId('evidence-unlinked')).toBeTruthy();
  linked = true;
  await act(async () => {
    fireEvent.click(screen.getByTestId('alarm-refresh'));
  });
  expect(screen.getByTestId('evidence-open-alarm-one')).toBeTruthy();
  expect(f.request.mock.calls.filter((call) => call[0].endsWith('/download-url'))).toHaveLength(0);
  await open();
  expect(screen.getByTestId('evidence-image')).toBeTruthy();
});
