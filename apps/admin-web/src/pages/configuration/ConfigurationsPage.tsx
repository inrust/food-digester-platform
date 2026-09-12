import { translate } from '../../i18n/i18n.js';
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
import { TimeText } from '../../components/TimeText.js';
import type {
  ConfigurationDetailView,
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
      readonly sync: SyncStatusState;
    };
export interface ConfigurationFilter {
  readonly targetModel: string | null;
  readonly targetDeviceId: string | null;
}
export const EMPTY_CONFIGURATION_FILTER: ConfigurationFilter = { targetModel: null, targetDeviceId: null };
export interface ConfigurationsPageProps {
  readonly role: Role;
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
  list,
  appliedFilter,
  onApplyFilter,
  onRefresh,
  detail,
  onSelect,
  onCloseDetail,
  onLoadSyncStatus,
  onCreate,
  onCreateVersion,
  onPublish,
}: ConfigurationsPageProps) {
  const [draftFilter, setDraftFilter] = useState<ConfigurationFilter>(appliedFilter);
  const [createOpen, setCreateOpen] = useState(false);
  const [versionFormOpen, setVersionFormOpen] = useState(false);
  const [publishTarget, setPublishTarget] = useState<number | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
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
      <div className="filter-bar" data-testid="config-filter-bar">
        <label htmlFor="config-filter-model">{translate('page.418dfc356a6d')}</label>
        <input
          id="config-filter-model"
          data-testid="config-filter-model"
          value={draftFilter.targetModel ?? ''}
          onChange={(event) => setDraftFilter({ ...draftFilter, targetModel: event.target.value })}
        />
        <label htmlFor="config-filter-device">{translate('page.1b73f8fcde1b')}</label>
        <input
          id="config-filter-device"
          data-testid="config-filter-device"
          value={draftFilter.targetDeviceId ?? ''}
          onChange={(event) => setDraftFilter({ ...draftFilter, targetDeviceId: event.target.value })}
        />
        <button
          type="button"
          className="primary-button"
          data-testid="config-search"
          onClick={() => onApplyFilter(draftFilter)}
        >
          {translate('page.f04090805c6e')}
        </button>
        <button
          type="button"
          data-testid="config-reset"
          onClick={() => {
            setDraftFilter(EMPTY_CONFIGURATION_FILTER);
            onApplyFilter(EMPTY_CONFIGURATION_FILTER);
          }}
        >
          {translate('page.3d81345303ab')}
        </button>
        {canWrite ? (
          <button
            type="button"
            className="primary-button"
            data-testid="config-create"
            onClick={() => setCreateOpen(true)}
          >
            {translate('page.31cc2c4c86f0')}
          </button>
        ) : null}
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

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
                <td>{row.versionCount}</td>
                <td>{row.latestPublishedVersion !== null ? `v${row.latestPublishedVersion}` : '—'}</td>
                <td>{row.createdBy}</td>
                <td>
                  <TimeText iso={row.createdAt} />
                </td>
                <td>
                  <button
                    type="button"
                    data-testid={`config-detail-open-${row.configurationId}`}
                    onClick={() => onSelect(row.configurationId)}
                  >
                    {translate('page.4f55ee1e687f')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="config-detail-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : null}
      {detail.kind === 'error' ? <ErrorNotice error={detail.error} onRefresh={onRefresh} /> : null}

      {detailView !== null && detail.kind === 'ready' ? (
        <aside className="config-detail" data-testid="config-detail" aria-label={translate('page.eefaf4d5e099')}>
          <h4>
            {translate('page.cd7f88e92bbd')}
            {detailView.name}
          </h4>
          <dl>
            <dt>{translate('page.941f08313a1d')}</dt>
            <dd>
              {detailView.targetModel !== null
                ? translate('page.0132ce7298ec') + ' ' + detailView.targetModel
                : translate('page.01f2c16cda65') + ' ' + (detailView.targetDeviceId ?? '')}
            </dd>
            <dt>{translate('page.c7bd3aea6020')}</dt>
            <dd data-testid="config-latest-published">
              {detailView.latestPublishedVersion !== null
                ? `v${detailView.latestPublishedVersion}`
                : translate('page.ff233aab26c8')}
            </dd>
          </dl>

          {detailView.derivedContext !== null ? (
            <section data-testid="config-derived-context" aria-label={translate('page.8de234dc2f9d')}>
              <h5>{translate('page.df32cbc077f5')}</h5>
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

          <section aria-label={translate('page.8770418ba3a0')}>
            <h5>{translate('page.af998514ac51')}</h5>
            {detailView.versions.length === 0 ? (
              <p className="empty-state" data-testid="config-versions-empty">
                {translate('page.123892c99043')}
              </p>
            ) : (
              detailView.versions.map((v) => (
                <VersionCard
                  key={v.versionId}
                  version={v}
                  canWrite={canWrite}
                  busy={busy}
                  sync={detail.sync}
                  onPublishIntent={() => setPublishTarget(v.version)}
                  onLoadSyncStatus={() => onLoadSyncStatus(v.version)}
                />
              ))
            )}
          </section>

          <div className="detail-actions">
            <button type="button" onClick={onCloseDetail}>
              {translate('page.6c14bd7f6f9e')}
            </button>
            {canWrite ? (
              <button
                type="button"
                className="primary-button"
                data-testid="config-version-create"
                disabled={busy}
                onClick={() => setVersionFormOpen(true)}
              >
                {translate('page.c87926d3eb9a')}
              </button>
            ) : null}
          </div>
        </aside>
      ) : null}

      <Modal
        open={createOpen}
        title={translate('page.31cc2c4c86f0')}
        testid="config-create-dialog"
        onClose={() => setCreateOpen(false)}
      >
        <CreateConfigurationForm
          busy={busy}
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
  onLoadSyncStatus,
}: {
  readonly version: ConfigurationVersionView;
  readonly canWrite: boolean;
  readonly busy: boolean;
  readonly sync: SyncStatusState;
  readonly onPublishIntent: () => void;
  readonly onLoadSyncStatus: () => void;
}) {
  const publishable = version.status === 'DRAFT';
  return (
    <div className="version-card" data-testid={`config-version-${version.version}`} data-status={version.status}>
      <div className="version-head">
        <strong>v{version.version}</strong>
        <span data-testid={`config-version-${version.version}-status`}>
          {CONFIG_VERSION_STATUS_LABELS[version.status] ?? version.status}
        </span>
        {version.effectiveAt !== null ? (
          <span>
            {translate('page.ba06f7a98566') + ' '}
            <TimeText iso={version.effectiveAt} />
          </span>
        ) : null}
        <span>
          {translate('page.f3b01f3f1a0e') + ' '}
          <TimeText iso={version.createdAt} />
        </span>
        {version.changeNote !== null ? (
          <span>
            {translate('page.a2c8f89312ec')}
            {version.changeNote}
          </span>
        ) : null}
      </div>
      {/* 历史版本只读：payload 仅展示，不提供编辑入口（不可变版本） */}
      <dl className="version-payload" data-testid={`config-version-${version.version}-payload`}>
        {CONFIG_V1_FIELDS.map((field) => (
          <div key={field.key}>
            <dt>
              {field.label}（{field.unitLabel}）
            </dt>
            <dd data-testid={`config-version-${version.version}-field-${field.key}`}>{version.payload[field.key]}</dd>
          </div>
        ))}
      </dl>
      <div className="action-row">
        <button
          type="button"
          className="primary-button"
          data-testid={`config-publish-${version.version}`}
          disabled={!publishable || !canWrite || busy}
          {...(!publishable ? { title: translate('page.956bedba1a79') } : {})}
          onClick={onPublishIntent}
        >
          {translate('page.94f172d02f5e')}
        </button>
        {version.status === 'PUBLISHED' ? (
          <button type="button" data-testid={`config-sync-${version.version}`} onClick={onLoadSyncStatus}>
            {translate('page.0150205d5c21')}
          </button>
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
        <ul data-testid={`config-sync-targets-${version.version}`}>
          {sync.data.targets.map((t) => (
            <li key={t.deviceId} data-testid={`config-sync-target-${t.deviceId}`}>
              {t.deviceId}：{CONFIG_SYNC_STATUS_LABELS[t.notificationStatus] ?? t.notificationStatus}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
function VersionPayloadForm({
  busy,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onSubmit: (payload: ConfigurationPayloadView, changeNote: string, reason: string) => void;
}) {
  const defaults = defaultConfigPayload();
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
            {field.label}（{field.unitLabel}，{field.min}~{field.max}）
          </label>
          <input
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
        <textarea
          id="cfg-change-note"
          data-testid="cfg-change-note"
          value={changeNote}
          onChange={(event) => setChangeNote(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="cfg-reason">{translate('page.db5e8a988ba0')}</label>
        <textarea
          id="cfg-reason"
          data-testid="cfg-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <button
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
        </button>
      </div>
    </div>
  );
}
function CreateConfigurationForm({
  busy,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onSubmit: (input: { name: string; targetModel?: string; targetDeviceId?: string; reason?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [targetKind, setTargetKind] = useState<'model' | 'device'>('model');
  const [targetValue, setTargetValue] = useState('');
  const [reason, setReason] = useState('');
  const nameTrimmed = name.trim();
  const targetTrimmed = targetValue.trim();
  const reasonTrimmed = reason.trim();
  return (
    <div className="config-create-form" data-testid="config-create-form">
      <div className="dialog-field">
        <label htmlFor="config-name">{translate('page.a5f08c1d3371')}</label>
        <input
          id="config-name"
          data-testid="config-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
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
        <input
          id="config-target-value"
          data-testid="config-target-value"
          value={targetValue}
          onChange={(event) => setTargetValue(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="config-reason">{translate('page.db5e8a988ba0')}</label>
        <textarea
          id="config-reason"
          data-testid="config-create-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="primary-button"
          data-testid="config-create-submit"
          disabled={busy || nameTrimmed === '' || targetTrimmed === ''}
          onClick={() =>
            onSubmit({
              name: nameTrimmed,
              ...(targetKind === 'model' ? { targetModel: targetTrimmed } : { targetDeviceId: targetTrimmed }),
              ...(reasonTrimmed !== '' ? { reason: reasonTrimmed } : {}),
            })
          }
        >
          {translate('page.0b002e0e99bf')}
        </button>
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
  const [effectiveAt, setEffectiveAt] = useState('');
  const [reason, setReason] = useState('');
  const effectiveAtTrimmed = effectiveAt.trim();
  const effectiveAtInvalid = effectiveAtTrimmed !== '' && Number.isNaN(Date.parse(effectiveAtTrimmed));
  return (
    <div className="publish-form" data-testid="config-publish-form">
      <p>{translate('page.f18eb02bde07')}</p>
      <div className="dialog-field">
        <label htmlFor="publish-effective-at">{translate('page.cdc8a1890529')}</label>
        <input
          id="publish-effective-at"
          data-testid="publish-effective-at"
          placeholder="2026-09-07T00:00:00Z"
          value={effectiveAt}
          onChange={(event) => setEffectiveAt(event.target.value)}
        />
        {effectiveAtInvalid ? <p className="field-hint">{translate('page.f05613710d62')}</p> : null}
      </div>
      <div className="dialog-field">
        <label htmlFor="publish-reason">{translate('page.f734d80c7189')}</label>
        <textarea
          id="publish-reason"
          data-testid="publish-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="primary-button"
          data-testid="config-publish"
          disabled={busy || effectiveAtInvalid}
          onClick={() => onSubmit(effectiveAtTrimmed, reason.trim())}
        >
          {translate('page.221f71a458cf')}
        </button>
      </div>
    </div>
  );
}
