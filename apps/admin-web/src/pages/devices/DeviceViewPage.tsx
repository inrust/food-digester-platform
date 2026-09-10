/**
 * FE-06 查看设备页（/devices/view）：Region/Subregion/Site/Device 联动选择 + 设备控制台。
 *
 * - 每个动态数值显示单位与 observedAt/stale（BE-DEV-05 ObservedBlock）；
 * - 不请求原始 Telemetry 长期表（仅 getDeviceConsole 组合查询）；
 * - 媒体区：仅最新授权 Media 元数据 + 手动刷新（DEC-009：非实时流，不标注“实时视频”，无播放计时）；
 * - 不同设备切换：内容容器以 deviceId 为 key 强制重建，无数据残留；
 * - 403 → 明确无权状态（ErrorNotice）。
 */
import { useState } from 'react';
import { ConsumableGauge } from '../../components/ConsumableGauge.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { FourAxisBadges } from '../../components/FourAxisBadge.js';
import { ScopeFilter } from '../../components/ScopeFilter.js';
import type { FilterOption } from '../../components/ScopeFilter.js';
import { EMPTY_SCOPE_FILTER } from '../../components/filter-state.js';
import type { ScopeFilterValue } from '../../components/filter-state.js';
import { TimeText } from '../../components/TimeText.js';
import { ALARM_SEVERITY_LABELS, consumablesOf } from '../dashboard/dashboard-state.js';
import { COMPONENT_HEALTH_LABELS, COMPONENT_LABELS, SENSOR_METRICS } from './device-state.js';
import type {
  DeviceActivityView,
  DeviceConsoleView,
  DeviceView,
  MediaDownloadUrlView,
  ObservedBlockView,
} from './types.js';

export type ConsoleState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly console: DeviceConsoleView };

export type MediaState =
  | { readonly status: 'idle' | 'loading' | 'empty' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly media: MediaDownloadUrlView };

export type ActivityState =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly items: readonly DeviceActivityView[]; readonly nextCursor: string | null };

export interface DeviceViewPageProps {
  /** 当前选中设备（静态信息）；null = 未选择。 */
  readonly device: DeviceView | null;
  readonly consoleState: ConsoleState;
  readonly mediaState?: MediaState;
  readonly activityState?: ActivityState;
  readonly filterOptions: {
    readonly regions: readonly FilterOption[];
    readonly subregions: readonly (FilterOption & { region: string })[];
    readonly sites: readonly (FilterOption & { subregion: string })[];
    readonly devices: readonly (FilterOption & { siteId: string })[];
  };
  readonly onApply: (deviceId: string) => void;
  readonly onRefreshConsole: () => void;
  readonly onLoadMoreActivities?: (cursor: string) => void;
}

function StaleTag({ block }: { block: ObservedBlockView }) {
  if (block.stale) {
    return (
      <span className="stale-tag" data-testid="stale-tag">
        数据过期
      </span>
    );
  }
  return null;
}

function ObservedAt({ block }: { block: ObservedBlockView }) {
  return (
    <span className="observed-at">
      {block.observedAt !== null ? (
        <>
          观测时间：
          <TimeText iso={block.observedAt} />
        </>
      ) : (
        '无观测数据'
      )}
    </span>
  );
}

