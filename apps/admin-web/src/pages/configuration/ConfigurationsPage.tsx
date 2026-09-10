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
  | { readonly kind: 'none' }
  | { readonly kind: 'loading'; readonly version: number }
  | { readonly kind: 'error'; readonly version: number; readonly error: unknown }
  | { readonly kind: 'ready'; readonly data: ConfigurationSyncStatusView };

export type ConfigurationDetailState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'ready'; readonly detail: ConfigurationDetailView; readonly sync: SyncStatusState };

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
    input: { payload: ConfigurationPayloadView; changeNote?: string; reason?: string },
  ) => Promise<ConfigurationVersionView>;
  readonly onPublish: (
    configurationId: string,
    version: number,
    input: { effectiveAt?: string; reason?: string },
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
        <label htmlFor="config-filter-model">目标型号</label>
        <input
          id="config-filter-model"
          data-testid="config-filter-model"
          value={draftFilter.targetModel ?? ''}
          onChange={(event) => setDraftFilter({ ...draftFilter, targetModel: event.target.value })}
        />
        <label htmlFor="config-filter-device">目标设备</label>
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
          搜索
        </button>
        <button
          type="button"
          data-testid="config-reset"
          onClick={() => {
            setDraftFilter(EMPTY_CONFIGURATION_FILTER);
            onApplyFilter(EMPTY_CONFIGURATION_FILTER);
          }}
        >
          重置
        </button>
        {canWrite ? (
          <button
            type="button"
            className="primary-button"
            data-testid="config-create"
            onClick={() => setCreateOpen(true)}
          >
            新建配置
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
          加载中…
        </div>
      ) : list.rows.length === 0 ? (
        <p className="empty-state" data-testid="config-empty">
          暂无配置
        </p>
      ) : (
        <table aria-label="配置列表" data-testid="config-table">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">目标</th>
              <th scope="col">版本数</th>
              <th scope="col">最新已发布</th>
              <th scope="col">创建人</th>
              <th scope="col">创建时间</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((row) => (
              <tr key={row.configurationId} data-testid={`config-row-${row.configurationId}`}>
                <td>{row.name}</td>
                <td>{row.targetModel !== null ? `型号 ${row.targetModel}` : `设备 ${row.targetDeviceId ?? ''}`}</td>
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
                    详情
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="config-detail-loading">
          加载中…
        </div>
      ) : null}
      {detail.kind === 'error' ? <ErrorNotice error={detail.error} onRefresh={onRefresh} /> : null}

      {detailView !== null && detail.kind === 'ready' ? (
        <aside className="config-detail" data-testid="config-detail" aria-label="配置详情">
          <h4>配置详情：{detailView.name}</h4>
          <dl>
            <dt>目标</dt>
            <dd>
              {detailView.targetModel !== null
                ? `型号 ${detailView.targetModel}`
                : `设备 ${detailView.targetDeviceId ?? ''}`}
            </dd>
            <dt>最新已发布版本</dt>
            <dd data-testid="config-latest-published">
              {detailView.latestPublishedVersion !== null ? `v${detailView.latestPublishedVersion}` : '尚未发布'}
            </dd>
          </dl>

          {detailView.derivedContext !== null ? (
            <section data-testid="config-derived-context" aria-label="设备上下文（只读）">
              <h5>设备上下文（只读，不随配置提交）</h5>
              <dl>
                <dt>设备别名</dt>
                <dd>{detailView.derivedContext.alias ?? '—'}</dd>
                <dt>站点</dt>
                <dd>{detailView.derivedContext.site ?? '—'}</dd>
                <dt>区域</dt>
                <dd>{detailView.derivedContext.region ?? '—'}</dd>
                <dt>子区域</dt>
                <dd>{detailView.derivedContext.subregion ?? '—'}</dd>
                <dt>合约</dt>
                <dd>
                  {detailView.derivedContext.contract !== null
                    ? `${detailView.derivedContext.contract.contractNumber} ${detailView.derivedContext.contract.name}`
                    : '—'}
                </dd>
              </dl>
            </section>
          ) : null}

          <section aria-label="版本历史">
            <h5>版本历史（不可变，发布后只读）</h5>
            {detailView.versions.length === 0 ? (
              <p className="empty-state" data-testid="config-versions-empty">
                暂无版本
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
              关闭
            </button>
            {canWrite ? (
              <button
                type="button"
                className="primary-button"
                data-testid="config-version-create"
                disabled={busy}
                onClick={() => setVersionFormOpen(true)}
              >
                新建版本
              </button>
            ) : null}
          </div>
        </aside>
      ) : null}

      <Modal open={createOpen} title="新建配置" testid="config-create-dialog" onClose={() => setCreateOpen(false)}>
        <CreateConfigurationForm
          busy={busy}
          onSubmit={(input) => void runAction(() => onCreate(input), '配置已创建')}
        />
      </Modal>

      {detailView !== null ? (
        <Modal
          open={versionFormOpen}
          title="新建配置版本（DRAFT）"
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
                '版本已创建（DRAFT）',
              )
            }
          />
        </Modal>
      ) : null}

      {detailView !== null && publishTarget !== null ? (
        <Modal
          open
          title={`发布版本 v${publishTarget}`}
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
                `版本 v${publishTarget} 已发布，目标设备将收到 CONFIG_CHANGED 通知`,
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
            生效于 <TimeText iso={version.effectiveAt} />
          </span>
        ) : null}
        <span>
          创建于 <TimeText iso={version.createdAt} />
        </span>
        {version.changeNote !== null ? <span>说明：{version.changeNote}</span> : null}
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
          {...(!publishable ? { title: '仅草稿版本可发布；历史版本不可覆盖' } : {})}
          onClick={onPublishIntent}
        >
          发布
        </button>
        {version.status === 'PUBLISHED' ? (
          <button type="button" data-testid={`config-sync-${version.version}`} onClick={onLoadSyncStatus}>
            同步状态
          </button>
        ) : null}
      </div>
      {sync.kind === 'loading' && sync.version === version.version ? (
        <div role="status" data-testid={`config-sync-loading-${version.version}`}>
          加载中…
        </div>
      ) : null}
      {sync.kind === 'error' && sync.version === version.version ? (
        <p className="error-notice" data-testid={`config-sync-error-${version.version}`}>
          同步状态加载失败
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
        <label htmlFor="cfg-change-note">变更说明（可选）</label>
        <textarea
          id="cfg-change-note"
          data-testid="cfg-change-note"
          value={changeNote}
          onChange={(event) => setChangeNote(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="cfg-reason">原因（可选，写入审计）</label>
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
          创建版本
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
        <label htmlFor="config-name">配置名称</label>
        <input
          id="config-name"
          data-testid="config-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="config-target-kind">发布目标类型（型号 / 设备 二选一）</label>
        <select
          id="config-target-kind"
          data-testid="config-target-kind"
          value={targetKind}
          onChange={(event) => setTargetKind(event.target.value as 'model' | 'device')}
        >
          <option value="model">按型号</option>
          <option value="device">按设备</option>
        </select>
      </div>
      <div className="dialog-field">
        <label htmlFor="config-target-value">{targetKind === 'model' ? '目标型号' : '目标设备 ID'}</label>
        <input
          id="config-target-value"
          data-testid="config-target-value"
          value={targetValue}
          onChange={(event) => setTargetValue(event.target.value)}
        />
      </div>
      <div className="dialog-field">
        <label htmlFor="config-reason">原因（可选，写入审计）</label>
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
          创建配置
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
      <p>发布为不可变已发布版本，目标设备将收到 CONFIG_CHANGED 通知；历史版本不可覆盖。</p>
      <div className="dialog-field">
        <label htmlFor="publish-effective-at">生效时间（可选，RFC 3339 UTC；缺省为发布时间）</label>
        <input
          id="publish-effective-at"
          data-testid="publish-effective-at"
          placeholder="2026-09-07T00:00:00Z"
          value={effectiveAt}
          onChange={(event) => setEffectiveAt(event.target.value)}
        />
        {effectiveAtInvalid ? <p className="field-hint">生效时间格式非法</p> : null}
      </div>
      <div className="dialog-field">
        <label htmlFor="publish-reason">发布原因（可选，写入审计）</label>
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
          确认发布
        </button>
      </div>
    </div>
  );
}
