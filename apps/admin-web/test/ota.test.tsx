// @vitest-environment jsdom
/**
 * FE-13 OTA 页面测试：
 * - 固件上传：元数据字段校验（model/version/size/sha256/signature）→ 上传会话 →
 *   直传 + complete 校验 → VERIFIED 可发布；可发布列表 = VERIFIED；
 * - 坏包（UPLOADED）不可建 Campaign（下拉仅 VERIFIED + 校验函数 + 装配守卫）；
 * - 首批 >1 台前端阻止且装配层拒绝（不发请求）；
 * - 扩大批次支持逐步放量；最终全量须 SuperAdmin、既有 targets 全部成功及精确确认文本；
 * - 暂停/恢复/取消状态流转（幂等回放提示）；动作矩阵终态禁用；
 * - 失败重试（缺省全部 / 勾选子集）；目标状态看板渲染；ota:write 门控。
 */
import { afterEach, assert, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { OtaPackagesPage } from '../src/pages/ota/OtaPackagesPage.js';
import type { OtaPackagesPageProps } from '../src/pages/ota/OtaPackagesPage.js';
import { OtaCampaignsPage } from '../src/pages/ota/OtaCampaignsPage.js';
import type { OtaCampaignsPageProps } from '../src/pages/ota/OtaCampaignsPage.js';
import {
  createFirmwareUpload,
  createOtaCampaign,
  expandOtaCampaignBatch,
  listFirmwarePackages,
  retryOtaCampaignFailures,
} from '../src/pages/ota/ota-api.js';
import { validateBatchExpand, validateCampaignCreate } from '../src/pages/ota/ota-state.js';
import type {
  FirmwarePackageView,
  FirmwareUploadSessionCreate,
  FirmwareUploadSessionView,
  OtaCampaignDetailView,
  OtaCampaignView,
  OtaTargetView,
} from '../src/pages/ota/types.js';

afterEach(cleanup);

const SHA256 = 'a'.repeat(64);

function makePackage(overrides: Partial<FirmwarePackageView> = {}): FirmwarePackageView {
  return {
    packageId: 'pkg-001',
    model: 'FD-100',
    version: '2.4.0',
    packageType: 'FIRMWARE',
    sizeBytes: 1048576,
    sha256: SHA256,
    status: 'VERIFIED',
    objectKey: 'firmware-packages/FD-100/FIRMWARE/2.4.0/pkg-001',
    uploadedBy: 'admin@example.com',
    createdAt: '2026-09-06T02:00:00Z',
    ...overrides,
  };
}

function makeSession(overrides: Partial<FirmwareUploadSessionView> = {}): FirmwareUploadSessionView {
  return {
    packageId: 'pkg-002',
    status: 'UPLOADED',
    model: 'FD-100',
    version: '2.5.0',
    packageType: 'FIRMWARE',
    sizeBytes: 2048,
    sha256: SHA256,
    objectKey: 'firmware-packages/FD-100/FIRMWARE/2.5.0/pkg-002',
    uploadUrl: 'https://s3.example.com/presigned-put',
    uploadUrlExpiresAt: '2026-09-06T03:15:00Z',
    createdAt: '2026-09-06T03:00:00Z',
    ...overrides,
  };
}

function makeCampaign(overrides: Partial<OtaCampaignView> = {}): OtaCampaignView {
  return {
    campaignId: 'camp-001',
    name: '2.4.0 灰度升级',
    packageId: 'pkg-001',
    targetModel: 'FD-100',
    strategy: 'CANARY',
    status: 'RUNNING',
    createdBy: 'admin@example.com',
    finalRolloutApprovedAt: null,
    finalRolloutApprovedBy: null,
    finalRolloutEligibleCount: null,
    createdAt: '2026-09-06T04:00:00Z',
    updatedAt: '2026-09-06T04:00:00Z',
    ...overrides,
  };
}

function makeDetail(overrides: Partial<OtaCampaignDetailView> = {}): OtaCampaignDetailView {
  return {
    ...makeCampaign(),
    targetCounts: {
      total: 3,
      PENDING: 1,
      NOTIFIED: 0,
      DOWNLOADING: 0,
      INSTALLING: 0,
      SUCCEEDED: 1,
      FAILED: 1,
      ROLLED_BACK: 0,
      CANCELLED: 0,
    },
    ...overrides,
  };
}

function makeTarget(overrides: Partial<OtaTargetView> = {}): OtaTargetView {
  return {
    targetId: 'tgt-001',
    campaignId: 'camp-001',
    deviceId: 'dev-001',
    batchNo: 1,
    status: 'SUCCEEDED',
    failureCode: null,
    failureReason: null,
    scheduledTime: null,
    completedAt: '2026-09-06T04:30:00Z',
    createdAt: '2026-09-06T04:00:00Z',
    updatedAt: '2026-09-06T04:30:00Z',
    ...overrides,
  };
}

const ELIGIBLE = [
  { deviceId: 'dev-001', label: 'XJ-2026-001 食堂1号机' },
  { deviceId: 'dev-002', label: 'XJ-2026-002 食堂2号机' },
];

// ---------- 固件包页 ----------

function renderPackagesPage(overrides: Partial<OtaPackagesPageProps> = {}) {
  const calls = {
    sessionCreated: [] as FirmwareUploadSessionCreate[],
    uploadCompleted: [] as { session: FirmwareUploadSessionView; file: File }[],
    filterApplied: [] as unknown[],
    navigated: [] as string[],
    refreshed: 0,
  };
  const props: OtaPackagesPageProps = {
    role: 'PlatformSuperAdmin',
    packages: {
      rows: [makePackage(), makePackage({ packageId: 'pkg-bad', status: 'UPLOADED', version: '9.9.9' })],
      nextCursor: null,
    },
    filter: {},
    onApplyFilter: (f) => calls.filterApplied.push(f),
    onLoadMore: () => {},
    onCreateUploadSession: async (input) => {
      calls.sessionCreated.push(input);
      return makeSession();
    },
    onUploadAndComplete: async (session, file) => {
      calls.uploadCompleted.push({ session, file });
      return makePackage({ packageId: session.packageId, version: session.version, status: 'VERIFIED' });
    },
    onRefresh: () => {
      calls.refreshed += 1;
    },
    onNavigate: (path) => calls.navigated.push(path),
    ...overrides,
  };
  const utils = render(<OtaPackagesPage {...props} />);
  return { calls, unmount: utils.unmount };
}

test('包列表：VERIFIED 显示“可发布”徽标；UPLOADED 不可发布；筛选回调', async () => {
  const user = userEvent.setup();
  const { calls } = renderPackagesPage();
  assert.ok(screen.getByTestId('publishable-pkg-001'));
  assert.equal(screen.queryByTestId('publishable-pkg-bad'), null);

  await user.selectOptions(screen.getByTestId('pkg-filter-status'), 'VERIFIED');
  await user.selectOptions(screen.getByTestId('pkg-filter-type'), 'FIRMWARE');
  await user.click(screen.getByTestId('pkg-filter-search'));
  assert.deepEqual(calls.filterApplied[0], { status: 'VERIFIED', packageType: 'FIRMWARE' });
});

test('上传会话：字段级校验阻止非法元数据（sha256 非 hex64 → 提交禁用）', async () => {
  const user = userEvent.setup();
  renderPackagesPage();
  await user.click(screen.getByTestId('upload-session-open'));
  const form = screen.getByTestId('upload-form');
  await user.type(within(form).getByTestId('upload-model'), 'FD-100');
  await user.type(within(form).getByTestId('upload-version'), '2.5.0');
  await user.type(within(form).getByTestId('upload-size'), '2048');
  await user.type(within(form).getByTestId('upload-sha256'), 'not-hex');
  await user.type(within(form).getByTestId('upload-signature'), 'sig-value');
  assert.ok(within(form).getByTestId('upload-sha256-error').textContent?.includes('64 位十六进制'));
  assert.equal((within(form).getByTestId('upload-session-submit') as HTMLButtonElement).disabled, true);
});

test('上传 E2E：创建会话 → 直传 + complete 校验 → VERIFIED 可发布并回源刷新', async () => {
  const user = userEvent.setup();
  const { calls } = renderPackagesPage();
  await user.click(screen.getByTestId('upload-session-open'));
  const form = screen.getByTestId('upload-form');
  await user.type(within(form).getByTestId('upload-model'), 'FD-100');
  await user.type(within(form).getByTestId('upload-version'), '2.5.0');
  await user.type(within(form).getByTestId('upload-size'), '2048');
  await user.type(within(form).getByTestId('upload-sha256'), SHA256);
  await user.type(within(form).getByTestId('upload-signature'), 'sig-value');
  await user.click(within(form).getByTestId('upload-session-submit'));

  assert.deepEqual(calls.sessionCreated, [
    {
      model: 'FD-100',
      version: '2.5.0',
      packageType: 'FIRMWARE',
      sizeBytes: 2048,
      sha256: SHA256,
      signature: 'sig-value',
    },
  ]);
  const sessionPanel = await screen.findByTestId('upload-session');
  assert.ok(within(sessionPanel).getByTestId('upload-session-object-key').textContent?.includes('服务端生成'));

  await user.upload(within(sessionPanel).getByTestId('upload-file'), new File([new Uint8Array(2048)], 'firmware.bin'));
  await user.click(within(sessionPanel).getByTestId('upload-complete-submit'));
  assert.equal(calls.uploadCompleted.length, 1);
  assert.equal(calls.uploadCompleted[0]?.session.packageId, 'pkg-002');
  assert.equal(calls.uploadCompleted[0]?.file.name, 'firmware.bin');
  const result = await screen.findByTestId('verified-result');
  assert.ok(result.textContent?.includes('可发布'));
  assert.ok(screen.getByTestId('action-notice').textContent?.includes('VERIFIED'));
  assert.equal(calls.refreshed, 1);
});

test('Auditor 只读：上传入口禁用并说明 ota:write', () => {
  renderPackagesPage({ role: 'Auditor' });
  assert.equal((screen.getByTestId('upload-session-open') as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByTestId('upload-deny').textContent?.includes('ota:write'));
});

// ---------- Campaign 页 ----------

function renderCampaignsPage(overrides: Partial<OtaCampaignsPageProps> = {}) {
  const calls = {
    created: [] as unknown[],
    expanded: [] as {
      campaignId: string;
      deviceIds: readonly string[];
      finalRolloutApproval?: { readonly confirmText: string };
    }[],
    paused: [] as string[],
    resumed: [] as string[],
    cancelled: [] as string[],
    retried: [] as { campaignId: string; targetIds?: readonly string[] }[],
    selected: [] as string[],
    targetFilterApplied: [] as unknown[],
    filterApplied: [] as unknown[],
    navigated: [] as string[],
    refreshed: 0,
  };
  const props: OtaCampaignsPageProps = {
    role: 'PlatformSuperAdmin',
    campaigns: { rows: [makeCampaign()], nextCursor: null },
    filter: {},
    onApplyFilter: (f) => calls.filterApplied.push(f),
    onLoadMore: () => {},
    detail: { kind: 'none' },
    onSelectCampaign: (id) => calls.selected.push(id),
    onCloseDetail: () => {},
    onLoadMoreTargets: () => {},
    onApplyTargetFilter: (f) => calls.targetFilterApplied.push(f),
    verifiedPackages: [makePackage()],
    eligibleDevices: ELIGIBLE,
    onCreateCampaign: async (input) => {
      calls.created.push(input);
      return makeCampaign({ campaignId: 'camp-new' });
    },
    onExpandBatch: async (campaignId, deviceIds, finalRolloutApproval) => {
      calls.expanded.push({ campaignId, deviceIds, ...(finalRolloutApproval ? { finalRolloutApproval } : {}) });
      return {
        campaignId,
        batchNo: 2,
        addedCount: deviceIds.length,
        skippedExistingCount: 0,
        addedTargets: [],
        finalRolloutApproved: finalRolloutApproval !== undefined,
        approvedBy: finalRolloutApproval === undefined ? null : 'admin@example.com',
      };
    },
    onPause: async (campaignId) => {
      calls.paused.push(campaignId);
      return makeCampaign({ status: 'PAUSED' });
    },
    onResume: async (campaignId) => {
      calls.resumed.push(campaignId);
      return makeCampaign({ status: 'RUNNING' });
    },
    onCancel: async (campaignId) => {
      calls.cancelled.push(campaignId);
      return makeCampaign({ status: 'CANCELLED' });
    },
    onRetry: async (campaignId, targetIds) => {
      calls.retried.push({ campaignId, ...(targetIds !== undefined ? { targetIds } : {}) });
      return { campaignId, retriedCount: targetIds?.length ?? 1, retriedTargetIds: targetIds ?? ['tgt-failed'] };
    },
    onNavigate: (path) => calls.navigated.push(path),
    onRefresh: () => {
      calls.refreshed += 1;
    },
    ...overrides,
  };
  const utils = render(<OtaCampaignsPage {...props} />);
  return { calls, unmount: utils.unmount };
}

const RUNNING_DETAIL: OtaCampaignsPageProps['detail'] = {
  kind: 'ready',
  campaign: makeDetail(),
  targets: {
    rows: [
      makeTarget(),
      makeTarget({
        targetId: 'tgt-failed',
        deviceId: 'dev-002',
        batchNo: 2,
        status: 'FAILED',
        failureCode: 'DOWNLOAD_TIMEOUT',
        failureReason: '下载超时',
        completedAt: null,
      }),
      makeTarget({ targetId: 'tgt-pending', deviceId: 'dev-003', batchNo: 2, status: 'PENDING', completedAt: null }),
    ],
    nextCursor: null,
  },
};

test('坏包不可建 Campaign：包下拉仅 VERIFIED 可发布包；校验函数拒绝非 VERIFIED 包', async () => {
  const user = userEvent.setup();
  // 页面可选来源只有 verifiedPackages（容器仅注入 VERIFIED 列表）
  renderCampaignsPage();
  // 打开创建表单后下拉才渲染
  await user.click(screen.getByTestId('campaign-create-open'));
  const options = within(screen.getByTestId('campaign-package'))
    .getAllByRole('option')
    .map((o) => o.getAttribute('value'));
  assert.deepEqual(options, ['', 'pkg-001']);

  // 校验函数：UPLOADED 包 id 不在 VERIFIED 集合 → 拒绝
  assert.ok(
    validateCampaignCreate({ name: 'n', packageId: 'pkg-bad', deviceIds: ['dev-001'] }, ['pkg-001'])?.includes(
      'VERIFIED',
    ),
  );
  assert.equal(validateCampaignCreate({ name: 'n', packageId: 'pkg-001', deviceIds: ['dev-001'] }, ['pkg-001']), null);
});

test('坏包不可建 Campaign：无可发布包时创建入口禁用并提示', () => {
  renderCampaignsPage({ verifiedPackages: [] });
  assert.equal((screen.getByTestId('campaign-create-open') as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByTestId('create-no-package').textContent?.includes('VERIFIED'));
});

test('首批 >1 台：校验函数与 API 装配层双重阻止（不发请求）', async () => {
  assert.ok(
    validateCampaignCreate({ name: 'n', packageId: 'pkg-001', deviceIds: ['a', 'b'] }, ['pkg-001'])?.includes(
      '恰好 1 台',
    ),
  );
  assert.ok(
    validateCampaignCreate({ name: 'n', packageId: 'pkg-001', deviceIds: [] }, ['pkg-001'])?.includes('恰好 1 台'),
  );

  const { api, calls } = stubApi();
  await expect(() =>
    createOtaCampaign(api, { name: 'n', packageId: 'pkg-001', deviceIds: ['a', 'b'] }),
  ).rejects.toThrow(/恰好 1 台/);
  assert.equal(calls.length, 0);
});

test('创建 Campaign E2E：VERIFIED 包 + 首批 1 台 → RUNNING/CANARY 提示并回源刷新', async () => {
  const user = userEvent.setup();
  const { calls } = renderCampaignsPage();
  await user.click(screen.getByTestId('campaign-create-open'));
  const form = screen.getByTestId('campaign-create-form');
  await user.type(within(form).getByTestId('campaign-name'), '2.4.0 灰度升级');
  await user.selectOptions(within(form).getByTestId('campaign-package'), 'pkg-001');
  await user.selectOptions(within(form).getByTestId('campaign-device'), 'dev-001');
  await user.click(within(form).getByTestId('campaign-create-submit'));

  assert.deepEqual(calls.created, [{ name: '2.4.0 灰度升级', packageId: 'pkg-001', deviceIds: ['dev-001'] }]);
  const notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('进行中'));
  assert.ok(notice.textContent?.includes('CANARY'));
  assert.equal(calls.refreshed, 1);
});

test('目标状态看板：total 与 8 状态计数渲染；目标列表批次/状态展示', () => {
  renderCampaignsPage({ detail: RUNNING_DETAIL });
  assert.ok(screen.getByTestId('count-total').textContent?.includes('3'));
  assert.ok(screen.getByTestId('count-SUCCEEDED').textContent?.includes('1'));
  assert.ok(screen.getByTestId('count-FAILED').textContent?.includes('1'));
  const targets = screen.getByTestId('target-list-section');
  assert.ok(within(targets).getByText('1（灰度）'));
  const table = within(targets).getByRole('table', { name: '目标列表' });
  assert.ok(within(table).getByText('失败'));
  assert.ok(within(table).getByText('DOWNLOAD_TIMEOUT：下载超时'));
});

test('暂停/恢复/取消：RUNNING→已暂停（不再产生新下发）；PAUSED→恢复；取消需明确确认', async () => {
  const user = userEvent.setup();
  const { calls, unmount } = renderCampaignsPage({ detail: RUNNING_DETAIL });
  await user.click(screen.getByTestId('campaign-action-pause'));
  assert.deepEqual(calls.paused, ['camp-001']);
  let notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('已暂停'));
  assert.ok(notice.textContent?.includes('不再产生新下发'));
  unmount();

  const paused = renderCampaignsPage({
    detail: { kind: 'ready', campaign: makeDetail({ status: 'PAUSED' }), targets: { rows: [], nextCursor: null } },
  });
  assert.equal((screen.getByTestId('campaign-action-pause') as HTMLButtonElement).disabled, true);
  await user.click(screen.getByTestId('campaign-action-resume'));
  assert.deepEqual(paused.calls.resumed, ['camp-001']);
  notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('进行中'));
  paused.unmount();

  const cancelling = renderCampaignsPage({ detail: RUNNING_DETAIL });
  await user.click(screen.getByTestId('campaign-action-cancel'));
  await user.click(within(screen.getByTestId('confirm-dialog')).getByText('确认取消'));
  assert.deepEqual(cancelling.calls.cancelled, ['camp-001']);
  notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('已取消'));
  assert.ok(notice.textContent?.includes('级联取消'));
});

