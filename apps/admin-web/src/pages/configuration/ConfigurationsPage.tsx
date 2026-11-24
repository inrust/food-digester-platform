import { FilterBar } from '../../components/FilterBar.js';
import { Button, Input, TextArea } from '../../components/ui.js';
import { translate, useI18n } from '../../i18n/i18n.js';
import type { DeviceView } from '../devices/types.js';
/**
 * FE-09 Configuration 管理页（/configurations）：DEC-018@1.0.0 V1 四字段配置。
 *
 * - 只渲染 Heartbeat/Telemetry/Camera Refresh/温度阈值四字段（单位/范围/默认值来自
 *   DEC-018 策略常量，parity 测试与冻结策略 JSON 双向锁定）；
 * - 候选扩展字段（图像/旋转/电机/温度上下限/语言/云域名/NTP）不渲染为任何字段；
 * - 历史版本不可变：版本列表只读展示（含 payload 四字段与单位），仅 DRAFT 可发布；
 *   新值只能经“新建版本”（不可变版本递增）进入；
 * - 发布生成 CONFIG_CHANGED；同步状态 = 每目标设备通知投递状态（PENDING/PUBLISHED/FAILED）；
 * - 派生上下文（Alias/Site/Region/Subregion/Contract）只读展示，不得随配置提交；
 * - 前端预校验仅体验层，后端 VALIDATION_FAILED 原样呈现。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { hasPermission } from '@fdp/auth/browser';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { NumberText, UnitValueText } from '../../components/LocaleValue.js';
import { TimeText, useUserTimeZone } from '../../components/TimeText.js';
import { zonedDateTimeToUtcIso } from '../../components/date-time.js';
import { ConfigurationEffectiveDevices } from './ConfigurationEffectiveDevices.js';
import type {
  ConfigurationDetailView,
  ConfigurationEffectiveDevicePage,
  ConfigurationPayloadView,
  ConfigurationSummaryView,
  ConfigurationSyncStatusView,
  ConfigurationVersionView,
} from './types.js';
import {
  CONFIG_SYNC_STATUS_LABELS,
  CONFIG_V1_FIELDS,
  CONFIG_VERSION_STATUS_LABELS,
  defaultConfigPayload,
  validateConfigPayload,
} from './configuration-state.js';
import type { ConfigFieldKey } from './configuration-state.js';
export type SyncStatusState =
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'loading';
      readonly version: number;
    }
  | {
      readonly kind: 'error';
      readonly version: number;
      readonly error: unknown;
    }
  | {
      readonly kind: 'ready';
      readonly data: ConfigurationSyncStatusView;
    };

function localeUnitForConfig(unit: string): string {
  if (unit === 'seconds') return 's';
  if (unit === 'minutes') return 'min';
  return '°C';
}
export type ConfigurationDetailState =
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'loading';
    }
  | {
      readonly kind: 'error';
      readonly error: unknown;
    }
  | {
      readonly kind: 'ready';
      readonly detail: ConfigurationDetailView;
      readonly sync: Readonly<Partial<Record<number, SyncStatusState>>>;
      readonly refreshing?: boolean;
    };
export interface ConfigurationFilter {
  readonly targetModel: string | null;
  readonly targetDeviceId: string | null;
}
export const EMPTY_CONFIGURATION_FILTER: ConfigurationFilter = { targetModel: null, targetDeviceId: null };
export interface ConfigurationsPageProps {
  readonly role: Role;
  readonly device?: DeviceView;
  readonly list: {
    readonly rows: readonly ConfigurationSummaryView[] | null;
    readonly loading?: boolean;
    readonly error?: unknown;
  };
  readonly appliedFilter: ConfigurationFilter;
  readonly onApplyFilter: (filter: ConfigurationFilter) => void;
  readonly onRefresh: () => void;
  readonly detail: ConfigurationDetailState;
  readonly onSelect: (configurationId: string) => void;
  readonly onCloseDetail: () => void;
  readonly onLoadSyncStatus: (version: number) => void;
  readonly onLoadEffectiveDevices: (id: string, cursor: string | null) => Promise<ConfigurationEffectiveDevicePage>;
  readonly onCreate: (input: {
    name: string;
    targetModel?: string;
    targetDeviceId?: string;
    reason?: string;
  }) => Promise<ConfigurationSummaryView>;
  readonly onCreateVersion: (
    configurationId: string,
    input: {
      payload: ConfigurationPayloadView;
      changeNote?: string;
      reason?: string;
    },
  ) => Promise<ConfigurationVersionView>;
  readonly onPublish: (
    configurationId: string,
    version: number,
    input: {
      effectiveAt?: string;
      reason?: string;
    },
  ) => Promise<unknown>;
}
export function ConfigurationsPage({
  role,
  device,
  list,
  appliedFilter,
  onApplyFilter,
  onRefresh,
  detail,
  onSelect,
  onCloseDetail,
  onLoadSyncStatus,
  onLoadEffectiveDevices,
  onCreate,
  onCreateVersion,
  onPublish,
}: ConfigurationsPageProps) {
  const [draftFilter, setDraftFilter] = useState<ConfigurationFilter>(appliedFilter);
  const [createOpen, setCreateOpen] = useState(false);
  const [versionFormOpen, setVersionFormOpen] = useState(false);
  const [versionTemplate, setVersionTemplate] = useState<ConfigurationPayloadView>();
  const [publishTarget, setPublishTarget] = useState<number | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const detailRefreshing = detail.kind === 'ready' && detail.refreshing === true;
  const canWrite = hasPermission(role, 'config:publish');
  const detailView = detail.kind === 'ready' ? detail.detail : null;
  const runAction = async (execute: () => Promise<unknown>, successText: string) => {
    // 防重复点击：在途请求直接忽略（后端 409/幂等兜底）
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setCreateOpen(false);
    setVersionFormOpen(false);
    setPublishTarget(null);
    setActionError(null);
    setNotice(null);
    try {
      await execute();
      setNotice(successText);
      onRefresh();
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="configurations-page" data-testid="configurations-page">
      <header className="page-header">
        <h1>{translate('design.page.configurations')}</h1>
      </header>
      {canWrite ? (
        <div className="page-toolbar" data-testid="config-toolbar">
          <Button
            type="button"
            className="primary-button"
            data-testid="config-create"
            onClick={() => setCreateOpen(true)}
          >
            {translate('page.31cc2c4c86f0')}
          </Button>
        </div>
      ) : null}
      {device !== undefined ? (
        <p data-testid="configuration-device-scope">
          {translate('deviceWorkbench.scope', { name: device.alias ?? device.serialNumber, id: device.id })}
        </p>
      ) : (
        <FilterBar
          testId="config-filter-bar"
          actions={
            <>
              <Button
                type="button"
                className="primary-button"
                data-testid="config-search"
                onClick={() => onApplyFilter(draftFilter)}
              >
                {translate('page.f04090805c6e')}
              </Button>
              <Button
                type="button"
                data-testid="config-reset"
                onClick={() => {
                  setDraftFilter(EMPTY_CONFIGURATION_FILTER);
                  onApplyFilter(EMPTY_CONFIGURATION_FILTER);
                }}
              >
                {translate('page.3d81345303ab')}
              </Button>
            </>
          }
        >
          <div className="filter-field">
            <label htmlFor="config-filter-model">{translate('page.418dfc356a6d')}</label>
            <Input
              id="config-filter-model"
              data-testid="config-filter-model"
              value={draftFilter.targetModel ?? ''}
              onChange={(event) => setDraftFilter({ ...draftFilter, targetModel: event.target.value })}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="config-filter-device">{translate('page.1b73f8fcde1b')}</label>
            <Input
              id="config-filter-device"
              data-testid="config-filter-device"
              value={draftFilter.targetDeviceId ?? ''}
              onChange={(event) => setDraftFilter({ ...draftFilter, targetDeviceId: event.target.value })}
            />
          </div>
        </FilterBar>
      )}

      {notice !== null && detail.kind === 'none' ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null && detail.kind === 'none' ? (
        <ErrorNotice error={actionError} onRefresh={onRefresh} />
      ) : null}

      {list.error !== undefined ? <ErrorNotice error={list.error} onRefresh={onRefresh} /> : null}
      {list.rows === null ? (
        <div role="status" data-testid="config-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : list.rows.length === 0 ? (
        <p className="empty-state" data-testid="config-empty">
          {translate('page.bb7031ae5844')}
        </p>
      ) : (
        <div className="table-scroll" role="region" aria-label={translate('page.455fb42de709')} tabIndex={0}>
          <table aria-label={translate('page.455fb42de709')} data-testid="config-table">
            <thead>
              <tr>
                <th scope="col">{translate('page.1be7ae4fc257')}</th>
                <th scope="col">{translate('page.941f08313a1d')}</th>
                <th scope="col">{translate('page.0aba1045c82b')}</th>
                <th scope="col">{translate('page.ac7d92446ab6')}</th>
                <th scope="col">{translate('page.787ad1deae49')}</th>
                <th scope="col">{translate('page.84e3802f60a7')}</th>
                <th scope="col">{translate('page.f3ea6d345e2a')}</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={row.configurationId} data-testid={`config-row-${row.configurationId}`}>
                  <td>{row.name}</td>
                  <td>
                    {row.targetModel !== null
                      ? translate('page.0132ce7298ec') + ' ' + row.targetModel
                      : translate('page.01f2c16cda65') + ' ' + (row.targetDeviceId ?? '')}
                  </td>
                  <td>
                    <NumberText value={row.versionCount} />
                  </td>
                  <td>{row.latestPublishedVersion !== null ? `v${row.latestPublishedVersion}` : '—'}</td>
                  <td>{row.createdBy}</td>
                  <td>
                    <TimeText iso={row.createdAt} />
                  </td>
                  <td>
                    <Button
                      type="button"
                      data-testid={`config-detail-open-${row.configurationId}`}
                      onClick={() => {
                        setActionError(null);
                        setNotice(null);
                        onSelect(row.configurationId);
                      }}
                    >
                      {translate('page.4f55ee1e687f')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={detail.kind !== 'none'}
        title={translate('page.eefaf4d5e099')}
        width={880}
        testid="config-detail"
        onClose={() => {
          setActionError(null);
          setNotice(null);
          onCloseDetail();
        }}
      >
        {detail.kind === 'loading' || detailRefreshing ? (
          <p role="status" data-testid="config-detail-loading">
            {translate('page.300ee3dee4dc')}
          </p>
        ) : null}
        {detail.kind === 'error' ? (
          <div className="detail-stack">
            <ErrorNotice error={detail.error} />
            <div className="detail-actions">
              <Button type="button" onClick={onRefresh}>
                {translate('detail.retry')}
              </Button>
            </div>
          </div>
        ) : null}
        {notice !== null ? (
          <p className="action-notice" role="status" data-testid="action-notice">
            {notice}
          </p>
        ) : null}
        {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}
        {detailView !== null && detail.kind === 'ready' ? (
          <div className="detail-stack">
            <div className="detail-grid">
              <section className="detail-card" aria-label={translate('detail.configuration.summary')}>
                <h4>{translate('detail.configuration.summary')}</h4>
                <dl>
                  <dt>{translate('page.1be7ae4fc257')}</dt>
                  <dd>{detailView.name}</dd>
                  <dt>{translate('detail.configuration.id')}</dt>
                  <dd>{detailView.configurationId}</dd>
                  <dt>{translate('page.0aba1045c82b')}</dt>
                  <dd>
                    <NumberText value={detailView.versionCount} />
                  </dd>
                  <dt>{translate('page.ac7d92446ab6')}</dt>
                  <dd data-testid="config-latest-published">
                    {detailView.latestPublishedVersion !== null
                      ? `v${detailView.latestPublishedVersion}`
                      : translate('page.ff233aab26c8')}
                  </dd>
                  <dt>{translate('page.787ad1deae49')}</dt>
                  <dd>{detailView.createdBy}</dd>
                  <dt>{translate('page.84e3802f60a7')}</dt>
                  <dd>
                    <TimeText iso={detailView.createdAt} />
                  </dd>
                </dl>
              </section>
              <section className="detail-card" aria-label={translate('page.941f08313a1d')}>
                <h4>{translate('page.941f08313a1d')}</h4>
                <dl>
                  <dt>{translate('page.0132ce7298ec')}</dt>
                  <dd>{detailView.targetModel ?? '—'}</dd>
                  <dt>{translate('page.01f2c16cda65')}</dt>
                  <dd>{detailView.targetDeviceId ?? '—'}</dd>
                </dl>
              </section>
              {detailView.derivedContext !== null ? (
                <section
                  className="detail-card"
                  data-testid="config-derived-context"
                  aria-label={translate('page.8de234dc2f9d')}
                >
                  <h4>{translate('page.8de234dc2f9d')}</h4>
                  <dl>
                    <dt>{translate('page.270ec5a97320')}</dt>
                    <dd>{detailView.derivedContext.alias ?? '—'}</dd>
                    <dt>{translate('page.619bc67325a4')}</dt>
                    <dd>{detailView.derivedContext.site ?? '—'}</dd>
                    <dt>{translate('page.17fc93c9cdbb')}</dt>
                    <dd>{detailView.derivedContext.region ?? '—'}</dd>
                    <dt>{translate('page.e1973949d60a')}</dt>
                    <dd>{detailView.derivedContext.subregion ?? '—'}</dd>
                    <dt>{translate('page.72045015ab9e')}</dt>
                    <dd>
                      {detailView.derivedContext.contract !== null
                        ? `${detailView.derivedContext.contract.contractNumber} ${detailView.derivedContext.contract.name}`
                        : '—'}
                    </dd>
                  </dl>
                </section>
              ) : null}
            </div>
            {canWrite ? (
              <div className="detail-actions">
                <Button
                  type="button"
                  className="primary-button"
                  data-testid="config-version-create"
                  disabled={busy || detailRefreshing}
                  onClick={() => {
                    setVersionTemplate(undefined);
                    setVersionFormOpen(true);
                  }}
                >
                  {translate('page.c87926d3eb9a')}
                </Button>
              </div>
            ) : null}
            <ConfigurationEffectiveDevices
              key={detailView.configurationId}
              configurationId={detailView.configurationId}
              onLoadPage={onLoadEffectiveDevices}
              refreshing={detailRefreshing}
            />
            <section className="detail-card" aria-label={translate('page.8770418ba3a0')}>
              <h4>{translate('page.8770418ba3a0')}</h4>
              {detailView.versions.length === 0 ? (
                <p className="empty-state" data-testid="config-versions-empty">
                  {translate('page.123892c99043')}
                </p>
              ) : (
                <div
                  className="config-history-scroll"
                  role="region"
                  aria-label={translate('page.8770418ba3a0')}
                  tabIndex={0}
                  data-testid="config-history-scroll"
                >
                  {[...detailView.versions]
                    .sort((left, right) => right.version - left.version)
                    .map((v) => (
                      <VersionCard
                        key={v.versionId}
                        version={v}
                        canWrite={canWrite}
                        busy={busy || detailRefreshing}
                        sync={detail.sync[v.version] ?? { kind: 'none' }}
                        onPublishIntent={() => setPublishTarget(v.version)}
                        onCopyVersion={() => {
                          setVersionTemplate(v.payload);
                          setVersionFormOpen(true);
                        }}
                        onLoadSyncStatus={() => onLoadSyncStatus(v.version)}
                      />
                    ))}
                </div>
              )}
            </section>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={createOpen}
        title={translate('page.31cc2c4c86f0')}
        testid="config-create-dialog"
        onClose={() => setCreateOpen(false)}
      >
        <CreateConfigurationForm
          busy={busy}
          {...(device !== undefined ? { deviceId: device.id } : {})}
          onSubmit={(input) => void runAction(() => onCreate(input), translate('page.34c0d9de5819'))}
        />
      </Modal>

      {detailView !== null ? (
        <Modal
          open={versionFormOpen}
          title={translate('page.da94d8657eb9')}
          testid="config-version-dialog"
          onClose={() => setVersionFormOpen(false)}
        >
          <VersionPayloadForm
            busy={busy}
            initialPayload={versionTemplate ?? defaultConfigPayload()}
            onSubmit={(payload, changeNote, reason) =>
              void runAction(
                () =>
                  onCreateVersion(detailView.configurationId, {
                    payload,
                    ...(changeNote !== '' ? { changeNote } : {}),
                    ...(reason !== '' ? { reason } : {}),
                  }),
                translate('page.bf8cd5ec392e'),
              )
            }
          />
        </Modal>
      ) : null}

      {detailView !== null && publishTarget !== null ? (
        <Modal
          open
          title={translate('page.60ad6614ebc6') + publishTarget}
          testid="config-publish-dialog"
          onClose={() => setPublishTarget(null)}
        >
          <PublishForm
            busy={busy}
            onSubmit={(effectiveAt, reason) =>
              void runAction(
                () =>
                  onPublish(detailView.configurationId, publishTarget, {
                    ...(effectiveAt !== '' ? { effectiveAt } : {}),
                    ...(reason !== '' ? { reason } : {}),
                  }),
                translate('page.48e411134914') + publishTarget + (' ' + translate('page.86f0b8ff2d6f')),
              )
            }
          />
        </Modal>
      ) : null}
    </div>
  );
}
function VersionCard({
  version,
  canWrite,
  busy,
  sync,
  onPublishIntent,
  onCopyVersion,
  onLoadSyncStatus,
}: {
  readonly version: ConfigurationVersionView;
  readonly canWrite: boolean;
  readonly busy: boolean;
  readonly sync: SyncStatusState;
  readonly onPublishIntent: () => void;
  readonly onCopyVersion: () => void;
  readonly onLoadSyncStatus: () => void;
}) {
  const publishable = version.status === 'DRAFT';
  const [settingsJsonVisible, setSettingsJsonVisible] = useState(false);
  return (
    <details
      className="config-history-entry"
      name="configuration-history"
      data-testid={`config-version-${version.version}`}
      data-status={version.status}
    >
      <summary data-testid={`config-expand-${version.version}`}>
        <strong>v{version.version}</strong>
        <span data-testid={`config-version-${version.version}-status`}>
          {CONFIG_VERSION_STATUS_LABELS[version.status] ?? version.status}
        </span>
      </summary>
      <div className="version-card detail-card">
        <dl>
          <dt>{translate('page.84e3802f60a7')}</dt>
          <dd>
            <TimeText iso={version.createdAt} />
          </dd>
          {version.effectiveAt !== null ? (
            <>
              <dt>{translate('page.ba06f7a98566')}</dt>
              <dd>
                <TimeText iso={version.effectiveAt} />
              </dd>
            </>
          ) : null}
          {version.changeNote !== null ? (
            <>
              <dt>{translate('detail.configuration.changeNote')}</dt>
              <dd>{version.changeNote}</dd>
            </>
          ) : null}
        </dl>
        {/* 历史版本只读：payload 仅展示，不提供编辑入口（不可变版本） */}
        <dl className="version-payload" data-testid={`config-version-${version.version}-payload`}>
          {CONFIG_V1_FIELDS.map((field) => (
            <div key={field.key}>
              <dt>
                {field.label}（{field.unitLabel}）
              </dt>
              <dd data-testid={`config-version-${version.version}-field-${field.key}`}>
                <UnitValueText value={version.payload[field.key]} unit={localeUnitForConfig(field.unit)} />
              </dd>
            </div>
          ))}
        </dl>
        {settingsJsonVisible ? (
          <pre data-testid={`config-settings-json-${version.version}`}>{JSON.stringify(version.payload, null, 2)}</pre>
        ) : null}
        <div className="action-row">
          <Button
            type="button"
            aria-expanded={settingsJsonVisible}
            onClick={() => setSettingsJsonVisible(!settingsJsonVisible)}
          >
            {translate('configuration.delivery.viewSettingsJson')}
          </Button>
          <Button
            type="button"
            className="primary-button"
            data-testid={`config-publish-${version.version}`}
            disabled={!publishable || !canWrite || busy}
            {...(!publishable ? { title: translate('page.956bedba1a79') } : {})}
            onClick={onPublishIntent}
          >
            {translate('page.94f172d02f5e')}
          </Button>
          {version.status === 'PUBLISHED' && canWrite ? (
            <Button
              type="button"
              disabled={busy}
              data-testid={`config-copy-${version.version}`}
              onClick={onCopyVersion}
            >
              {translate('configuration.delivery.copyVersion')}
            </Button>
          ) : null}
          {version.status === 'PUBLISHED' ? (
            <Button
              type="button"
              disabled={busy}
              data-testid={`config-sync-${version.version}`}
              onClick={onLoadSyncStatus}
            >
              {translate('page.0150205d5c21')}
            </Button>
          ) : null}
        </div>
        {sync.kind === 'loading' && sync.version === version.version ? (
          <div role="status" data-testid={`config-sync-loading-${version.version}`}>
            {translate('page.300ee3dee4dc')}
          </div>
        ) : null}
        {sync.kind === 'error' && sync.version === version.version ? (
          <p className="error-notice" data-testid={`config-sync-error-${version.version}`}>
            {translate('page.fb3bcf09c86d')}
          </p>
        ) : null}
        {sync.kind === 'ready' && sync.data.version === version.version ? (
          <>
            <p className="field-hint">{translate('detail.configuration.notificationStatus')}</p>
            {sync.data.targets.length === 0 ? (
              <p className="empty-state" data-testid={`config-sync-empty-${version.version}`}>
                {translate('detail.configuration.noNotifications')}
              </p>
            ) : (
              <ul data-testid={`config-sync-targets-${version.version}`}>
                {sync.data.targets.map((t) => (
                  <li key={t.deviceId} data-testid={`config-sync-target-${t.deviceId}`}>
                    <strong>{t.deviceId}</strong>
                    <div>
                      {translate('configuration.delivery.notification')} ·{' '}
                      {CONFIG_SYNC_STATUS_LABELS[t.notificationStatus] ?? t.notificationStatus}
                    </div>
                    <div>
                      {translate('configuration.delivery.delivered')} ·{' '}
                      {t.delivery?.receivedAt ? (
                        <TimeText iso={t.delivery.receivedAt} />
                      ) : (
                        translate(
                          t.delivery ? 'configuration.delivery.awaitingReceipt' : 'configuration.delivery.unknown',
                        )
                      )}
                    </div>
                    <div>
                      {translate('configuration.devices.applied')} ·{' '}
                      {t.delivery?.appliedAt ? (
                        <TimeText iso={t.delivery.appliedAt} />
                      ) : (
                        translate('configuration.devices.unknown')
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </details>
  );
}
function VersionPayloadForm({
  busy,
  initialPayload,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly initialPayload: ConfigurationPayloadView;
  readonly onSubmit: (payload: ConfigurationPayloadView, changeNote: string, reason: string) => void;
}) {
  const defaults = initialPayload;
  const [raw, setRaw] = useState<Record<ConfigFieldKey, string>>({
    heartbeatInterval: String(defaults.heartbeatInterval),
    telemetryInterval: String(defaults.telemetryInterval),
    cameraRefreshInterval: String(defaults.cameraRefreshInterval),
    temperatureThreshold: String(defaults.temperatureThreshold),
  });
  const [changeNote, setChangeNote] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const result = validateConfigPayload(raw);
  return (
    <div className="version-form" data-testid="config-version-form">
      {/* 仅渲染 DEC-018 V1 四字段；候选扩展/派生/网络字段不存在于表单 */}
      {CONFIG_V1_FIELDS.map((field) => (
        <div className="dialog-field" key={field.key}>
          <label htmlFor={`cfg-${field.key}`}>
            {field.label}（{field.unitLabel}，<NumberText value={field.min} />~<NumberText value={field.max} />）
          </label>
          <Input
            id={`cfg-${field.key}`}
            data-testid={`cfg-field-${field.key}`}
            inputMode={field.integer ? 'numeric' : 'decimal'}
            value={raw[field.key]}
            onChange={(event) => setRaw({ ...raw, [field.key]: event.target.value })}
            onBlur={() => setTouched(true)}
          />
          {touched && result.errors[field.key] !== undefined ? (
            <p className="field-hint" data-testid={`cfg-error-${field.key}`}>
              {result.errors[field.key]}
            </p>
          ) : null}
        </div>
      ))}
      <div className="dialog-field">
        <label htmlFor="cfg-change-note">{translate('page.4d7ded5e6306')}</label>
        <TextArea
          id="cfg-change-note"
          data-testid="cfg-change-note"
          value={changeNote}
          onChange={(event) => setChangeNote(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="cfg-reason">{translate('page.db5e8a988ba0')}</label>
        <TextArea
          id="cfg-reason"
          data-testid="cfg-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <Button
          type="button"
          className="primary-button"
          data-testid="cfg-submit"
          disabled={busy || result.payload === null}
          onClick={() => {
            setTouched(true);
            if (result.payload !== null) onSubmit(result.payload, changeNote.trim(), reason.trim());
          }}
        >
          {translate('page.c2098a5e9c7c')}
        </Button>
      </div>
    </div>
  );
}
function CreateConfigurationForm({
  busy,
  deviceId,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly deviceId?: string;
  readonly onSubmit: (input: { name: string; targetModel?: string; targetDeviceId?: string; reason?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [targetKind, setTargetKind] = useState<'model' | 'device'>('model');
  const [targetValue, setTargetValue] = useState('');
  const [reason, setReason] = useState('');
  const nameTrimmed = name.trim();
  const targetTrimmed = deviceId ?? targetValue.trim();
  const reasonTrimmed = reason.trim();
  return (
    <div className="config-create-form" data-testid="config-create-form">
      <div className="dialog-field">
        <label htmlFor="config-name">{translate('page.a5f08c1d3371')}</label>
        <Input
          id="config-name"
          data-testid="config-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {deviceId !== undefined ? (
        <p data-testid="config-fixed-target">{deviceId}</p>
      ) : (
        <>
          <div className="dialog-field">
            <label htmlFor="config-target-kind">{translate('page.c87bdfd4ba4b')}</label>
            <select
              id="config-target-kind"
              data-testid="config-target-kind"
              value={targetKind}
              onChange={(event) => setTargetKind(event.target.value as 'model' | 'device')}
            >
              <option value="model">{translate('page.eb2404a248b7')}</option>
              <option value="device">{translate('page.b80602624134')}</option>
            </select>
          </div>
          <div className="dialog-field">
            <label htmlFor="config-target-value">
              {targetKind === 'model' ? translate('page.418dfc356a6d') : translate('page.39c47009f7aa')}
            </label>
            <Input
              id="config-target-value"
              data-testid="config-target-value"
              value={targetValue}
              onChange={(event) => setTargetValue(event.target.value)}
            />
          </div>
        </>
      )}
      <div className="dialog-field">
        <label htmlFor="config-reason">{translate('page.db5e8a988ba0')}</label>
        <TextArea
          id="config-reason"
          data-testid="config-create-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <Button
          type="button"
          className="primary-button"
          data-testid="config-create-submit"
          disabled={busy || nameTrimmed === '' || targetTrimmed === ''}
          onClick={() =>
            onSubmit({
              name: nameTrimmed,
              ...(deviceId === undefined && targetKind === 'model'
                ? { targetModel: targetTrimmed }
                : { targetDeviceId: targetTrimmed }),
              ...(reasonTrimmed !== '' ? { reason: reasonTrimmed } : {}),
            })
          }
        >
          {translate('page.0b002e0e99bf')}
        </Button>
      </div>
    </div>
  );
}
function PublishForm({
  busy,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onSubmit: (effectiveAt: string, reason: string) => void;
}) {
  const { timeZone } = useUserTimeZone();
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [effectiveAt, setEffectiveAt] = useState('');
  const [invalidInput, setInvalidInput] = useState(false);
  const [reason, setReason] = useState('');
  const utc = effectiveAt === '' ? '' : zonedDateTimeToUtcIso(effectiveAt, timeZone);
  const effectiveAtInvalid = invalidInput || utc === null;
  return (
    <div className="publish-form" data-testid="config-publish-form">
      <p>{translate('page.f18eb02bde07')}</p>
      <div className="dialog-field">
        <label htmlFor="publish-effective-at">{t('configuration.publish.effectiveAt')}</label>
        <Input
          id="publish-effective-at"
          data-testid="publish-effective-at"
          ref={input}
          type="datetime-local"
          step={1}
          aria-invalid={effectiveAtInvalid}
          aria-describedby={effectiveAtInvalid ? 'publish-time-help publish-time-error' : 'publish-time-help'}
          value={effectiveAt}
          onInput={({ currentTarget }) => {
            // Incomplete native input can also have an empty value.
            setInvalidInput(currentTarget.validity.badInput);
            setEffectiveAt(currentTarget.value);
          }}
        />
        <p id="publish-time-help" className="field-hint">
          {t('configuration.publish.timeZone', { timeZone })}
        </p>
        {effectiveAtInvalid ? (
          <p id="publish-time-error" className="field-error" role="alert">
            {t('configuration.publish.invalidTime')}
          </p>
        ) : null}
      </div>
      <div className="dialog-field">
        <label htmlFor="publish-reason">{translate('page.f734d80c7189')}</label>
        <TextArea
          id="publish-reason"
          data-testid="publish-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <Button
          type="button"
          className="primary-button"
          data-testid="config-publish"
          disabled={busy || effectiveAtInvalid}
          onClick={() => {
            if (utc !== null && input.current?.validity.badInput === false) onSubmit(utc, reason.trim());
          }}
        >
          {translate('page.221f71a458cf')}
        </Button>
      </div>
    </div>
  );
}
