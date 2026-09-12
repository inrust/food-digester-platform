// @vitest-environment jsdom
/**
 * FE-11 ESG 页面测试：
 * - 指标单位/计算版本/完整率显示；日/周/月聚合口径（求和 + 平均标注 + 多版本）；
 * - 导出筛选与页面一致（快照断言）；过期下载链接明确提示；
 * - 日期按用户时区转 UTC 查询（Asia/Shanghai 边界换算）；
 * - “非第三方核证”声明固定展示；无碳认证结论；
 * - CT-06 锚点存在性。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { EsgOverviewPage } from '../src/pages/esg/EsgOverviewPage.js';
import type { EsgOverviewPageProps } from '../src/pages/esg/EsgOverviewPage.js';
import { EsgDevicesPage } from '../src/pages/esg/EsgDevicesPage.js';
import type { EsgDevicesPageProps } from '../src/pages/esg/EsgDevicesPage.js';
import { collectAllPages } from '../src/app/operations-controllers.js';
import {
  aggregateDailySummaries,
  aggregateDeviceReports,
  isoWeekKey,
  zonedDateRangeToUtc,
} from '../src/pages/esg/esg-state.js';
import type { EsgDailySummaryView, EsgExportJobView, EsgReportView } from '../src/pages/esg/types.js';

afterEach(cleanup);

const TZ = 'Asia/Shanghai';

function makeSummary(overrides: Partial<EsgDailySummaryView> = {}): EsgDailySummaryView {
  return {
    deviceId: 'dev-001',
    customerId: 'cust-1',
    summaryDate: '2026-09-01T00:00:00Z',
    feedingWeightKg: 100,
    dischargeWeightKg: 20,
    reductionWeightKg: 80,
    powerConsumptionKwh: 12.5,
    carbonReductionKg: 45.2,
    dataCompletenessPct: 98.5,
    missingRecordCount: 1,
    calculationVersionId: 'esgv-1',
    ...overrides,
  };
}

function makeReport(overrides: Partial<EsgReportView> = {}): EsgReportView {
  return {
    reportId: 'rpt-1',
    deviceId: 'dev-001',
    customerId: 'cust-1',
    reportType: 'DAILY',
    periodStartTime: '2026-09-01T00:00:00Z',
    periodEndTime: '2026-09-02T00:00:00Z',
    feedingWeightKg: 100,
    dischargeWeightKg: 20,
    reductionWeightKg: 80,
    cycleCount: 4,
    processingMinutes: 300,
    powerConsumptionKwh: 12.5,
    avgPowerKw: 2.5,
    avgO2Pct: 19.5,
    avgCo2Ppm: 800,
    avgCh4Ppm: 12,
    avgN2oPpm: 3,
    carbonReductionKg: 45.2,
    carbonReductionMethod: 'default-v1',
    dataCompletenessPct: 98.5,
    missingRecordCount: 1,
    calculationVersionId: 'esgv-1',
    ...overrides,
  };
}

const VERSIONS = [
  {
    versionId: 'esgv-1',
    version: 'v1.2.0',
    description: '默认估算口径',
    formula: { factor: 0.45 },
    effectiveFrom: '2026-01-01T00:00:00Z',
    status: 'ACTIVE' as const,
    createdAt: '2026-01-01T00:00:00Z',
  },
];

function renderOverview(overrides: Partial<EsgOverviewPageProps> = {}) {
  const calls = {
    applied: [] as EsgOverviewPageProps['appliedQuery'][],
    periodChanged: [] as string[],
    exported: [] as unknown[],
    checked: [] as string[],
    refreshed: 0,
  };
  const props: EsgOverviewPageProps = {
    role: 'PlatformSuperAdmin',
    timeZone: TZ,
    isCustomerRole: false,
    customerOptions: [{ value: 'cust-1', label: '示例客户' }],
    period: 'day',
    onPeriodChange: (p) => calls.periodChanged.push(p),
    appliedQuery: { customerId: null, from: null, to: null },
    onApply: (q) => calls.applied.push(q),
    rows: [makeSummary()],
    versions: VERSIONS,
    exportJob: null,
    onExport: async (snapshot) => {
      calls.exported.push(snapshot);
    },
    onCheckExport: (id) => calls.checked.push(id),
    onRefresh: () => {
      calls.refreshed += 1;
    },
    ...overrides,
  };
  const utils = render(<EsgOverviewPage {...props} />);
  return { calls, unmount: utils.unmount };
}

function renderDevices(overrides: Partial<EsgDevicesPageProps> = {}) {
  const calls = {
    applied: [] as EsgDevicesPageProps['applied'][],
    exported: [] as unknown[],
    periodChanged: [] as string[],
  };
  const props: EsgDevicesPageProps = {
    role: 'PlatformSuperAdmin',
    timeZone: TZ,
    period: 'day',
    onPeriodChange: (p) => calls.periodChanged.push(p),
    scopeOptions: {
      regions: [{ value: '华东', label: '华东' }],
      subregions: [{ value: '上海', label: '上海', region: '华东' }],
      sites: [{ value: 'site-1', label: '一号站', subregion: '上海' }],
      devices: [{ value: 'dev-001', label: 'XJ-2026-001', siteId: 'site-1' }],
    },
    deviceScope: { 'dev-001': { region: '华东', subregion: '上海' }, 'dev-002': { region: '华北', subregion: '北京' } },
    applied: { scope: { region: null, subregion: null, siteId: null, deviceId: null }, from: null, to: null },
    onApply: (q) => calls.applied.push(q),
    rows: [makeReport()],
    versions: VERSIONS,
    exportJob: null,
    onExport: async (snapshot) => {
      calls.exported.push(snapshot);
    },
    onCheckExport: () => {},
    onRefresh: () => {},
    ...overrides,
  };
  const utils = render(<EsgDevicesPage {...props} />);
  return { calls, unmount: utils.unmount };
}

// ---------- 概览页：单位/版本/完整率 ----------

test('概览：指标单位（kg/kWh/%）、计算版本、完整率、估算 CO2e 列头正确；核证声明固定展示', () => {
  renderOverview();
  // CT-06 锚点列
  assert.ok(screen.getByTestId('esg-col-date'));
  assert.equal(screen.getByTestId('esg-col-carbon').textContent, '估算 CO2e (kg)');
  assert.equal(screen.getByTestId('esg-col-throughput').textContent, '投料量 (kg)');
  assert.equal(screen.getByTestId('esg-col-energy').textContent, '能耗 (kWh)');
  // 行数据
  const row = screen.getByTestId('esg-row-2026-09-01');
  assert.ok(row.textContent?.includes('100.0 kg'));
  assert.ok(row.textContent?.includes('12.50 kWh'));
  assert.ok(row.textContent?.includes('45.2 kg'));
  assert.equal(screen.getByTestId('esg-completeness-2026-09-01').textContent, '98.5%');
  assert.equal(screen.getByTestId('esg-version-2026-09-01').textContent, 'v1.2.0');
  // 核证声明
  assert.ok(screen.getByTestId('esg-disclaimer').textContent?.includes('非第三方核证'));
  // 不绘制碳认证结论
  assert.notMatch(screen.getByTestId('esg-overview-page').textContent ?? '', /碳认证|已核证|碳信用/);
});

test('概览：日/周/月切换聚合（加法指标求和、完整率平均、多版本标注）', () => {
  const rows = [
    makeSummary({
      summaryDate: '2026-09-01T00:00:00Z',
      feedingWeightKg: 100,
      carbonReductionKg: 40,
      dataCompletenessPct: 90,
    }),
    makeSummary({
      summaryDate: '2026-09-02T00:00:00Z',
      feedingWeightKg: 50,
      carbonReductionKg: 20,
      dataCompletenessPct: 100,
      calculationVersionId: 'esgv-2',
    }),
    // 下一周
    makeSummary({
      summaryDate: '2026-09-08T00:00:00Z',
      feedingWeightKg: 70,
      carbonReductionKg: 30,
      dataCompletenessPct: null,
    }),
  ];
  const weekly = aggregateDailySummaries(rows, 'week');
  assert.equal(weekly.length, 2);
  const w1 = weekly.find((r) => r.bucket === isoWeekKey('2026-09-01T00:00:00Z'));
  assert.ok(w1 !== undefined);
  assert.equal(w1.feedingWeightKg, 150);
  assert.equal(w1.carbonReductionKg, 60);
  assert.equal(w1.avgCompletenessPct, 95);
  assert.deepEqual(w1.versionIds, ['esgv-1', 'esgv-2']);
  const w2 = weekly.find((r) => r.bucket === isoWeekKey('2026-09-08T00:00:00Z'));
  assert.equal(w2?.avgCompletenessPct, null, '全 null 完整率不伪造');

  const monthly = aggregateDailySummaries(rows, 'month');
  assert.equal(monthly.length, 1);
  assert.equal(monthly[0]?.feedingWeightKg, 220);

  // 页面层：周切换后列头标注“平均”，混合版本显示“多版本”
  renderOverview({ period: 'week', rows });
  assert.ok(screen.getByText('完整率（平均）'));
  assert.equal(screen.getByTestId(`esg-version-${isoWeekKey('2026-09-01T00:00:00Z')}`).textContent, '多版本');
});

// ---------- 时区转换 ----------

test('日期按用户时区转 UTC：Asia/Shanghai 日历日 → UTC 区间并展示换算结果', async () => {
  const user = userEvent.setup();
  const range = zonedDateRangeToUtc('2026-09-01', '2026-09-01', TZ);
  assert.ok(range !== null);
  assert.equal(range.from, '2026-08-31T16:00:00.000Z');
  assert.equal(range.to, '2026-09-01T15:59:59.999Z');

  const { calls } = renderOverview();
  await user.type(screen.getByTestId('esg-from-date'), '2026-09-01');
  await user.type(screen.getByTestId('esg-to-date'), '2026-09-01');
  await user.click(screen.getByTestId('esg-apply'));
  assert.deepEqual(calls.applied, [{ customerId: null, from: range.from, to: range.to }]);

  cleanup();
  renderOverview({ appliedQuery: { customerId: null, from: range.from, to: range.to } });
  assert.ok(screen.getByTestId('esg-query-hint').textContent?.includes('Asia/Shanghai'));

  // 非法：起始晚于截止
  assert.equal(zonedDateRangeToUtc('2026-09-02', '2026-09-01', TZ), null);
});

test('日期严格校验且 America/New_York 的 DST 日按 23/25 小时自然日换算', () => {
  assert.deepEqual(zonedDateRangeToUtc('2026-03-08', '2026-03-08', 'America/New_York'), {
    from: '2026-03-08T05:00:00.000Z',
    to: '2026-03-09T03:59:59.999Z',
  });
  assert.deepEqual(zonedDateRangeToUtc('2026-11-01', '2026-11-01', 'America/New_York'), {
    from: '2026-11-01T04:00:00.000Z',
    to: '2026-11-02T04:59:59.999Z',
  });
  assert.equal(zonedDateRangeToUtc('2026-02-29', '2026-02-29', TZ), null);
  assert.equal(zonedDateRangeToUtc('2026-02-31', '2026-02-31', TZ), null);
  assert.equal(zonedDateRangeToUtc('2026-09-01', '2026-09-01', 'Mars/Olympus'), null);
});

test('控制器完整遍历游标页，聚合与导出共用全量数据源', async () => {
  const cursors: Array<string | undefined> = [];
  const rows = await collectAllPages(async (cursor) => {
    cursors.push(cursor);
    return cursor === undefined
      ? { rows: [makeSummary({ deviceId: 'dev-001' })], nextCursor: 'page-2' }
      : { rows: [makeSummary({ deviceId: 'dev-002' })], nextCursor: null };
  });
  assert.deepEqual(cursors, [undefined, 'page-2']);
  assert.deepEqual(
    rows.map((row) => row.deviceId),
    ['dev-001', 'dev-002'],
  );
});

// ---------- 导出 ----------

test('导出：筛选快照与页面一致；状态流 PENDING→COMPLETED 出下载链接；过期链接明确提示', async () => {
  const user = userEvent.setup();
  const appliedQuery = { customerId: 'cust-1', from: '2026-08-31T16:00:00.000Z', to: '2026-09-01T15:59:59.999Z' };
  const { calls, unmount } = renderOverview({ appliedQuery });
  await user.click(screen.getByTestId('esg-export-csv'));
  // 导出筛选 = 页面已应用筛选（含 dataset）
  assert.deepEqual(calls.exported, [
    {
      dataset: 'DAILY_SUMMARY',
      customerId: 'cust-1',
      from: '2026-08-31T16:00:00.000Z',
      to: '2026-09-01T15:59:59.999Z',
    },
  ]);
  unmount();

  // PENDING → 刷新状态
  const pendingJob: EsgExportJobView = {
    exportId: 'exp-1',
    dataset: 'DAILY_SUMMARY',
    status: 'PENDING',
    filters: { customerId: 'cust-1' },
    rowCount: null,
    downloadUrl: null,
    urlExpiresAt: null,
    urlExpired: false,
    error: null,
    requestedBy: 'admin@example.com',
    createdAt: '2026-09-06T05:00:00Z',
    completedAt: null,
  };
  const second = renderOverview({ exportJob: pendingJob });
  await user.click(screen.getByTestId('esg-export-refresh'));
  assert.deepEqual(second.calls.checked, ['exp-1']);
  assert.equal(screen.queryByTestId('esg-export-download'), null, '未完成不出下载链接');
  second.unmount();

  // COMPLETED 未过期 → 下载链接
  const done: EsgExportJobView = {
    ...pendingJob,
    status: 'COMPLETED',
    rowCount: 42,
    downloadUrl: 'https://example.com/export.csv?sig=abc',
    urlExpiresAt: '2026-09-06T05:15:00Z',
  };
  const third = renderOverview({ exportJob: done });
  const link = screen.getByTestId('esg-export-download') as HTMLAnchorElement;
  assert.ok(link.href.includes('export.csv'));
  assert.ok(link.textContent?.includes('42') === false); // 行数在状态文本
  assert.ok(screen.getByTestId('esg-export-job').textContent?.includes('42 行'));
  third.unmount();

  // 过期 → 明确提示且无链接
  renderOverview({ exportJob: { ...done, downloadUrl: null, urlExpired: true } });
  assert.ok(screen.getByTestId('esg-export-expired').textContent?.includes('已过期'));
  assert.equal(screen.queryByTestId('esg-export-download'), null);
});

test('导出权限：CustomerViewer（无 export:create）不显示导出按钮', () => {
  renderOverview({ role: 'CustomerViewer', isCustomerRole: true });
  assert.equal(screen.queryByTestId('esg-export-csv'), null);
});

// ---------- 设备页 ----------

test('设备页：九项指标 + 完整率 + 计算版本；ScopeFilter 联动；CT-06 锚点齐全', async () => {
  const user = userEvent.setup();
  const { calls } = renderDevices();
  // CT-06 锚点
  for (const testid of [
    'esg-device-apply',
    'esg-device-period-toggle',
    'esg-device-export-csv',
    'esg-device-metrics',
  ]) {
    assert.ok(screen.getByTestId(testid), `缺少锚点 ${testid}`);
  }
  assert.ok(document.querySelector('#scope-region') !== null);
  assert.ok(document.querySelector('#scope-subregion') !== null);
  assert.ok(document.querySelector('#scope-device') !== null);

  // 指标行（日粒度）
  const row = screen.getByTestId('esg-device-row-dev-001-2026-09-01');
  for (const text of [
    '100.0 kg',
    '20.0 kg',
    '80.0 kg',
    '12.50 kWh',
    '19.5%',
    '800 ppm',
    '12 ppm',
    '3 ppm',
    '45.2 kg',
    '98.5%',
    'v1.2.0',
  ]) {
    assert.ok(row.textContent?.includes(text), `缺少指标 ${text}`);
  }

  // 应用筛选：scope + 日期 → onApply
  await user.selectOptions(document.querySelector('#scope-region') as HTMLElement, '华东');
  await user.selectOptions(document.querySelector('#scope-subregion') as HTMLElement, '上海');
  await user.selectOptions(document.querySelector('#scope-site') as HTMLElement, 'site-1');
  await user.selectOptions(document.querySelector('#scope-device') as HTMLElement, 'dev-001');
  await user.type(screen.getByTestId('esg-device-from-date'), '2026-09-01');
  await user.type(screen.getByTestId('esg-device-to-date'), '2026-09-02');
  await user.click(screen.getByTestId('esg-device-apply'));
  const applied = calls.applied[0];
  assert.deepEqual(applied?.scope, { region: '华东', subregion: '上海', siteId: 'site-1', deviceId: 'dev-001' });
  assert.equal(applied?.from, '2026-08-31T16:00:00.000Z');
});

test('设备页：region 客户端收窄行；设备页导出快照 dataset=REPORTS 且与页面筛选一致', async () => {
  const user = userEvent.setup();
  const rows = [makeReport(), makeReport({ reportId: 'rpt-2', deviceId: 'dev-002' })];
  const { calls } = renderDevices({
    rows,
    applied: {
      scope: { region: '华东', subregion: null, siteId: null, deviceId: null },
      from: '2026-08-31T16:00:00.000Z',
      to: '2026-09-01T15:59:59.999Z',
    },
  });
  // 仅华东设备行
  assert.ok(screen.queryByTestId('esg-device-row-dev-001-2026-09-01') !== null);
  assert.equal(screen.queryByTestId('esg-device-row-dev-002-2026-09-01'), null, '华北设备应被 region 收窄');

  await user.click(screen.getByTestId('esg-device-export-csv'));
  assert.deepEqual(calls.exported, [
    {
      dataset: 'REPORTS',
      siteId: null,
      deviceId: null,
      from: '2026-08-31T16:00:00.000Z',
      to: '2026-09-01T15:59:59.999Z',
    },
  ]);
});

test('设备页周聚合：气体均值算术平均并标注；可加指标求和', () => {
  const rows = [
    makeReport({ avgCo2Ppm: 800, feedingWeightKg: 100 }),
    makeReport({ reportId: 'rpt-2', periodStartTime: '2026-09-02T00:00:00Z', avgCo2Ppm: 1000, feedingWeightKg: 60 }),
  ];
  const weekly = aggregateDeviceReports(rows, 'week');
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0]?.avgCo2Ppm, 900);
  assert.equal(weekly[0]?.feedingWeightKg, 160);

  renderDevices({ period: 'week', rows });
  assert.ok(screen.getByText('CO2平均 (ppm)'));
  const weekKey = isoWeekKey('2026-09-01T00:00:00Z');
  const row = screen.getByTestId(`esg-device-row-dev-001-${weekKey}`);
  assert.ok(row.textContent?.includes('900 ppm'));
  assert.ok(row.textContent?.includes('160.0 kg'));
});
