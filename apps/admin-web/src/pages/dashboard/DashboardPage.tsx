import { Button } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
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
import { formatLocaleNumber, formatLocalePercent, formatLocaleUnit } from '../../components/LocaleValue.js';
import { useI18n } from '../../i18n/i18n.js';
import type { ReactNode } from 'react';
import { ALARM_SEVERITY_LABELS, consumablesOf, licenseDistributionText, signalText } from './dashboard-state.js';
import type { DashboardOverviewView, DeviceCardView } from './types.js';
export type DashboardPageState =
  | {
      readonly status: 'loading';
    }
  | {
      readonly status: 'error';
      readonly error: unknown;
    }
  | {
      readonly status: 'ready';
      readonly overview: DashboardOverviewView;
    };
export interface DashboardPageProps {
  readonly state: DashboardPageState;
  readonly onRefresh: () => void;
  readonly onSubmitCommand: (deviceId: string, command: string) => Promise<CommandSubmitResult>;
  readonly onNavigate: (path: string) => void;
}
function MetricCard({
  testid,
  label,
  value,
  sub,
}: {
  testid: string;
  label: string;
  value: ReactNode;
  sub: ReactNode;
}) {
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
  const { language } = useI18n();
  return (
    <div className="device-card" data-testid={`device-card-${card.deviceId}`}>
      <div className="header">
        <span className="name">{card.alias ?? card.serialNumber}</span>
        <AxisBadge axis="connectivity" value={card.connectivity} />
      </div>
      <div className="info">
        <span>ID：{card.deviceId}</span>
        <span>SN：{card.serialNumber}</span>
        <span>
          {translate('page.882b33c96f60')}
          {card.firmwareVersion ?? '—'}
        </span>
        <span data-testid={`signal-${card.deviceId}`}>
          {signalText(card.networkType, card.signalStrength, language)}
        </span>
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
        <DeviceCommandActions
          deviceId={card.deviceId}
          actions={card.capabilities.commands}
          onSubmit={onSubmitCommand}
        />
        <Button
          type="button"
          data-testid={`action-upgrade-${card.deviceId}`}
          disabled={!card.capabilities.ota.allowed}
          title={card.capabilities.ota.denyReason ?? undefined}
          onClick={() => onNavigate('/ota/campaigns')}
        >
          {translate('page.2e8e70958c4a')}
        </Button>
      </div>
    </div>
  );
}
function SectionFailure({ requestId }: { requestId: string }) {
  return (
    <div role="alert" className="error-notice" data-testid="dashboard-section-error">
      {translate('page.af34343d0f0c') + ' '}
      {requestId}）
    </div>
  );
}
export function DashboardPage({ state, onRefresh, onSubmitCommand, onNavigate }: DashboardPageProps) {
  const { language } = useI18n();
  if (state.status === 'loading') {
    return (
      <div role="status" data-testid="dashboard-loading">
        {translate('page.300ee3dee4dc')}
      </div>
    );
  }
  if (state.status === 'error') {
    return <ErrorNotice error={state.error} onRefresh={onRefresh} />;
  }
  const { overview } = state;
  return (
    <div className="dashboard-page" data-testid="dashboard-page">
      <header className="page-header">
        <div>
          <h1>{translate('menu.dashboard')}</h1>
          <p className="dashboard-intro">{translate('design.dashboardDescription')}</p>
        </div>
        <Button type="button" onClick={onRefresh}>
          {translate('common.refresh')}
        </Button>
      </header>
      <p className="data-baseline" data-testid="dashboard-baseline">
        {translate('page.7d0639497c7e')}
        <TimeText iso={overview.generatedAt} />
        {translate('page.5279df8b8a6c')}
        {overview.esgToday.summaryDate}）
      </p>

      {overview.sections.summary.status === 'ERROR' ? (
        <SectionFailure requestId={overview.sections.summary.requestId} />
      ) : (
        <div className="stats-grid">
          <MetricCard
            testid="metric-contracts"
            label={translate('page.ba53b1a55776')}
            value={formatLocaleNumber(overview.contracts.effectiveTotal, language)}
            sub={translate('page.8e8d12dca017')}
          />
          <MetricCard
            testid="metric-devices"
            label={translate('page.11c33ae6c763')}
            value={formatLocaleNumber(overview.devices.total, language)}
            sub={
              translate('page.6137da351e51') + licenseDistributionText(overview.devices.licenseDistribution, language)
            }
          />
          <MetricCard
            testid="metric-online"
            label={translate('page.9c0cfc75a915')}
            value={formatLocaleNumber(overview.devices.online, language)}
            sub={
              translate('page.f9e1968d4dfb') +
              ' ' +
              formatLocaleNumber(overview.devices.total, language) +
              (' ' + translate('page.dda32dfd5c4b') + ' ') +
              formatLocalePercent(overview.devices.onlineRatePct, language)
            }
          />
          <MetricCard
            testid="metric-carbon"
            label={translate('page.8ca3c592fd0c')}
            value={formatLocaleUnit(overview.esgToday.carbonReductionKg, 'kg', language)}
            sub={translate('page.2c118781a7fb') + overview.esgToday.summaryDate}
          />
          <MetricCard
            testid="metric-energy"
            label={translate('page.ec8eab25e340')}
            value={formatLocaleUnit(overview.esgToday.powerConsumptionKwh, 'kWh', language)}
            sub={translate('page.2c118781a7fb') + overview.esgToday.summaryDate}
          />
          <MetricCard
            testid="metric-feeding"
            label={translate('page.d6dfc1d2d22a')}
            value={formatLocaleUnit(overview.esgToday.feedingWeightKg, 'kg', language)}
            sub={translate('page.2c118781a7fb') + overview.esgToday.summaryDate}
          />
        </div>
      )}

      <section className="latest-alarms" data-testid="latest-alarms">
        <h4>{translate('page.d0dfdd94f6d9')}</h4>
        {overview.sections.latestAlarms.status === 'ERROR' ? (
          <SectionFailure requestId={overview.sections.latestAlarms.requestId} />
        ) : overview.latestAlarms.length === 0 ? (
          <p className="empty-state" data-testid="alarms-empty">
            {translate('page.92eb15f3f33a')}
          </p>
        ) : (
          <ul>
            {overview.latestAlarms.map((alarm) => (
              <li key={alarm.alarmId} data-testid={`alarm-${alarm.alarmId}`}>
                <span className={`severity severity-${alarm.severity.toLowerCase()}`}>
                  {ALARM_SEVERITY_LABELS[alarm.severity]}
                </span>
                <span>
                  {translate('page.01f2c16cda65') + ' '}
                  {alarm.deviceId} · {alarm.code}
                </span>
                <TimeText iso={alarm.detectedTime} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="device-cards" data-testid="device-cards">
        <h4>{translate('page.6c2c68d2d64b')}</h4>
        {overview.sections.deviceCards.status === 'ERROR' ? (
          <SectionFailure requestId={overview.sections.deviceCards.requestId} />
        ) : overview.deviceCards.length === 0 ? (
          <p className="empty-state" data-testid="devices-empty">
            {translate('page.2b9379b8f7b5')}
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
