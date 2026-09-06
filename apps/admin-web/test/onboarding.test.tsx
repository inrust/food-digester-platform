// @vitest-environment jsdom
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError } from '../src/api/errors.js';
import { OnboardingReviewPanel } from '../src/pages/onboarding/OnboardingReviewPanel.js';
import type { OnboardingReviewPanelProps } from '../src/pages/onboarding/OnboardingReviewPanel.js';
import { isReviewable } from '../src/pages/onboarding/onboarding-state.js';
import type { OnboardingRequestView } from '../src/pages/onboarding/types.js';

afterEach(cleanup);

function makeRequest(overrides: Partial<OnboardingRequestView> = {}): OnboardingRequestView {
  return {
    requestId: 'req-1',
    serialNumber: 'SN-2026-001',
    model: 'FD-100',
    hardwareVersion: 'HW-1.2',
    manufacturer: 'BioNexa',
    manufactureDate: '2026-08-01',
    status: 'PENDING',
    rejectReason: null,
    reviewedBy: null,
    reviewedAt: null,
    version: 1,
    createdAt: '2026-09-05T02:00:00Z',
    ...overrides,
  };
}

function renderPanel(overrides: Partial<OnboardingReviewPanelProps> = {}) {
  const calls = {
    approved: [] as OnboardingRequestView[],
    rejected: [] as { request: OnboardingRequestView; reason: string }[],
    navigated: [] as string[],
    refreshed: [] as null[],
  };
  const props: OnboardingReviewPanelProps = {
    activeStatus: 'PENDING',
    onFilterStatus: () => {},
    list: { rows: [makeRequest()], nextCursor: null },
    onLoadMore: () => {},
    onRefresh: () => {
      calls.refreshed.push(null);
    },
    detail: { kind: 'ready', request: makeRequest() },
    onSelect: () => {},
    onCloseDetail: () => {},
    canReview: true,
    onApprove: async (request) => {
      calls.approved.push(request);
      return { ...request, status: 'APPROVED' };
    },
    onReject: async (request, reason) => {
      calls.rejected.push({ request, reason });
      return { ...request, status: 'REJECTED', rejectReason: reason };
    },
    onNavigate: (path) => calls.navigated.push(path),
    ...overrides,
  };
  const utils = render(<OnboardingReviewPanel {...props} />);
  return { ...calls, unmount: utils.unmount };
}

test('列表与状态筛选：PENDING/APPROVED/REJECTED 标签与状态列', () => {
  renderPanel({
    list: {
      rows: [
        makeRequest(),
        makeRequest({ requestId: 'req-2', status: 'APPROVED' }),
        makeRequest({ requestId: 'req-3', status: 'REJECTED' }),
      ],
      nextCursor: null,
    },
  });
  assert.equal(screen.getByTestId('tab-PENDING').textContent, '待审批');
  assert.equal(screen.getByTestId('tab-APPROVED').textContent, '已通过');
  assert.equal(screen.getByTestId('tab-REJECTED').textContent, '已拒绝');
  assert.equal(screen.getByTestId('status-req-1').textContent, '待审批');
  assert.equal(screen.getByTestId('status-req-2').textContent, '已通过');
  assert.equal(screen.getByTestId('status-req-3').textContent, '已拒绝');
});

test('详情：设备资料与申请信息完整；REJECTED 显示拒绝原因', () => {
  renderPanel({
    detail: {
      kind: 'ready',
      request: makeRequest({
        status: 'REJECTED',
        rejectReason: '资料不符',
        reviewedBy: 'admin-1',
        reviewedAt: '2026-09-05T03:00:00Z',
      }),
    },
  });
  const detail = screen.getByTestId('request-detail');
  for (const text of ['SN-2026-001', 'FD-100', 'HW-1.2', 'BioNexa', '2026-08-01']) {
    assert.ok(detail.textContent?.includes(text), `详情缺少 ${text}`);
  }
  assert.equal(screen.getByTestId('detail-status').textContent, '已拒绝');
  assert.equal(screen.getByTestId('detail-reject-reason').textContent, '资料不符');
});