test('动作矩阵：终态（COMPLETED/CANCELLED）全部动作禁用；Auditor 无 ota:write 禁用', () => {
  const { unmount } = renderCampaignsPage({
    detail: { kind: 'ready', campaign: makeDetail({ status: 'COMPLETED' }), targets: { rows: [], nextCursor: null } },
  });
  for (const action of ['pause', 'resume', 'expand', 'retry', 'cancel']) {
    assert.equal((screen.getByTestId(`campaign-action-${action}`) as HTMLButtonElement).disabled, true, action);
  }
  unmount();

  renderCampaignsPage({ role: 'Auditor', detail: RUNNING_DETAIL });
  assert.equal((screen.getByTestId('campaign-action-pause') as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByTestId('campaign-action-pause-deny').textContent?.includes('ota:write'));
});

test('扩大批次：普通角色不能审批最终全量；部分选择仍可提交', async () => {
  const user = userEvent.setup();
  const { calls } = renderCampaignsPage({ role: 'PlatformOperator', detail: RUNNING_DETAIL });
  await user.click(screen.getByTestId('campaign-action-expand'));
  const form = screen.getByTestId('campaign-expand-form');

  // 全选（2/2 合格设备）→ 普通角色不能审批
  await user.click(within(form).getByTestId('expand-device-dev-001'));
  await user.click(within(form).getByTestId('expand-device-dev-002'));
  assert.ok(within(form).getByTestId('expand-error').textContent?.includes('PlatformSuperAdmin'));
  assert.equal((within(form).getByTestId('expand-submit') as HTMLButtonElement).disabled, true);

  // 改为部分选择 → 可提交
  await user.click(within(form).getByTestId('expand-device-dev-002'));
  assert.equal(within(form).queryByTestId('expand-error'), null);
  await user.click(within(form).getByTestId('expand-submit'));
  assert.deepEqual(calls.expanded, [{ campaignId: 'camp-001', deviceIds: ['dev-001'] }]);
  const notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('批次 2'));
  assert.ok(notice.textContent?.includes('新增 1 台'));
});

