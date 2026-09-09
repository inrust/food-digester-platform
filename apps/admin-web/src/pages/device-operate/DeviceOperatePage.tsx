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
import type { Role } from '@fdp/auth';
import { hasPermission } from '@fdp/auth';
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
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'ready'; readonly command: CommandDetailView };

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
  ) => Promise<{ commandId: string; status: string; replayed: boolean; requestedBy: string }>;
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
  readonly latestMedia: { readonly mediaId: string; readonly mediaType: string; readonly captureTime: string } | null;
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
  const [form, setForm] = useState<{ command: CommandName; group: readonly CommandName[] | null } | null>(null);
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
          ? `命令已受理（${result.commandId}，幂等重放无新写入），等待设备执行`
          : `命令已受理（${result.commandId}），提交人 ${result.requestedBy}（身份上下文取得）；等待设备执行（${COMMAND_STATUS_LABELS[result.status as CommandStatus] ?? result.status}）`,
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
      : { allowed: false, reason: gates[0]?.reason ?? '当前状态不允许' };
  };

  return (
    <div className="device-operate-page" data-testid="device-operate-page">
      <section data-testid="device-picker" aria-label="选择设备">
        <h4>选择设备</h4>
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
        <section data-testid="device-status-panel" aria-label="当前运行状态">
          <h4>当前运行状态：{selectedDevice.alias ?? selectedDevice.serialNumber}</h4>
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

      <section data-testid="quick-actions" aria-label="快捷操作">
        <h4>快捷操作</h4>
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
        <p className="field-hint">策略（M/N）与温度阈值经 Configuration 版本发布生效，不产生设备命令。</p>
      </section>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <Modal open={form !== null} title="下发命令" testid="command-form" onClose={() => setForm(null)}>
        {form !== null ? (
          <div>
            <div className="dialog-field">
              <label htmlFor="command-select">命令（CT-04 白名单）</label>
              <select
                id="command-select"
                data-testid="command-select"
                value={form.command}
                onChange={(event) => {
                  setForm({ ...form, command: event.target.value as CommandName });
                  setConfirmText('');
                }}
              >
                {(form.group ?? COMMAND_CATALOG.map((c) => c.command)).map((command) => (
                  <option key={command} value={command}>
                    {COMMAND_LABELS[command]}（{command}）
                  </option>
                ))}
              </select>
            </div>
            <div className="dialog-field">
              <label htmlFor="command-timeout">超时时间 timeoutSec（1~3600 秒）</label>
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
              <label htmlFor="command-remarks">备注 remarks（可选，≤500 字）</label>
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
                  高风险命令：请输入完整命令名 {form.command}；若登录已超过策略时限，服务端将要求重新认证
                </p>
                <label htmlFor="command-confirm-text">确认凭证（confirmText）</label>
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
                提交命令
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <section data-testid="command-list-section" aria-label="命令状态列表">
        <h4>命令状态</h4>
        <div className="filter-bar">
          <label htmlFor="cmd-filter-status">状态</label>
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
            <option value="">全部</option>
            {COMMAND_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {COMMAND_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <label htmlFor="cmd-filter-command">命令</label>
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
            <option value="">全部</option>
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
            筛选
          </button>
        </div>
        <CursorTable
          ariaLabel="命令列表"
          columns={[
            {
              key: 'command',
              header: '命令',
              render: (c) => (
                <>
                  {COMMAND_LABELS[c.command]}（{c.command}）
                  {c.highRisk ? <span className="severity-badge severity-major">高风险</span> : null}
                </>
              ),
            },
            { key: 'status', header: '状态', render: (c) => COMMAND_STATUS_LABELS[c.status] },
            { key: 'requestedBy', header: '提交人', render: (c) => c.requestedBy },
            { key: 'requestTime', header: '请求时间', render: (c) => <TimeText iso={c.requestTime} /> },
            { key: 'timeoutSec', header: '超时', render: (c) => `${c.timeoutSec}s` },
            {
              key: 'actions',
              header: '操作',
              render: (c) => (
                <button
                  type="button"
                  data-testid={`command-detail-${c.commandId}`}
                  onClick={() => onSelectCommand(c.commandId)}
                >
                  详情
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
          emptyText="暂无命令记录"
        />
      </section>

      {commandDetail.kind === 'loading' ? (
        <div role="status" data-testid="command-detail-loading">
          加载中…
        </div>
      ) : null}
      {commandDetail.kind === 'error' ? <ErrorNotice error={commandDetail.error} onRefresh={onRefresh} /> : null}

      {detail !== null ? (
        <aside className="command-detail" data-testid="command-detail" aria-label="命令详情">
          <h4>
            命令详情：{COMMAND_LABELS[detail.command]}（{detail.command}）
            {detail.highRisk ? <span className="severity-badge severity-major">高风险</span> : null}
          </h4>
          <dl>
            <dt>状态</dt>
            <dd data-testid="command-detail-status">{COMMAND_STATUS_LABELS[detail.status]}</dd>
            <dt>提交人</dt>
            <dd data-testid="command-detail-requested-by">{detail.requestedBy}（身份上下文取得，不可编辑）</dd>
            <dt>请求时间</dt>
            <dd>
              <TimeText iso={detail.requestTime} />
            </dd>
            <dt>超时 / 过期</dt>
            <dd>
              {detail.timeoutSec}s / {detail.expiresAt !== null ? <TimeText iso={detail.expiresAt} /> : '—'}
            </dd>
            {detail.remarks !== null ? (
              <>
                <dt>备注</dt>
                <dd>{detail.remarks}</dd>
              </>
            ) : null}
            {detail.confirmedBy !== null ? (
              <>
                <dt>高风险确认人</dt>
                <dd>{detail.confirmedBy}</dd>
              </>
            ) : null}
          </dl>
          {isLateAck(detail.status, detail.acks) ? (
            <p className="late-ack" role="status" data-testid="late-ack">
              迟到 ACK：命令已{COMMAND_STATUS_LABELS[detail.status]}后仍收到设备回执（原样保留追溯链）
            </p>
          ) : null}
          <section aria-label="下发尝试">
            <h5>下发尝试</h5>
            {detail.attempts.length === 0 ? (
              <p className="empty-state">暂无</p>
            ) : (
              <ol data-testid="command-attempts">
                {detail.attempts.map((a) => (
                  <li key={a.attemptNo}>
                    第 {a.attemptNo} 次 <TimeText iso={a.publishedAt} /> →{' '}
                    {a.outcome === 'PUBLISHED' ? '发布成功' : '发布失败'}（完成于 <TimeText iso={a.finishedAt} />）
                    {a.errorCode !== null ? ` 错误码 ${a.errorCode}` : ''}
                    {a.providerMessageId !== null ? `（provider ${a.providerMessageId}）` : ''}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="设备 ACK">
            <h5>设备 ACK</h5>
            {detail.acks.length === 0 ? (
              <p className="empty-state" data-testid="command-acks-empty">
                暂无 ACK
              </p>
            ) : (
              <ol data-testid="command-acks">
                {detail.acks.map((ack, index) => (
                  <li key={index} data-testid={`command-ack-${index}`}>
                    <TimeText iso={ack.ackAt} />：{ACK_RESULT_LABELS[ack.result] ?? ack.result}
                    {ack.executeTimeMs !== null ? `（执行 ${ack.executeTimeMs}ms）` : ''}
                    {ack.errorCode !== null ? ` 错误码 ${ack.errorCode}` : ''}
                    {ack.message !== null ? ` — ${ack.message}` : ''}
                    {ack.sourceMessageId !== null ? `（msg ${ack.sourceMessageId}）` : ''}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <button type="button" onClick={onCloseCommandDetail}>
            关闭
          </button>
        </aside>
      ) : null}

      <section data-testid="media-panel" aria-label="最新授权媒体（非实时画面）">
        <h4>最新授权媒体（非实时画面）</h4>
        {latestMedia !== null ? (
          <div data-testid="media-latest">
            <span>{latestMedia.mediaId}</span>
            <span>{latestMedia.mediaType}</span>
            <span>
              采集于 <TimeText iso={latestMedia.captureTime} />
            </span>
          </div>
        ) : (
          <p className="empty-state" data-testid="media-empty">
            暂无授权媒体
          </p>
        )}
        <button type="button" data-testid="media-refresh" onClick={onRefreshMedia}>
          手动刷新
        </button>
      </section>

      <section data-testid="activity-table" aria-label="操作日志">
        <h4>操作日志</h4>
        <div className="filter-bar">
          <label htmlFor="activity-level">级别</label>
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
            <option value="">全部</option>
            {ACTIVITY_LEVEL_OPTIONS.map((l) => (
              <option key={l} value={l}>
                {ACTIVITY_LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
          <label htmlFor="activity-kind">类型</label>
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
            <option value="">全部</option>
            <option value="EVENT">事件</option>
            <option value="ALARM">告警</option>
          </select>
          <button
            type="button"
            className="primary-button"
            data-testid="activity-filter-search"
            onClick={() => onApplyActivityFilter(draftActivityFilter)}
          >
            筛选
          </button>
        </div>
        <CursorTable
          ariaLabel="操作日志"
          columns={[
            { key: 'occurredAt', header: '时间', render: (a) => <TimeText iso={a.occurredAt} /> },
            { key: 'level', header: '级别', render: (a) => ACTIVITY_LEVEL_LABELS[a.level] },
            { key: 'kind', header: '类型', render: (a) => ACTIVITY_KIND_LABELS[a.kind] },
            { key: 'summary', header: '内容', render: (a) => a.summary },
            { key: 'detail', header: '详情', render: (a) => <code>{JSON.stringify(a.detail)}</code> },
          ]}
          rows={activities.rows === null ? null : [...activities.rows]}
          rowKey={(a) => a.activityId}
          {...(activities.loading !== undefined ? { loading: activities.loading } : {})}
          {...(activities.error !== undefined ? { error: activities.error } : {})}
          {...(activities.nextCursor !== undefined ? { nextCursor: activities.nextCursor } : {})}
          onNextPage={onLoadMoreActivities}
          onRefresh={onRefresh}
          emptyText="暂无日志"
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
