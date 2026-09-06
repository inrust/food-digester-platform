/**
 * FE-03 业务总览页面（/dashboard）。
 *
 * 布局按原型 index19.html dashboard：指标卡 → 最新告警 → 设备卡片（≤10）。
 * 数据全部来自 BE-DASH-01 getDashboardOverview（Customer 角色由后端强制 scope）；
 * 指标显示单位、统计日（UTC）与数据基准时间（generatedAt）。
 * OTA“升级”入口跳转 /ota/campaigns（FE-13），不直接推送单设备。
 */
import { AxisBadge, FourAxisBadges } from '../../components/FourAxisBadge.js';
import { ConsumableGauge } from '../../components/ConsumableGauge.js';
import { DeviceCommandActions } from '../../components/DeviceCommandActions.js';
import type { CommandSubmitResult } from '../../components/DeviceCommandActions.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { TimeText } from '../../components/TimeText.js';
import { ALARM_SEVERITY_LABELS, consumablesOf, licenseDistributionText, signalText } from './dashboard-state.js';
import type { DashboardOverviewView, DeviceCardView } from './types.js';

export type DashboardPageState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly overview: DashboardOverviewView };

export interface DashboardPageProps {
  readonly state: DashboardPageState;
  readonly onRefresh: () => void;
  readonly onSubmitCommand: (deviceId: string, command: string) => Promise<CommandSubmitResult>;
  readonly onNavigate: (path: string) => void;
}

function MetricCard({ testid, label, value, sub }: { testid: string; label: string; value: string; sub: string }) {
  return (
    <div className="stat-card" data-testid={testid}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

function DeviceCard({
  card,
  onSubmitCommand,
  onNavigate,
}: {
  card: DeviceCardView;
  onSubmitCommand: DashboardPageProps['onSubmitCommand'];
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="device-card" data-testid={`device-card-${card.deviceId}`}>
      <div className="header">
        <span className="name">{card.alias ?? card.serialNumber}</span>
        <AxisBadge axis="connectivity" value={card.connectivity} />
      </div>
      <div className="info">
        <span>ID：{card.deviceId}</span>
        <span>SN：{card.serialNumber}</span>
        <span>固件：{card.firmwareVersion ?? '—'}</span>
        <span data-testid={`signal-${card.deviceId}`}>{signalText(card.networkType, card.signalStrength)}</span>
      </div>
      <FourAxisBadges
        status={{
          connectivity: card.connectivity,
          lifecycle: card.lifecycleStatus,
          operational: card.operationalStatus,
          license: card.licenseStatus,
        }}
      />
      {consumablesOf(card.consumables).map((model) => (
        <ConsumableGauge key={model.consumableType} model={model} />
      ))}
      <div className="actions">
        <DeviceCommandActions deviceId={card.deviceId} actions={card.actions} onSubmit={onSubmitCommand} />
        <button
          type="button"
          data-testid={`action-upgrade-${card.deviceId}`}
          onClick={() => onNavigate('/ota/campaigns')}
        >
          升级
        </button>
      </div>
    </div>
  );
}

export function DashboardPage({ state, onRefresh, onSubmitCommand, onNavigate }: DashboardPageProps) {
  if (state.status === 'loading') {
    return (
      <div role="status" data-testid="dashboard-loading">
        加载中…
      </div>
    );
  }
  if (state.status === 'error') {
    return <ErrorNotice error={state.error} onRefresh={onRefresh} />;
  }

  const { overview } = state;
  return (
    <div className="dashboard-page" data-testid="dashboard-page">
      <p className="data-baseline" data-testid="dashboard-baseline">
        数据基准：
        <TimeText iso={overview.generatedAt} />
        （指标口径以此为基准；ESG 统计日（UTC）：{overview.esgToday.summaryDate}）
      </p>

      <div className="stats-grid">
        <MetricCard
          testid="metric-contracts"
          label="有效合约"
          value={String(overview.contracts.effectiveTotal)}
          sub="服务期内 Contract"
        />
        <MetricCard
          testid="metric-devices"
          label="设备总数"
          value={String(overview.devices.total)}
          sub={`授权分布：${licenseDistributionText(overview.devices.licenseDistribution)}`}
        />
        <MetricCard
          testid="metric-online"
          label="在线设备"
          value={String(overview.devices.online)}
          sub={`总设备 ${overview.devices.total} · 在线率 ${overview.devices.onlineRatePct}%（心跳 ≤ 10 分钟）`}
        />
        <MetricCard
          testid="metric-carbon"
          label="今日估算碳减排"
          value={`${overview.esgToday.carbonReductionKg} kg`}
          sub={`统计日（UTC）：${overview.esgToday.summaryDate}`}
        />
        <MetricCard
          testid="metric-energy"
          label="今日能耗"
          value={`${overview.esgToday.powerConsumptionKwh} kWh`}
          sub={`统计日（UTC）：${overview.esgToday.summaryDate}`}
        />
        <MetricCard
          testid="metric-feeding"
          label="今日处理量"
          value={`${overview.esgToday.feedingWeightKg} kg`}
          sub={`统计日（UTC）：${overview.esgToday.summaryDate}`}
        />
      </div>

      <section className="latest-alarms" data-testid="latest-alarms">
        <h4>最新告警</h4>
        {overview.latestAlarms.length === 0 ? (
          <p className="empty-state" data-testid="alarms-empty">
            暂无活动告警
          </p>
        ) : (
          <ul>
            {overview.latestAlarms.map((alarm) => (
              <li key={alarm.alarmId} data-testid={`alarm-${alarm.alarmId}`}>
                <span className={`severity severity-${alarm.severity.toLowerCase()}`}>
                  {ALARM_SEVERITY_LABELS[alarm.severity]}
                </span>
                <span>
                  设备 {alarm.deviceId} · {alarm.code}
                </span>
                <TimeText iso={alarm.detectedTime} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="device-cards" data-testid="device-cards">
        <h4>全部设备（最多 10 台）</h4>
        {overview.deviceCards.length === 0 ? (
          <p className="empty-state" data-testid="devices-empty">
            暂无设备
          </p>
        ) : (
          <div className="device-grid">
            {overview.deviceCards.map((card) => (
              <DeviceCard key={card.deviceId} card={card} onSubmitCommand={onSubmitCommand} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