test('扩大批次：最终全量须既有 targets 全部成功并精确确认', async () => {
  const user = userEvent.setup();
  const allSucceededDetail: OtaCampaignsPageProps['detail'] = {
    kind: 'ready',
    campaign: makeDetail({
      targetCounts: {
        total: 1,
        PENDING: 0,
        NOTIFIED: 0,
        DOWNLOADING: 0,
        INSTALLING: 0,
        SUCCEEDED: 1,
        FAILED: 0,
        ROLLED_BACK: 0,
        CANCELLED: 0,
      },
    }),
    targets: { rows: [makeTarget()], nextCursor: null },
  };
  const { calls } = renderCampaignsPage({ detail: allSucceededDetail });
  await user.click(screen.getByTestId('campaign-action-expand'));
  const form = screen.getByTestId('campaign-expand-form');
  await user.click(within(form).getByTestId('expand-device-dev-001'));
  await user.click(within(form).getByTestId('expand-device-dev-002'));
  assert.ok(within(form).getByTestId('expand-error').textContent?.includes('APPROVE_FINAL_ROLLOUT:camp-001'));
  await user.type(within(form).getByTestId('final-rollout-confirm'), 'APPROVE_FINAL_ROLLOUT:camp-001');
  assert.equal(within(form).queryByTestId('expand-error'), null);
  await user.click(within(form).getByTestId('expand-submit'));
  assert.deepEqual(calls.expanded, [
    {
      campaignId: 'camp-001',
      deviceIds: ['dev-001', 'dev-002'],
      finalRolloutApproval: { confirmText: 'APPROVE_FINAL_ROLLOUT:camp-001' },
    },
  ]);
  assert.ok((await screen.findByTestId('action-notice')).textContent?.includes('最终全量已由'));
});

