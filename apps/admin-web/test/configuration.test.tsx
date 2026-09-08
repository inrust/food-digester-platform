// @vitest-environment jsdom
/**
 * FE-09 Configuration 页测试：
 * - 只渲染 DEC-018 V1 四字段且单位正确（秒/秒/分钟/°C）；
 * - 候选扩展字段（图像/旋转/电机/加热/语言/云域名/NTP/温度上下限）在 DOM 不存在；
 * - 非法范围有字段级错误且禁止提交；发布后版本只读（无编辑入口、发布禁用）；
 * - 派生上下文只读；同步状态投递展示；Auditor 只读。
 */
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { ConfigurationsPage } from '../src/pages/configuration/ConfigurationsPage.js';
import type { ConfigurationsPageProps } from '../src/pages/configuration/ConfigurationsPage.js';
import {
  createConfiguration,
  createConfigurationVersion,
  fetchConfigurationVersionStatus,
  publishConfigurationVersion,
} from '../src/pages/configuration/configuration-api.js';
import type {
  ConfigurationDetailView,
  ConfigurationSummaryView,
  ConfigurationVersionView,
} from '../src/pages/configuration/types.js';

afterEach(cleanup);

const SUMMARY: ConfigurationSummaryView = {
  configurationId: 'cfg-001',
  name: '食堂标准配置',
  targetModel: null,
  targetDeviceId: 'dev-001',
  versionCount: 2,
  latestPublishedVersion: 1,
  createdBy: 'admin@example.com',
  createdAt: '2026-09-01T02:00:00Z',
};

function makeVersion(overrides: Partial<ConfigurationVersionView> = {}): ConfigurationVersionView {
  return {
    versionId: 'cfgv-1',
    configurationId: 'cfg-001',
    version: 1,
    payload: { heartbeatInterval: 60, telemetryInterval: 30, cameraRefreshInterval: 1, temperatureThreshold: 80 },
    status: 'PUBLISHED',
    effectiveAt: '2026-09-01T03:00:00Z',
    changeNote: '初始发布',
    createdAt: '2026-09-01T02:30:00Z',
    ...overrides,
  };
}

const DETAIL: ConfigurationDetailView = {
  ...SUMMARY,
  versions: [
    makeVersion(),
    makeVersion({
      versionId: 'cfgv-2',
      version: 2,
      status: 'DRAFT',
      effectiveAt: null,
      changeNote: null,
      payload: { heartbeatInterval: 120, telemetryInterval: 60, cameraRefreshInterval: 5, temperatureThreshold: 85 },
    }),
  ],
  derivedContext: {
    alias: '食堂1号机',
    site: '一号站',
    region: '华东',
    subregion: '上海',
    contract: { contractNumber: 'HT-2026-001', name: '年度服务合约' },
  },
};

function renderPage(overrides: Partial<ConfigurationsPageProps> = {}) {
  const calls = {
    applied: [] as unknown[],
    refreshed: 0,
    selected: [] as string[],
    syncLoaded: [] as number[],
    created: [] as unknown[],
    versionCreated: [] as unknown[],
    published: [] as unknown[],
  };
  const props: ConfigurationsPageProps = {
    role: 'PlatformSuperAdmin',
    list: { rows: [SUMMARY] },
    appliedFilter: { targetModel: null, targetDeviceId: null },
    onApplyFilter: (f) => calls.applied.push(f),
    onRefresh: () => {
      calls.refreshed += 1;
    },
    detail: { kind: 'none' },
    onSelect: (id) => calls.selected.push(id),
    onCloseDetail: () => {},
    onLoadSyncStatus: (v) => calls.syncLoaded.push(v),
    onCreate: async (input) => {
      calls.created.push(input);
      return SUMMARY;
    },
    onCreateVersion: async (configurationId, input) => {
      calls.versionCreated.push({ configurationId, ...input });
      return makeVersion({ version: 3, status: 'DRAFT' });
    },
    onPublish: async (configurationId, version, input) => {
      calls.published.push({ configurationId, version, ...input });
      return {};
    },
    ...overrides,
  };
  render(<ConfigurationsPage {...props} />);
  return { calls };
}

function disabled(testid: string): boolean {
  return (screen.getByTestId(testid) as HTMLButtonElement).disabled;
}

// ---------- 验收：只渲染 V1 四字段且单位正确；候选扩展字段不存在 ----------