function ConsoleContent({
  console: view,
  device,
  onRefresh,
  mediaState = { status: 'idle' },
  activityState = { status: 'idle' },
  onLoadMoreActivities = () => {},
}: {
  console: DeviceConsoleView;
  device: DeviceView | null;
  onRefresh: () => void;
  mediaState: MediaState;
  activityState: ActivityState;
  onLoadMoreActivities: (cursor: string) => void;
}) {
  return (
    <div className="device-console" key={view.device.deviceId} data-testid="device-console">
      <div className="console-header">
        <h4>{view.device.alias ?? view.device.serialNumber}</h4>
        <FourAxisBadges
          status={{
            connectivity: view.device.connectivity,
            lifecycle: view.device.lifecycleStatus,
            operational: view.device.operationalStatus,
            license: view.device.licenseStatus,
          }}
        />
        <span className="data-baseline">
          数据基准：
          <TimeText iso={view.generatedAt} />
        </span>
      </div>

      <section data-testid="console-components">
        <h5>部件状态（传感器健康）</h5>
        <StaleTag block={view.components} />
        <ObservedAt block={view.components} />
        <div className="status-grid">
          {(Object.keys(COMPONENT_LABELS) as (keyof typeof COMPONENT_LABELS)[]).map((key) => {
            const value = view.components.status[key];
            return (
              <div className="status-item" key={key} data-testid={`component-${key}`}>
                <span className="label">{COMPONENT_LABELS[key]}</span>
                <span className={`value health-${(value ?? 'unknown').toLowerCase()}`}>
                  {value !== null ? COMPONENT_HEALTH_LABELS[value] : '—'}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section data-testid="console-sensors">
        <h5>最新传感器读数（10 类）</h5>
        <StaleTag block={view.metrics} />
        <ObservedAt block={view.metrics} />
        <div className="sensor-grid">
          {SENSOR_METRICS.map(({ key, label }) => {
            const metric = view.metrics.metrics[key];
            return (
              <div className="sensor-item" key={key} data-testid={`sensor-${key}`}>
                <div className="label">{label}</div>
                <div className="value">
                  {metric !== null && metric !== undefined ? `${metric.avg} ${metric.unit}` : '—'}
                </div>
                {metric !== null && metric !== undefined ? (
                  <div className="sub">
                    最小 {metric.min} / 最大 {metric.max} {metric.unit}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section data-testid="console-network">
        <h5>网络</h5>
        <StaleTag block={view.network} />
        <ObservedAt block={view.network} />
        <span data-testid="network-summary">
          {view.network.networkType ?? '—'} · 信号 {view.network.signalStrength ?? '—'} ·{' '}
          {view.network.networkStatus ?? '—'}
        </span>
      </section>

      <section data-testid="console-consumables">
        <h5>耗材</h5>
        {consumablesOf(view.consumables).map((model) => (
          <ConsumableGauge key={model.consumableType} model={model} />
        ))}
      </section>

      <section data-testid="console-alarms">
        <h5>最近告警</h5>
        {view.recentAlarms.length === 0 ? (
          <p className="empty-state">暂无告警</p>
        ) : (
          <ul>
            {view.recentAlarms.map((alarm) => (
              <li key={alarm.alarmId} data-testid={`alarm-${alarm.alarmId}`}>
                <span className={`severity severity-${alarm.severity.toLowerCase()}`}>
                  {ALARM_SEVERITY_LABELS[alarm.severity]}
                </span>
                <TimeText iso={alarm.detectedTime} /> {alarm.code}
                {alarm.status === 'CLEARED' ? '（已恢复）' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-testid="console-esg7d">
        <h5>近 7 日 ESG</h5>
        <table aria-label="近7日ESG">
          <thead>
            <tr>
              <th scope="col">日期（UTC）</th>
              <th scope="col">碳减排 (kg)</th>
              <th scope="col">能耗 (kWh)</th>
              <th scope="col">处理量 (kg)</th>
            </tr>
          </thead>
          <tbody>
            {view.esgLast7Days.map((day) => (
              <tr key={day.summaryDate} data-testid={`esg-${day.summaryDate}`}>
                <td>{day.summaryDate}</td>
                <td>{day.carbonReductionKg ?? '—'}</td>
                <td>{day.powerConsumptionKwh ?? '—'}</td>
                <td>{day.feedingWeightKg ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section data-testid="console-static">
        <h5>设备静态信息</h5>
        {device !== null ? (
          <dl>
            <dt>设备名称</dt>
            <dd>{device.alias ?? '—'}</dd>
            <dt>唯一ID</dt>
            <dd>{device.serialNumber}</dd>
            <dt>型号</dt>
            <dd>{device.model}</dd>
            <dt>硬件版本</dt>
            <dd>{device.hardwareVersion}</dd>
            <dt>厂商</dt>
            <dd>{device.manufacturer}</dd>
            <dt>生产日期</dt>
            <dd>{device.manufactureDate}</dd>
            <dt>所属客户</dt>
            <dd>{device.customer?.name ?? '—'}</dd>
            <dt>所属站点</dt>
            <dd>{device.site?.name ?? '—'}</dd>
          </dl>
        ) : (
          <p className="empty-state">静态信息未加载</p>
        )}
      </section>

      <section data-testid="console-contract">
        <h5>关联合约</h5>
        {view.contract !== null ? (
          <span data-testid="contract-brief">
            {view.contract.name}（{view.contract.contractNumber}）· 至 {view.contract.endAt.slice(0, 10)}
          </span>
        ) : (
          <span className="empty-state">无有效合约</span>
        )}
      </section>

      <section data-testid="console-media">
        <h5>最新授权媒体（非实时画面）</h5>
        {view.latestMedia !== null ? (
          <div data-testid="media-latest">
            <span>
              {view.latestMedia.mediaType} · 采集时间：
              <TimeText iso={view.latestMedia.captureTime} />
            </span>
            {mediaState.status === 'loading' ? <p role="status">正在签发短期访问地址…</p> : null}
            {mediaState.status === 'error' ? <ErrorNotice error={mediaState.error} onRefresh={onRefresh} /> : null}
            {mediaState.status === 'ready' && view.latestMedia.mediaType === 'IMAGE' ? (
              <img src={mediaState.media.downloadUrl} alt="设备最新授权画面" data-testid="media-image" />
            ) : null}
            {mediaState.status === 'ready' && view.latestMedia.mediaType === 'VIDEO' ? (
              <video src={mediaState.media.downloadUrl} controls preload="metadata" data-testid="media-video" />
            ) : null}
          </div>
        ) : (
          <p className="empty-state" data-testid="media-empty">
            暂无已授权媒体
          </p>
        )}
        <button type="button" data-testid="media-refresh" onClick={onRefresh}>
          刷新最新媒体
        </button>
      </section>

      <section data-testid="console-activities">
        <h5>设备活动历史</h5>
        {activityState.status === 'loading' ? <p role="status">加载活动历史…</p> : null}
        {activityState.status === 'error' ? <ErrorNotice error={activityState.error} onRefresh={onRefresh} /> : null}
        {activityState.status === 'ready' && activityState.items.length === 0 ? (
          <p className="empty-state">暂无活动</p>
        ) : null}
        {activityState.status === 'ready' && activityState.items.length > 0 ? (
          <ul>
            {activityState.items.map((activity) => (
              <li key={activity.activityId} data-testid={`activity-${activity.activityId}`}>
                <span className={`severity severity-${activity.level.toLowerCase()}`}>{activity.level}</span>{' '}
                <TimeText iso={activity.occurredAt} /> · {activity.kind} · {activity.summary}
              </li>
            ))}
          </ul>
        ) : null}
        {activityState.status === 'ready' && activityState.nextCursor !== null ? (
          <button type="button" onClick={() => onLoadMoreActivities(activityState.nextCursor ?? '')}>
            加载更多
          </button>
        ) : null}
      </section>
    </div>
  );
}

export function DeviceViewPage({
  device,
  consoleState,
  mediaState = { status: 'idle' },
  activityState = { status: 'idle' },
  filterOptions,
  onApply,
  onRefreshConsole,
  onLoadMoreActivities = () => {},
}: DeviceViewPageProps) {
  const [scope, setScope] = useState<ScopeFilterValue>(EMPTY_SCOPE_FILTER);

  return (
    <div className="device-view-page" data-testid="device-view-page">
      <div className="filter-bar" data-testid="view-filter-bar">
        <ScopeFilter
          regions={filterOptions.regions}
          subregions={filterOptions.subregions}
          sites={filterOptions.sites}
          devices={filterOptions.devices}
          value={scope}
          onChange={setScope}
        />
        <button
          type="button"
          className="primary-button"
          data-testid="view-apply"
          disabled={scope.deviceId === null || scope.deviceId === undefined}
          onClick={() => {
            if (scope.deviceId !== null && scope.deviceId !== undefined) onApply(scope.deviceId);
          }}
        >
          应用
        </button>
      </div>

      {consoleState.status === 'idle' ? <p className="empty-state">请选择设备后点击“应用”</p> : null}
      {consoleState.status === 'loading' ? (
        <div role="status" data-testid="console-loading">
          加载中…
        </div>
      ) : null}
      {consoleState.status === 'error' ? <ErrorNotice error={consoleState.error} onRefresh={onRefreshConsole} /> : null}
      {consoleState.status === 'ready' ? (
        <ConsoleContent
          console={consoleState.console}
          device={device}
          onRefresh={onRefreshConsole}
          mediaState={mediaState}
          activityState={activityState}
          onLoadMoreActivities={onLoadMoreActivities}
        />
      ) : null}
    </div>
  );
}