test('扩大批次：校验函数 1~500 边界与 API 最终审批装配', async () => {
  assert.ok(validateBatchExpand([])?.includes('1~500'));
  assert.ok(validateBatchExpand(new Array(501).fill('d'))?.includes('1~500'));
  assert.equal(validateBatchExpand(['a', 'b']), null);

  const { api, calls } = stubApi();
  await expect(() => expandOtaCampaignBatch(api, 'camp-1', [])).rejects.toThrow(/1~500/);
  await expandOtaCampaignBatch(api, 'camp-1', ['a', 'b'], {
    confirmText: 'APPROVE_FINAL_ROLLOUT:camp-1',
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.options.body, {
    deviceIds: ['a', 'b'],
    finalRolloutApproval: { confirmText: 'APPROVE_FINAL_ROLLOUT:camp-1' },
  });
});

test('失败重试：缺省重试全部 FAILED；勾选子集携 targetIds', async () => {
  const user = userEvent.setup();
  const { calls, unmount } = renderCampaignsPage({ detail: RUNNING_DETAIL });
  await user.click(screen.getByTestId('campaign-action-retry'));
  let form = screen.getByTestId('campaign-retry-form');
  // 列表中仅 1 个 FAILED target（tgt-failed）
  assert.ok(within(form).getByTestId('retry-target-tgt-failed'));
  assert.equal(within(form).queryByTestId('retry-target-tgt-001'), null);
  await user.click(within(form).getByTestId('retry-submit'));
  assert.deepEqual(calls.retried, [{ campaignId: 'camp-001' }]);
  let notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('已重试 1 个失败 target'));
  unmount();

  const subset = renderCampaignsPage({ detail: RUNNING_DETAIL });
  await user.click(screen.getByTestId('campaign-action-retry'));
  form = screen.getByTestId('campaign-retry-form');
  await user.click(within(form).getByTestId('retry-target-tgt-failed'));
  await user.click(within(form).getByTestId('retry-submit'));
  assert.deepEqual(subset.calls.retried, [{ campaignId: 'camp-001', targetIds: ['tgt-failed'] }]);
  notice = await screen.findByTestId('action-notice');
  assert.ok(notice.textContent?.includes('已重试 1 个失败 target'));
});