test('版本表单只渲染 V1 四字段且单位正确；候选扩展字段不存在于 DOM', async () => {
  const user = userEvent.setup();
  renderPage({ detail: { kind: 'ready', detail: DETAIL, sync: { kind: 'none' } } });
  // 打开新建版本表单
  await user.click(screen.getByTestId('config-version-create'));
  const form = screen.getByTestId('config-version-form');
  const heartbeat = within(form).getByTestId('cfg-field-heartbeatInterval');
  const telemetry = within(form).getByTestId('cfg-field-telemetryInterval');
  const camera = within(form).getByTestId('cfg-field-cameraRefreshInterval');
  const temp = within(form).getByTestId('cfg-field-temperatureThreshold');
  // 默认值来自 DEC-018
  assert.equal((heartbeat as HTMLInputElement).value, '60');
  assert.equal((telemetry as HTMLInputElement).value, '30');
  assert.equal((camera as HTMLInputElement).value, '1');
  assert.equal((temp as HTMLInputElement).value, '80');
  // 单位标签正确（秒/秒/分钟/°C）
  const formText = form.textContent ?? '';
  assert.ok(formText.includes('Heartbeat 间隔（秒，10~900）'));
  assert.ok(formText.includes('Telemetry 间隔（秒，5~3600）'));
  assert.ok(formText.includes('摄像头刷新间隔（分钟，1~1440）'));
  assert.ok(formText.includes('温度阈值（°C，0~120）'));

  // 候选扩展字段不存在（DEC-018 excludedCandidateFields + 温度上下限）
  const pageText = screen.getByTestId('configurations-page').textContent ?? '';
  for (const forbidden of [
    '图像',
    '上传间隔',
    '旋转',
    '电机',
    '过载',
    '加热',
    '语言',
    '云域名',
    'NTP',
    '温度上限',
    '温度下限',
  ]) {
    assert.ok(!pageText.includes(forbidden), `候选扩展字段“${forbidden}”不得渲染`);
  }
  assert.notMatch(pageText, /cloudDomain|ntpServer|rotation|motor|\bimage\b/i);
});

// ---------- 验收：非法范围有字段错误 ----------

test('非法范围/非整数有字段级错误且禁止提交；合法后提交四字段快照', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ detail: { kind: 'ready', detail: DETAIL, sync: { kind: 'none' } } });
  await user.click(screen.getByTestId('config-version-create'));
  const form = screen.getByTestId('config-version-form');

  // 越界
  const heartbeat = within(form).getByTestId('cfg-field-heartbeatInterval');
  await user.clear(heartbeat);
  await user.type(heartbeat, '5');
  await user.tab();
  assert.ok(within(form).getByTestId('cfg-error-heartbeatInterval').textContent?.includes('10~900 秒'));
  assert.ok(disabled('cfg-submit'));

  // 非整数（integer 字段）
  await user.clear(heartbeat);
  await user.type(heartbeat, '60.5');
  await user.tab();
  assert.ok(within(form).getByTestId('cfg-error-heartbeatInterval').textContent?.includes('整数'));

  // 温度阈值允许小数但越界报错
  const temp = within(form).getByTestId('cfg-field-temperatureThreshold');
  await user.clear(temp);
  await user.type(temp, '200');
  await user.tab();
  assert.ok(within(form).getByTestId('cfg-error-temperatureThreshold').textContent?.includes('0~120 °C'));

  // 修复后提交
  await user.clear(heartbeat);
  await user.type(heartbeat, '120');
  await user.clear(temp);
  await user.type(temp, '85.5');
  await user.tab();
  assert.ok(!disabled('cfg-submit'));
  await user.type(within(form).getByTestId('cfg-change-note'), '调整心跳');
  await user.click(within(form).getByTestId('cfg-submit'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.versionCreated, [
    {
      configurationId: 'cfg-001',
      payload: { heartbeatInterval: 120, telemetryInterval: 30, cameraRefreshInterval: 1, temperatureThreshold: 85.5 },
      changeNote: '调整心跳',
    },
  ]);
  assert.equal(calls.refreshed, 1);
});

// ---------- 验收：发布后版本只读 ----------

test('发布后版本只读：PUBLISHED 无编辑入口且发布禁用；DRAFT 可发布；历史版本 payload 完整展示', () => {
  renderPage({ detail: { kind: 'ready', detail: DETAIL, sync: { kind: 'none' } } });
  const publishedCard = screen.getByTestId('config-version-1');
  // 只读展示（无 input）
  assert.equal(publishedCard.querySelector('input'), null);
  assert.ok(publishedCard.textContent?.includes('已发布'));
  assert.ok(disabled('config-publish-1'));
  assert.match(screen.getByTestId('config-publish-1').getAttribute('title') ?? '', /历史版本不可覆盖/);
  // payload 四字段展示
  assert.equal(screen.getByTestId('config-version-1-field-heartbeatInterval').textContent, '60');
  assert.equal(screen.getByTestId('config-version-1-field-cameraRefreshInterval').textContent, '1');

  const draftCard = screen.getByTestId('config-version-2');
  assert.ok(draftCard.textContent?.includes('草稿'));
  assert.ok(!disabled('config-publish-2'));
});

// ---------- 发布与同步状态 ----------

