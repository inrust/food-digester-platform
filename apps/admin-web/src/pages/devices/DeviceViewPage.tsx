import { translate } from '../../i18n/i18n.js';
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
import { UnitValueText } from '../../components/LocaleValue.js';
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
  | {
      readonly status: 'idle';
    }
  | {
      readonly status: 'loading';
    }
  | {
      readonly status: 'error';
      readonly error: unknown;
    }
  | {
      readonly status: 'ready';
      readonly console: DeviceConsoleView;
    };
export type MediaState =
  | {
      readonly status: 'idle' | 'loading' | 'empty';
    }
  | {
      readonly status: 'error';
      readonly error: unknown;
    }
  | {
      readonly status: 'ready';
      readonly media: MediaDownloadUrlView;
    };
export type ActivityState =
  | {
      readonly status: 'idle' | 'loading';
    }
  | {
      readonly status: 'error';
      readonly error: unknown;
    }
  | {
      readonly status: 'ready';
      readonly items: readonly DeviceActivityView[];
      readonly nextCursor: string | null;
    };
export interface DeviceViewPageProps {
  /** 当前选中设备（静态信息）；null = 未选择。 */
  readonly device: DeviceView | null;
  readonly consoleState: ConsoleState;
  readonly mediaState?: MediaState;
  readonly activityState?: ActivityState;
  readonly filterOptions: {
    readonly regions: readonly FilterOption[];
    readonly subregions: readonly (FilterOption & {
      region: string;
    })[];
    readonly sites: readonly (FilterOption & {
      subregion: string;
    })[];
    readonly devices: readonly (FilterOption & {
      siteId: string;
    })[];
  };
  readonly onApply: (deviceId: string) => void;
  readonly onRefreshConsole: () => void;
  readonly onLoadMoreActivities?: (cursor: string) => void;
}
function StaleTag({ block }: { block: ObservedBlockView }) {
  if (block.stale) {
    return (
      <span className="stale-tag" data-testid="stale-tag">
        {translate('page.e7ebfebaaa0f')}
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
          {translate('page.42eb4b882837')}
          <TimeText iso={block.observedAt} />
        </>
      ) : (
        translate('page.03b75144b66f')
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
          {translate('page.7d0639497c7e')}
          <TimeText iso={view.generatedAt} />
        </span>
      </div>

      <section data-testid="console-components">
        <h5>{translate('page.73d4f3b8c647')}</h5>
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
        <h5>{translate('page.6884d266470b')}</h5>
        <StaleTag block={view.metrics} />
        <ObservedAt block={view.metrics} />
        <div className="sensor-grid">
          {SENSOR_METRICS.map(({ key, label }) => {
            const metric = view.metrics.metrics[key];
            return (
              <div className="sensor-item" key={key} data-testid={`sensor-${key}`}>
                <div className="label">{label}</div>
                <div className="value">
                  {metric !== null && metric !== undefined ? (
                    <UnitValueText value={metric.avg} unit={metric.unit} />
                  ) : (
                    '—'
                  )}
                </div>
                {metric !== null && metric !== undefined ? (
                  <div className="sub">
                    {translate('page.31793b6729a3') + ' '}
                    <UnitValueText value={metric.min} unit={metric.unit} />
                    {' ' + translate('page.ec5bc3d58c50') + ' '}
                    <UnitValueText value={metric.max} unit={metric.unit} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section data-testid="console-network">
        <h5>{translate('page.0cbda6b52442')}</h5>
        <StaleTag block={view.network} />
        <ObservedAt block={view.network} />
        <span data-testid="network-summary">
          {view.network.networkType ?? '—'}
          {' ' + translate('page.494fc2b1f3b7') + ' '}
          {view.network.signalStrength ?? '—'} · {view.network.networkStatus ?? '—'}
        </span>
      </section>

      <section data-testid="console-consumables">
        <h5>{translate('page.6c9da0502120')}</h5>
        {consumablesOf(view.consumables).map((model) => (
          <ConsumableGauge key={model.consumableType} model={model} />
        ))}
      </section>

      <section data-testid="console-alarms">
        <h5>{translate('page.fbce4cc6eeb8')}</h5>
        {view.recentAlarms.length === 0 ? (
          <p className="empty-state">{translate('page.187b55b399e6')}</p>
        ) : (
          <ul>
            {view.recentAlarms.map((alarm) => (
              <li key={alarm.alarmId} data-testid={`alarm-${alarm.alarmId}`}>
                <span className={`severity severity-${alarm.severity.toLowerCase()}`}>
                  {ALARM_SEVERITY_LABELS[alarm.severity]}
                </span>
                <TimeText iso={alarm.detectedTime} /> {alarm.code}
                {alarm.status === 'CLEARED' ? translate('page.b3cba7f993ce') : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-testid="console-esg7d">
        <h5>{translate('page.c30e41414b6d')}</h5>
        <table aria-label={translate('page.4489236d2197')}>
          <thead>
            <tr>
              <th scope="col">{translate('page.310d525906dc')}</th>
              <th scope="col">{translate('page.bc29ef1306a5')}</th>
              <th scope="col">{translate('page.d309c902a7bb')}</th>
              <th scope="col">{translate('page.e7e6464f1eab')}</th>
            </tr>
          </thead>
          <tbody>
            {view.esgLast7Days.map((day) => (
              <tr key={day.summaryDate} data-testid={`esg-${day.summaryDate}`}>
                <td>{day.summaryDate}</td>
                <td>
                  {day.carbonReductionKg === null ? '—' : <UnitValueText value={day.carbonReductionKg} unit="kg" />}
                </td>
                <td>
                  {day.powerConsumptionKwh === null ? (
                    '—'
                  ) : (
                    <UnitValueText value={day.powerConsumptionKwh} unit="kWh" />
                  )}
                </td>
                <td>{day.feedingWeightKg === null ? '—' : <UnitValueText value={day.feedingWeightKg} unit="kg" />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section data-testid="console-static">
        <h5>{translate('page.d142ca3ba571')}</h5>
        {device !== null ? (
          <dl>
            <dt>{translate('page.4433eb13beca')}</dt>
            <dd>{device.alias ?? '—'}</dd>
            <dt>{translate('page.2b1b63de6e4a')}</dt>
            <dd>{device.serialNumber}</dd>
            <dt>{translate('page.0132ce7298ec')}</dt>
            <dd>{device.model}</dd>
            <dt>{translate('page.ebc803567778')}</dt>
            <dd>{device.hardwareVersion}</dd>
            <dt>{translate('page.0c131e3964eb')}</dt>
            <dd>{device.manufacturer}</dd>
            <dt>{translate('page.8579e19406d9')}</dt>
            <dd>{device.manufactureDate}</dd>
            <dt>{translate('page.467c1137f479')}</dt>
            <dd>{device.customer?.name ?? '—'}</dd>
            <dt>{translate('page.416457bd629b')}</dt>
            <dd>{device.site?.name ?? '—'}</dd>
          </dl>
        ) : (
          <p className="empty-state">{translate('page.e6259fad3409')}</p>
        )}
      </section>

      <section data-testid="console-contract">
        <h5>{translate('page.f91182052930')}</h5>
        {view.contract !== null ? (
          <span data-testid="contract-brief">
            {view.contract.name}（{view.contract.contractNumber}
            {translate('page.a0c7992ea07a') + ' '}
            {view.contract.endAt.slice(0, 10)}
          </span>
        ) : (
          <span className="empty-state">{translate('page.b6a3cc05b4ac')}</span>
        )}
      </section>

      <section data-testid="console-media">
        <h5>{translate('page.da3f0b21a6c2')}</h5>
        {view.latestMedia !== null ? (
          <div data-testid="media-latest">
            <span>
              {view.latestMedia.mediaType}
              {' ' + translate('page.653834c4e946')}
              <TimeText iso={view.latestMedia.captureTime} />
            </span>
            {mediaState.status === 'loading' ? <p role="status">{translate('page.c312345fe133')}</p> : null}
            {mediaState.status === 'error' ? <ErrorNotice error={mediaState.error} onRefresh={onRefresh} /> : null}
            {mediaState.status === 'ready' && view.latestMedia.mediaType === 'IMAGE' ? (
              <img src={mediaState.media.downloadUrl} alt={translate('page.1c15ad1458b0')} data-testid="media-image" />
            ) : null}
            {mediaState.status === 'ready' && view.latestMedia.mediaType === 'VIDEO' ? (
              <video src={mediaState.media.downloadUrl} controls preload="metadata" data-testid="media-video" />
            ) : null}
          </div>
        ) : (
          <p className="empty-state" data-testid="media-empty">
            {translate('page.8d2a5f52dba1')}
          </p>
        )}
        <button type="button" data-testid="media-refresh" onClick={onRefresh}>
          {translate('page.dcc4d58c807c')}
        </button>
      </section>

      <section data-testid="console-activities">
        <h5>{translate('page.4843fb4e490f')}</h5>
        {activityState.status === 'loading' ? <p role="status">{translate('page.9f4aabe409fa')}</p> : null}
        {activityState.status === 'error' ? <ErrorNotice error={activityState.error} onRefresh={onRefresh} /> : null}
        {activityState.status === 'ready' && activityState.items.length === 0 ? (
          <p className="empty-state">{translate('page.a4a410738f67')}</p>
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
            {translate('page.3a0fab4978fb')}
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
          {translate('page.4562024ddec7')}
        </button>
      </div>

      {consoleState.status === 'idle' ? <p className="empty-state">{translate('page.4bca659f8ed9')}</p> : null}
      {consoleState.status === 'loading' ? (
        <div role="status" data-testid="console-loading">
          {translate('page.300ee3dee4dc')}
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