test('目标筛选：状态/批次号经 onApplyTargetFilter 应用', async () => {
  const user = userEvent.setup();
  const { calls } = renderCampaignsPage({ detail: RUNNING_DETAIL });
  await user.selectOptions(screen.getByTestId('target-filter-status'), 'FAILED');
  await user.type(screen.getByTestId('target-filter-batch'), '2');
  await user.click(screen.getByTestId('target-filter-search'));
  assert.deepEqual(calls.targetFilterApplied, [{ status: 'FAILED', batchNo: 2 }]);
});

// ---------- API 装配 ----------

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

test('API 装配：上传会话 POST 路径与体；包列表查询串', async () => {
  const { api, calls } = stubApi();
  const input: FirmwareUploadSessionCreate = {
    model: 'FD-100',
    version: '2.5.0',
    packageType: 'FIRMWARE',
    sizeBytes: 2048,
    sha256: SHA256,
    signature: 'sig',
  };
  await createFirmwareUpload(api, input);
  assert.equal(calls[0]?.path, '/admin/ota/packages/upload-sessions');
  assert.equal(calls[0]?.options.method, 'POST');
  assert.deepEqual(calls[0]?.options.body, input);

  await listFirmwarePackages(api, { model: 'FD-100', status: 'VERIFIED', packageType: 'APP' }, 'cur-1');
  const listUrl = new URL(calls[1]?.path ?? '', 'https://test.invalid');
  assert.equal(listUrl.pathname, '/admin/ota/packages');
  assert.deepEqual(Object.fromEntries(listUrl.searchParams), {
    model: 'FD-100',
    status: 'VERIFIED',
    packageType: 'APP',
    cursor: 'cur-1',
  });
});

test('API 装配：重试缺省无 body（全部 FAILED）；子集携 targetIds', async () => {
  const { api, calls } = stubApi();
  await retryOtaCampaignFailures(api, 'camp-1');
  assert.equal(calls[0]?.path, '/admin/ota/campaigns/camp-1/retry');
  assert.equal(calls[0]?.options.body, undefined);

  await retryOtaCampaignFailures(api, 'camp-1', ['t1', 't2']);
  assert.deepEqual(calls[1]?.options.body, { targetIds: ['t1', 't2'] });
});

test('Auditor 即使存在 VERIFIED 包和可用设备也不能创建 Campaign', async () => {
  const user = userEvent.setup();
  const { calls } = renderCampaignsPage({ role: 'Auditor' });
  const button = screen.getByTestId('campaign-create-open') as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await user.click(button);
  expect(screen.queryByTestId('campaign-create-submit')).toBeNull();
  expect(calls.created).toEqual([]);
});
