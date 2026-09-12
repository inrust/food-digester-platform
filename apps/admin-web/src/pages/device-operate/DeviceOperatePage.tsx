import { translate } from '../../i18n/i18n.js';
/**
 * FE-12 操作设备页（/devices/operate）：联动选设备、当前运行状态、CT-04 命令白名单表单、
 * 高风险确认、命令状态/ACK 与历史日志、最新 Media 面板（DEC-009 无实时播放）。
 *
 * - 原型 8 快捷动作映射 CT-04 正式命令（文案附带 command code，可追溯）；
 *   M/N 与温度阈值走 Configuration 版本发布（跳转 /configurations），不误走命令 API；
 * - 只提交目录内 command code（commandGroup 按钮必须在表单内选定具体命令）；
 * - DEC-023 高风险命令：confirmText 必须与命令名完全一致；服务端验证 JWT auth_time；
 * - requestedBy 不可编辑（身份上下文取得，表单无此字段）；
 * - Suspended/Retired/离线/无 REMOTE_CONTROL Entitlement → 禁用并展示原因（后端兜底）；
 * - 提交成功仅表示“已受理（AUTHORIZED），等待设备执行”，不声称执行成功；
 * - 详情展示 attempts/acks 时间线；TIMED_OUT 后收到的 ACK 标注“迟到 ACK”。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { hasPermission } from '@fdp/auth/browser';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { ExportPanel } from '../../components/ExportPanel.js';
import { Modal } from '../../components/Modal.js';
import { ScopeFilter } from '../../components/ScopeFilter.js';
import type { ScopeFilterProps } from '../../components/ScopeFilter.js';
import type { ScopeFilterValue } from '../../components/filter-state.js';
import { TimeText } from '../../components/TimeText.js';
import { FourAxisBadges } from '../../components/FourAxisBadge.js';
import type { DeviceView } from '../devices/types.js';
import type { CommandCreateInput, CommandListFilter, ActivityListFilter } from './commands-api.js';
import {
  ACK_RESULT_LABELS,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_LEVEL_LABELS,
  ACTIVITY_LEVEL_OPTIONS,
  COMMAND_CATALOG,
  COMMAND_LABELS,
  COMMAND_STATUS_LABELS,
  COMMAND_STATUS_OPTIONS,
  CONFIG_REDIRECTS,
  QUICK_ACTIONS,
  SUBMITTABLE_COMMAND_CATALOG,
  commandSpecOf,
  gateCommand,
  isLateAck,
  validateTimeoutSec,
} from './command-state.js';
import type {
  ActivityExportView,
  ActivityItemView,
  ActivityKind,
  ActivityLevel,
  CommandDetailView,
  CommandListItemView,
  CommandName,
  CommandStatus,
} from './types.js';
export interface ListState<T> {
  readonly rows: readonly T[] | null;
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly nextCursor?: string | null;
}
export type CommandDetailState =
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
      readonly command: CommandDetailView;
    };
export interface DeviceOperatePageProps {
  readonly role: Role;
  readonly scopeOptions: {
    readonly regions: ScopeFilterProps['regions'];
    readonly subregions: ScopeFilterProps['subregions'];
    readonly sites: ScopeFilterProps['sites'];
    readonly devices: NonNullable<ScopeFilterProps['devices']>;
  };
  readonly selectedDeviceId: string | null;
  readonly onSelectDevice: (deviceId: string | null) => void;
  /** 当前选中设备（四轴状态 + Entitlement，用于门控与运行状态展示）。 */
  readonly selectedDevice: DeviceView | null;
  readonly onSubmitCommand: (
    deviceId: string,
    input: CommandCreateInput,
  ) => Promise<{
    commandId: string;
    status: string;
    replayed: boolean;
    requestedBy: string;
  }>;
  readonly commands: ListState<CommandListItemView>;
  readonly commandFilter: CommandListFilter;
  readonly onApplyCommandFilter: (filter: CommandListFilter) => void;
  readonly onLoadMoreCommands: (cursor: string) => void;
  readonly commandDetail: CommandDetailState;
  readonly onSelectCommand: (commandId: string) => void;
  readonly onCloseCommandDetail: () => void;
  readonly activities: ListState<ActivityItemView>;
  readonly activityFilter: ActivityListFilter;
  readonly onApplyActivityFilter: (filter: ActivityListFilter) => void;
  readonly onLoadMoreActivities: (cursor: string) => void;
  readonly activityExport: ActivityExportView | null;
  readonly onExportActivities: (filter: ActivityListFilter) => Promise<unknown>;
  readonly onCheckActivityExport: (exportId: string) => void;
  /** 最新授权 Media（DEC-009：非实时画面；无数据稳定 null）。 */
  readonly latestMedia: {
    readonly mediaId: string;
    readonly mediaType: string;
    readonly captureTime: string;
  } | null;
  readonly onRefreshMedia: () => void;
  readonly onNavigate: (path: string) => void;
  readonly onRefresh: () => void;
}
export function DeviceOperatePage({
  role,
  scopeOptions,
  selectedDeviceId,
  onSelectDevice,
  selectedDevice,
  onSubmitCommand,
  commands,
  commandFilter,
  onApplyCommandFilter,
  onLoadMoreCommands,
  commandDetail,
  onSelectCommand,
  onCloseCommandDetail,
  activities,
  activityFilter,
  onApplyActivityFilter,
  onLoadMoreActivities,
  activityExport,
  onExportActivities,
  onCheckActivityExport,
  latestMedia,
  onRefreshMedia,
  onNavigate,
  onRefresh,
}: DeviceOperatePageProps) {
  const [form, setForm] = useState<{
    command: CommandName;
    group: readonly CommandName[] | null;
  } | null>(null);
  const [timeoutSec, setTimeoutSec] = useState('300');
  const [remarks, setRemarks] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftCommandFilter, setDraftCommandFilter] = useState<CommandListFilter>(commandFilter);
  const [draftActivityFilter, setDraftActivityFilter] = useState<ActivityListFilter>(activityFilter);
  const [draftScope, setDraftScope] = useState<ScopeFilterValue>({
    region: null,
    subregion: null,
    siteId: null,
    deviceId: selectedDeviceId,
  });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const detail = commandDetail.kind === 'ready' ? commandDetail.command : null;
  const openForm = (command: CommandName, group: readonly CommandName[] | null = null) => {
    setForm({ command, group });
    setConfirmText('');
    setActionError(null);
    setNotice(null);
  };
  const submitCommand = async () => {
    if (form === null || selectedDeviceId === null || inFlight.current) return;
    const timeoutError = validateTimeoutSec(timeoutSec);
    if (timeoutError !== null) {
      setActionError(new Error(timeoutError));
      return;
    }
    const spec = commandSpecOf(form.command);
    // DEC-023：显式文本确认；近期重新认证由服务端从已验签 JWT auth_time 校验。
    if (spec.highRisk && confirmText !== form.command) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      const result = await onSubmitCommand(selectedDeviceId, {
        command: form.command,
        timeoutSec: Number(timeoutSec),
        ...(remarks.trim() !== '' ? { remarks: remarks.trim() } : {}),
        ...(spec.highRisk ? { confirmation: { confirmText } } : {}),
      });
      setForm(null);
      setNotice(
        result.replayed
          ? translate('page.97a167d1d8ec') + result.commandId + translate('page.e9ea1b6963bf')
          : translate('page.97a167d1d8ec') +
              result.commandId +
              (translate('page.5a4c4c454f07') + ' ') +
              result.requestedBy +
              translate('page.cd3f9415a4e3') +
              (COMMAND_STATUS_LABELS[result.status as CommandStatus] ?? result.status) +
              '\uFF09',
      );
      onRefresh();
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const gateFor = (command: CommandName) => gateCommand(command, selectedDevice, role);
  const groupGate = (group: readonly CommandName[]) => {
    const gates = group.map((c) => gateFor(c));
    return gates.some((g) => g.allowed)
      ? { allowed: true, reason: null }
      : { allowed: false, reason: gates[0]?.reason ?? translate('page.142ee8e83959') };
  };
  return (
    <div className="device-operate-page" data-testid="device-operate-page">
      <section data-testid="device-picker" aria-label={translate('page.d1f8bd836068')}>
        <h4>{translate('page.d1f8bd836068')}</h4>
        <ScopeFilter
          regions={scopeOptions.regions}
          subregions={scopeOptions.subregions}
          sites={scopeOptions.sites}
          devices={scopeOptions.devices}
          value={draftScope}
          onChange={(next) => {
            setDraftScope(next);
            if (next.deviceId !== selectedDeviceId) onSelectDevice(next.deviceId ?? null);
          }}
        />
      </section>

      {selectedDevice !== null ? (
        <section data-testid="device-status-panel" aria-label={translate('page.e8ba1e529354')}>
          <h4>
            {translate('page.56bbe5daae4d')}
            {selectedDevice.alias ?? selectedDevice.serialNumber}
          </h4>
          <FourAxisBadges
            status={{
              connectivity: selectedDevice.connectivity,
              lifecycle: selectedDevice.lifecycleStatus,
              operational: selectedDevice.operationalStatus,
              license: selectedDevice.license?.status ?? null,
            }}
          />
        </section>
      ) : null}

      <section data-testid="quick-actions" aria-label={translate('page.309c0a9e6282')}>
        <h4>{translate('page.309c0a9e6282')}</h4>
        <div className="action-row">
          {QUICK_ACTIONS.map((action) => {
            const gate = action.command !== undefined ? gateFor(action.command) : groupGate(action.commandGroup ?? []);
            return (
              <span key={action.key} className="action-item">
                <button
                  type="button"
                  data-testid={`quick-${action.key}`}
                  disabled={!gate.allowed || busy}
                  onClick={() => {
                    if (action.command !== undefined) openForm(action.command);
                    else openForm((action.commandGroup ?? [])[0] as CommandName, action.commandGroup ?? null);
                  }}
                >
                  {action.label}
                  {action.command !== undefined ? `（${action.command}）` : ''}
                </button>
                {!gate.allowed && gate.reason !== null ? (
                  <span className="deny-reason" data-testid={`quick-deny-${action.key}`}>
                    {gate.reason}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
        <div className="action-row">
          {CONFIG_REDIRECTS.map((redirect) => (
            <span key={redirect.key} className="action-item">
              <button
                type="button"
                data-testid={`goto-config-${redirect.key === 'updateStrategy' ? 'strategy' : 'threshold'}`}
                title={redirect.hint}
                onClick={() => onNavigate('/configurations')}
              >
                {redirect.label}
              </button>
            </span>
          ))}
        </div>
        <p className="field-hint">{translate('page.3df4035f6d6e')}</p>
      </section>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <Modal
        open={form !== null}
        title={translate('page.b69305f77d98')}
        testid="command-form"
        onClose={() => setForm(null)}
      >
        {form !== null ? (
          <div>
            <div className="dialog-field">
              <label htmlFor="command-select">{translate('page.a9870f07ca2d')}</label>
              <select
                id="command-select"
                data-testid="command-select"
                value={form.command}
                onChange={(event) => {
                  setForm({ ...form, command: event.target.value as CommandName });
                  setConfirmText('');
                }}
              >
                {(form.group ?? SUBMITTABLE_COMMAND_CATALOG.map((c) => c.command)).map((command) => (
                  <option key={command} value={command}>
                    {COMMAND_LABELS[command]}（{command}）
                  </option>
                ))}
              </select>
            </div>
            <div className="dialog-field">
              <label htmlFor="command-timeout">{translate('page.fedaa161097d')}</label>
              <input
                id="command-timeout"
                data-testid="command-timeout"
                inputMode="numeric"
                value={timeoutSec}
                onChange={(event) => setTimeoutSec(event.target.value)}
              />
              {validateTimeoutSec(timeoutSec) !== null ? (
                <p className="field-hint" data-testid="command-timeout-error">
                  {validateTimeoutSec(timeoutSec)}
                </p>
              ) : null}
            </div>
            <div className="dialog-field">
              <label htmlFor="command-remarks">{translate('page.4980379d0c45')}</label>
              <textarea
                id="command-remarks"
                data-testid="command-remarks"
                maxLength={500}
                value={remarks}
                onChange={(event) => setRemarks(event.target.value)}
              />
            </div>
            {commandSpecOf(form.command).highRisk ? (
              <div className="dialog-field danger-zone" data-testid="command-confirmation">
                <p className="field-hint">
                  {translate('page.f9aa6c1eb894') + ' '}
                  {form.command}
                  {translate('page.7ec95f3ebb99')}
                </p>
                <label htmlFor="command-confirm-text">{translate('page.a6cbec3dede2')}</label>
                <input
                  id="command-confirm-text"
                  data-testid="command-confirm-text"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                />
              </div>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                data-testid="command-submit"
                disabled={
                  busy ||
                  validateTimeoutSec(timeoutSec) !== null ||
                  (commandSpecOf(form.command).highRisk && confirmText !== form.command)
                }
                onClick={() => void submitCommand()}
              >
                {translate('page.e9c7ee13638d')}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <section data-testid="command-list-section" aria-label={translate('page.d8ae01cf4ed7')}>
        <h4>{translate('page.844c944e76d8')}</h4>
        <div className="filter-bar">
          <label htmlFor="cmd-filter-status">{translate('page.62e951a692ff')}</label>
          <select
            id="cmd-filter-status"
            data-testid="cmd-filter-status"
            value={draftCommandFilter.status ?? ''}
            onChange={(event) =>
              setDraftCommandFilter({
                ...draftCommandFilter,
                status: event.target.value === '' ? null : (event.target.value as CommandStatus),
              })
            }
          >
            <option value="">{translate('page.778fc8f99453')}</option>
            {COMMAND_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {COMMAND_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <label htmlFor="cmd-filter-command">{translate('page.b114b91547d7')}</label>
          <select
            id="cmd-filter-command"
            data-testid="cmd-filter-command"
            value={draftCommandFilter.command ?? ''}
            onChange={(event) =>
              setDraftCommandFilter({
                ...draftCommandFilter,
                command: event.target.value === '' ? null : (event.target.value as CommandName),
              })
            }
          >
            <option value="">{translate('page.778fc8f99453')}</option>
            {COMMAND_CATALOG.map((c) => (
              <option key={c.command} value={c.command}>
                {COMMAND_LABELS[c.command]}（{c.command}）
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary-button"
            data-testid="cmd-filter-search"
            onClick={() => onApplyCommandFilter({ ...draftCommandFilter, deviceId: selectedDeviceId })}
          >
            {translate('page.dcce9a144a40')}
          </button>
        </div>
        <CursorTable
          ariaLabel={translate('page.88072264b0c8')}
          columns={[
            {
              key: 'command',
              header: translate('page.b114b91547d7'),
              render: (c) => (
                <>
                  {COMMAND_LABELS[c.command]}（{c.command}）
                  {c.highRisk ? (
                    <span className="severity-badge severity-major">{translate('page.7a83b6c0e346')}</span>
                  ) : null}
                </>
              ),
            },
            { key: 'status', header: translate('page.62e951a692ff'), render: (c) => COMMAND_STATUS_LABELS[c.status] },
            { key: 'requestedBy', header: translate('page.3c75f3646a07'), render: (c) => c.requestedBy },
            {
              key: 'requestTime',
              header: translate('page.e8b5eda03ab9'),
              render: (c) => <TimeText iso={c.requestTime} />,
            },
            { key: 'timeoutSec', header: translate('page.ff06c243d727'), render: (c) => `${c.timeoutSec}s` },
            {
              key: 'actions',
              header: translate('page.f3ea6d345e2a'),
              render: (c) => (
                <button
                  type="button"
                  data-testid={`command-detail-${c.commandId}`}
                  onClick={() => onSelectCommand(c.commandId)}
                >
                  {translate('page.4f55ee1e687f')}
                </button>
              ),
            },
          ]}
          rows={commands.rows === null ? null : [...commands.rows]}
          rowKey={(c) => c.commandId}
          {...(commands.loading !== undefined ? { loading: commands.loading } : {})}
          {...(commands.error !== undefined ? { error: commands.error } : {})}
          {...(commands.nextCursor !== undefined ? { nextCursor: commands.nextCursor } : {})}
          onNextPage={onLoadMoreCommands}
          onRefresh={onRefresh}
          emptyText={translate('page.b733de451b01')}
        />
      </section>

      {commandDetail.kind === 'loading' ? (
        <div role="status" data-testid="command-detail-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : null}
      {commandDetail.kind === 'error' ? <ErrorNotice error={commandDetail.error} onRefresh={onRefresh} /> : null}

      {detail !== null ? (
        <aside className="command-detail" data-testid="command-detail" aria-label={translate('page.70b9a43d45fa')}>
          <h4>
            {translate('page.d6ba667084d6')}
            {COMMAND_LABELS[detail.command]}（{detail.command}）
            {detail.highRisk ? (
              <span className="severity-badge severity-major">{translate('page.7a83b6c0e346')}</span>
            ) : null}
          </h4>
          <dl>
            <dt>{translate('page.62e951a692ff')}</dt>
            <dd data-testid="command-detail-status">{COMMAND_STATUS_LABELS[detail.status]}</dd>
            <dt>{translate('page.3c75f3646a07')}</dt>
            <dd data-testid="command-detail-requested-by">
              {detail.requestedBy}
              {translate('page.7a9fc0c822d1')}
            </dd>
            <dt>{translate('page.e8b5eda03ab9')}</dt>
            <dd>
              <TimeText iso={detail.requestTime} />
            </dd>
            <dt>{translate('page.3c14b777f83f')}</dt>
            <dd>
              {detail.timeoutSec}s / {detail.expiresAt !== null ? <TimeText iso={detail.expiresAt} /> : '—'}
            </dd>
            {detail.remarks !== null ? (
              <>
                <dt>{translate('page.e0361480e3a5')}</dt>
                <dd>{detail.remarks}</dd>
              </>
            ) : null}
            {detail.confirmedBy !== null ? (
              <>
                <dt>{translate('page.1c8290a333f7')}</dt>
                <dd>{detail.confirmedBy}</dd>
              </>
            ) : null}
          </dl>
          {isLateAck(detail.status, detail.acks) ? (
            <p className="late-ack" role="status" data-testid="late-ack">
              {translate('page.0afc04f45263')}
              {COMMAND_STATUS_LABELS[detail.status]}
              {translate('page.eb30e6736095')}
            </p>
          ) : null}
          <section aria-label={translate('page.146c96e8d725')}>
            <h5>{translate('page.146c96e8d725')}</h5>
            {detail.attempts.length === 0 ? (
              <p className="empty-state">{translate('page.5dbd015496af')}</p>
            ) : (
              <ol data-testid="command-attempts">
                {detail.attempts.map((a) => (
                  <li key={a.attemptNo}>
                    {translate('page.dae828fe4fb7') + ' '}
                    {a.attemptNo}
                    {' ' + translate('page.5e5b8169eee6') + ' '}
                    <TimeText iso={a.publishedAt} /> →{' '}
                    {a.outcome === 'PUBLISHED' ? translate('page.ec0023361886') : translate('page.7e7f5d44c467')}
                    {translate('page.8932ec0133f5') + ' '}
                    <TimeText iso={a.finishedAt} />）
                    {a.errorCode !== null ? ' ' + translate('page.e08c1d4f9ad5') + ' ' + a.errorCode : ''}
                    {a.providerMessageId !== null ? `（provider ${a.providerMessageId}）` : ''}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label={translate('page.7435adf4679c')}>
            <h5>{translate('page.7435adf4679c')}</h5>
            {detail.acks.length === 0 ? (
              <p className="empty-state" data-testid="command-acks-empty">
                {translate('page.d06b221ff39f')}
              </p>
            ) : (
              <ol data-testid="command-acks">
                {detail.acks.map((ack, index) => (
                  <li key={index} data-testid={`command-ack-${index}`}>
                    <TimeText iso={ack.ackAt} />：{ACK_RESULT_LABELS[ack.result] ?? ack.result}
                    {ack.executeTimeMs !== null
                      ? translate('page.2775b968e0d7') + ' ' + ack.executeTimeMs + 'ms\uFF09'
                      : ''}
                    {ack.errorCode !== null ? ' ' + translate('page.e08c1d4f9ad5') + ' ' + ack.errorCode : ''}
                    {ack.message !== null ? ` — ${ack.message}` : ''}
                    {ack.sourceMessageId !== null ? `（msg ${ack.sourceMessageId}）` : ''}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <button type="button" onClick={onCloseCommandDetail}>
            {translate('page.6c14bd7f6f9e')}
          </button>
        </aside>
      ) : null}

      <section data-testid="media-panel" aria-label={translate('page.da3f0b21a6c2')}>
        <h4>{translate('page.da3f0b21a6c2')}</h4>
        {latestMedia !== null ? (
          <div data-testid="media-latest">
            <span>{latestMedia.mediaId}</span>
            <span>{latestMedia.mediaType}</span>
            <span>
              {translate('page.ebd616a91fdc') + ' '}
              <TimeText iso={latestMedia.captureTime} />
            </span>
          </div>
        ) : (
          <p className="empty-state" data-testid="media-empty">
            {translate('page.c61f35aadcae')}
          </p>
        )}
        <button type="button" data-testid="media-refresh" onClick={onRefreshMedia}>
          {translate('page.7ea1129990c3')}
        </button>
      </section>

      <section data-testid="activity-table" aria-label={translate('page.f4bc877cd282')}>
        <h4>{translate('page.f4bc877cd282')}</h4>
        <div className="filter-bar">
          <label htmlFor="activity-level">{translate('page.2548499200e5')}</label>
          <select
            id="activity-level"
            data-testid="activity-filter-level"
            value={draftActivityFilter.level ?? ''}
            onChange={(event) =>
              setDraftActivityFilter({
                ...draftActivityFilter,
                level: event.target.value === '' ? null : (event.target.value as ActivityLevel),
              })
            }
          >
            <option value="">{translate('page.778fc8f99453')}</option>
            {ACTIVITY_LEVEL_OPTIONS.map((l) => (
              <option key={l} value={l}>
                {ACTIVITY_LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
          <label htmlFor="activity-kind">{translate('page.e4e46c7235d1')}</label>
          <select
            id="activity-kind"
            data-testid="activity-filter-kind"
            value={draftActivityFilter.kind ?? ''}
            onChange={(event) =>
              setDraftActivityFilter({
                ...draftActivityFilter,
                kind: event.target.value === '' ? null : (event.target.value as ActivityKind),
              })
            }
          >
            <option value="">{translate('page.778fc8f99453')}</option>
            <option value="EVENT">{translate('page.550e3280629d')}</option>
            <option value="ALARM">{translate('page.5078424f7e0e')}</option>
          </select>
          <button
            type="button"
            className="primary-button"
            data-testid="activity-filter-search"
            onClick={() => onApplyActivityFilter(draftActivityFilter)}
          >
            {translate('page.dcce9a144a40')}
          </button>
        </div>
        <CursorTable
          ariaLabel={translate('page.f4bc877cd282')}
          columns={[
            {
              key: 'occurredAt',
              header: translate('page.89b4aa6364ce'),
              render: (a) => <TimeText iso={a.occurredAt} />,
            },
            { key: 'level', header: translate('page.2548499200e5'), render: (a) => ACTIVITY_LEVEL_LABELS[a.level] },
            { key: 'kind', header: translate('page.e4e46c7235d1'), render: (a) => ACTIVITY_KIND_LABELS[a.kind] },
            { key: 'summary', header: translate('page.163aec9194a1'), render: (a) => a.summary },
            {
              key: 'detail',
              header: translate('page.4f55ee1e687f'),
              render: (a) => <code>{JSON.stringify(a.detail)}</code>,
            },
          ]}
          rows={activities.rows === null ? null : [...activities.rows]}
          rowKey={(a) => a.activityId}
          {...(activities.loading !== undefined ? { loading: activities.loading } : {})}
          {...(activities.error !== undefined ? { error: activities.error } : {})}
          {...(activities.nextCursor !== undefined ? { nextCursor: activities.nextCursor } : {})}
          onNextPage={onLoadMoreActivities}
          onRefresh={onRefresh}
          emptyText={translate('page.44060e77b11c')}
        />
        <div data-testid="activity-export">
          {selectedDeviceId !== null && canExportRole(role) ? (
            <ExportPanel
              testidPrefix="activity"
              canExport
              busy={busy}
              job={activityExport}
              onExport={() => {
                setBusy(true);
                void onExportActivities(activityFilter)
                  .catch((err) => setActionError(err))
                  .finally(() => setBusy(false));
              }}
              onCheckStatus={onCheckActivityExport}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
function canExportRole(role: Role): boolean {
  return hasPermission(role, 'export:create');
}