test('权限门控：仅 canReview（SuperAdmin）且 PENDING 显示审批操作', () => {
  const { unmount } = renderPanel({ canReview: false });
  assert.equal(screen.queryByTestId('approve-button'), null);
  assert.equal(screen.queryByTestId('reject-button'), null);
  unmount();

  renderPanel({ canReview: true, detail: { kind: 'ready', request: makeRequest({ status: 'APPROVED' }) } });
  assert.equal(screen.queryByTestId('approve-button'), null);
  assert.equal(screen.queryByTestId('reject-button'), null);
});

test('批准：确认后提交并跳转设备详情（携带序列号，不伪造设备记录）', async () => {
  const user = userEvent.setup();
  const calls = renderPanel();
  await user.click(screen.getByTestId('approve-button'));
  await user.click(screen.getByRole('button', { name: '确认批准' }));
  await waitFor(() => {
    assert.equal(calls.approved.length, 1);
  });
  assert.equal(calls.approved[0]?.version, 1);
  assert.deepEqual(calls.navigated, ['/devices/manage?serialNumber=SN-2026-001']);
});

test('拒绝：原因必填；提交后刷新列表', async () => {
  const user = userEvent.setup();
  const calls = renderPanel();
  await user.click(screen.getByTestId('reject-button'));
  const confirm = screen.getByRole('button', { name: '确认拒绝' }) as HTMLButtonElement;
  assert.ok(confirm.disabled);
  await user.type(screen.getByLabelText('拒绝原因'), '序列号与库存不符');
  await user.click(screen.getByRole('button', { name: '确认拒绝' }));
  await waitFor(() => {
    assert.equal(calls.rejected.length, 1);
  });
  assert.equal(calls.rejected[0]?.reason, '序列号与库存不符');
  assert.equal(calls.refreshed.length, 1);
});

test('重复点击不会重复审批：在途期间后续提交被忽略', async () => {
  const user = userEvent.setup();
  let release!: () => void;
  const approved: OnboardingRequestView[] = [];
  renderPanel({
    onApprove: (request) => {
      approved.push(request);
      return new Promise<OnboardingRequestView>((resolve) => {
        release = () => resolve({ ...request, status: 'APPROVED' });
      });
    },
  });
  await user.click(screen.getByTestId('approve-button'));
  await user.click(screen.getByRole('button', { name: '确认批准' }));
  // 在途：再次打开并确认（对话框已关闭，按钮 busy 禁用；直接重复触发 runAction 入口不可达）
  assert.ok((screen.getByTestId('approve-button') as HTMLButtonElement).disabled);
  release();
  await waitFor(() => assert.equal(approved.length, 1));
});

test('并发审批冲突：409 VERSION_CONFLICT 显示刷新提示', async () => {
  const user = userEvent.setup();
  renderPanel({
    onApprove: async () => {
      throw new ApiClientError(409, 'VERSION_CONFLICT', 'modified', 'req-409');
    },
  });
  await user.click(screen.getByTestId('approve-button'));
  await user.click(screen.getByRole('button', { name: '确认批准' }));
  await waitFor(() => {
    assert.ok(screen.getByTestId('error-version-conflict'));
  });
  assert.ok(screen.getByTestId('error-version-conflict').textContent?.includes('数据已被他人修改'));
});

test('私钥零泄露：页面 DOM 不含 privateKey/PEM 关键词', () => {
  renderPanel({
    detail: { kind: 'ready', request: makeRequest() },
  });
  const pageText = document.body.textContent ?? '';
  assert.notMatch(pageText, /privateKey|private_key|BEGIN [A-Z ]*PRIVATE KEY/i);
});

test('isReviewable：仅 PENDING 可审批', () => {
  assert.equal(isReviewable('PENDING'), true);
  assert.equal(isReviewable('APPROVED'), false);
  assert.equal(isReviewable('REJECTED'), false);
});