test('发布：生效时间可选且需合法；成功后提示 CONFIG_CHANGED 通知', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({ detail: { kind: 'ready', detail: DETAIL, sync: { kind: 'none' } } });
  await user.click(screen.getByTestId('config-publish-2'));
  const form = screen.getByTestId('config-publish-form');
  assert.ok(form.textContent?.includes('CONFIG_CHANGED'));
  await user.type(within(form).getByTestId('publish-effective-at'), 'not-a-date');
  assert.ok(disabled('config-publish'));
  await user.clear(within(form).getByTestId('publish-effective-at'));
  await user.type(within(form).getByTestId('publish-effective-at'), '2026-09-07T00:00:00Z');
  await user.type(within(form).getByTestId('publish-reason'), '例行发布');
  await user.click(within(form).getByTestId('config-publish'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.published, [
    { configurationId: 'cfg-001', version: 2, effectiveAt: '2026-09-07T00:00:00Z', reason: '例行发布' },
  ]);
});

test('同步状态：PUBLISHED 版本可查询每设备投递状态', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage({
    detail: {
      kind: 'ready',
      detail: DETAIL,
      sync: {
        kind: 'ready',
        data: {
          configurationId: 'cfg-001',
          version: 1,
          status: 'PUBLISHED',
          effectiveAt: '2026-09-01T03:00:00Z',
          targets: [
            { deviceId: 'dev-001', notificationStatus: 'PUBLISHED' },
            { deviceId: 'dev-002', notificationStatus: 'PENDING' },
          ],
        },
      },
    },
  });
  await user.click(screen.getByTestId('config-sync-1'));
  assert.deepEqual(calls.syncLoaded, [1]);
  assert.ok(screen.getByTestId('config-sync-target-dev-001').textContent?.includes('已投递'));
  assert.ok(screen.getByTestId('config-sync-target-dev-002').textContent?.includes('待投递'));
});

// ---------- 派生上下文与权限 ----------

test('派生上下文只读展示（Alias/Site/Region/Subregion/Contract），无输入控件', () => {
  renderPage({ detail: { kind: 'ready', detail: DETAIL, sync: { kind: 'none' } } });
  const context = screen.getByTestId('config-derived-context');
  assert.ok(context.textContent?.includes('食堂1号机'));
  assert.ok(context.textContent?.includes('华东'));
  assert.ok(context.textContent?.includes('HT-2026-001 年度服务合约'));
  assert.ok(context.textContent?.includes('只读'));
  assert.equal(context.querySelector('input, select, textarea'), null);
});

test('Auditor 只读：无新建配置/新建版本按钮，发布禁用', () => {
  renderPage({ role: 'Auditor', detail: { kind: 'ready', detail: DETAIL, sync: { kind: 'none' } } });
  assert.equal(screen.queryByTestId('config-create'), null);
  assert.equal(screen.queryByTestId('config-version-create'), null);
  assert.ok(disabled('config-publish-2'));
});

test('列表与筛选：行渲染；筛选应用与重置；新建配置目标二选一', async () => {
  const user = userEvent.setup();
  const { calls } = renderPage();
  assert.ok(screen.getByTestId('config-row-cfg-001').textContent?.includes('食堂标准配置'));
  await user.type(screen.getByTestId('config-filter-model'), 'FD-100');
  await user.click(screen.getByTestId('config-search'));
  assert.deepEqual(calls.applied, [{ targetModel: 'FD-100', targetDeviceId: null }]);

  await user.click(screen.getByTestId('config-create'));
  const form = screen.getByTestId('config-create-form');
  await user.type(within(form).getByTestId('config-name'), '新型号配置');
  await user.selectOptions(within(form).getByTestId('config-target-kind'), 'device');
  await user.type(within(form).getByTestId('config-target-value'), 'dev-009');
  await user.click(within(form).getByTestId('config-create-submit'));
  await screen.findByTestId('action-notice');
  assert.deepEqual(calls.created, [{ name: '新型号配置', targetDeviceId: 'dev-009' }]);
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

test('API 装配：create/versions/publish 路径与封闭请求体（仅 DEC-018 四字段）', async () => {
  const { api, calls } = stubApi();
  await createConfiguration(api, { name: 'n', targetModel: 'FD-100' });
  assert.equal(calls[0]?.path, '/admin/configurations');
  assert.deepEqual(calls[0]?.options.body, { name: 'n', targetModel: 'FD-100' });

  await createConfigurationVersion(api, 'cfg-1', {
    payload: { heartbeatInterval: 60, telemetryInterval: 30, cameraRefreshInterval: 1, temperatureThreshold: 80 },
  });
  assert.equal(calls[1]?.path, '/admin/configurations/cfg-1/versions');
  const body = calls[1]?.options.body as { payload: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.payload).sort(), [
    'cameraRefreshInterval',
    'heartbeatInterval',
    'telemetryInterval',
    'temperatureThreshold',
  ]);

  await publishConfigurationVersion(api, 'cfg-1', 2, { reason: 'r' });
  assert.equal(calls[2]?.path, '/admin/configurations/cfg-1/versions/2/publish');
  assert.deepEqual(calls[2]?.options.body, { reason: 'r' });

  await fetchConfigurationVersionStatus(api, 'cfg-1', 2);
  assert.equal(calls[3]?.path, '/admin/configurations/cfg-1/versions/2/status');
});
