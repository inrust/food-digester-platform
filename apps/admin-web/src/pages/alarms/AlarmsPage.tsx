/**
 * FE-10 告警/事件/防拆页（/alarms）：Alarm 筛选/详情/确认/清除 + Event/Tamper 只读视图。
 *
 * - 状态机：ACTIVE→确认/清除、ACKNOWLEDGED→清除、CLEARED 终态（矩阵 ∩ alarm:write）；
 *   确认/清除原因必填；重复操作幂等（replayed=true 提示“已幂等忽略”）；
 * - 筛选参数与 URL 同步（urlStateToSearch/urlStateFromSearch；replaceState）；
 * - CRITICAL 显著标记（severity-critical 行样式 + “严重”徽标）；本页只呈现业务告警，
 *   不含 CloudWatch/SQS/RDS 等 AWS 运维告警（功能边界）；
 * - Customer 角色租户隔离由服务端强制（跨 Customer 详情/处理 → 404 呈现）。
 */
import { useEffect, useRef, useState } from 'react';
import type { Role } from '@fdp/auth';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { TimeText } from '../../components/TimeText.js';
import type { FilterOption } from '../../components/ScopeFilter.js';
import type { AlarmHandleResultView, AlarmView, DeviceEventView, TamperEventView } from './types.js';
import {
  ALARM_SEVERITY_LABELS,
  ALARM_SEVERITY_OPTIONS,
  ALARM_STATUS_LABELS,
  ALARM_STATUS_OPTIONS,
  ALARM_TABS,
  ALARM_TAB_LABELS,
  gateAlarmAction,
  urlStateToSearch,
} from './alarm-state.js';
import type { AlarmPageUrlState, AlarmTab } from './alarm-state.js';

export interface ListState<T> {
  readonly rows: readonly T[] | null;
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly nextCursor?: string | null;
}

export type AlarmDetailState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'ready'; readonly alarm: AlarmView };

export interface AlarmsPageProps {
  readonly role: Role;
  /** Customer 角色：隐藏客户筛选（服务端强制本 Customer scope）。 */
  readonly isCustomerRole: boolean;
  readonly customerOptions: readonly FilterOption[];
  /** 已应用的 URL 状态（父级由 location.search 初始化/响应）。 */
  readonly urlState: AlarmPageUrlState;
  readonly onApplyUrlState: (state: AlarmPageUrlState) => void;
  readonly alarms: ListState<AlarmView>;
  readonly events: ListState<DeviceEventView>;
  readonly tampers: ListState<TamperEventView>;
  readonly onLoadMore: (tab: AlarmTab, cursor: string) => void;
  readonly onRefresh: () => void;
  readonly alarmDetail: AlarmDetailState;
  readonly onSelectAlarm: (alarmId: string) => void;
  readonly onCloseAlarmDetail: () => void;
  readonly onAcknowledge: (alarmId: string, reason: string) => Promise<AlarmHandleResultView>;
  readonly onClear: (alarmId: string, reason: string) => Promise<AlarmHandleResultView>;
}

export function AlarmsPage({
  role,
  isCustomerRole,
  customerOptions,
  urlState,
  onApplyUrlState,
  alarms,
  events,
  tampers,
  onLoadMore,
  onRefresh,
  alarmDetail,
  onSelectAlarm,
  onCloseAlarmDetail,
  onAcknowledge,
  onClear,
}: AlarmsPageProps) {
  const tab = urlState.tab;
  const [draftAlarm, setDraftAlarm] = useState(urlState.alarm);
  const [draftEvent, setDraftEvent] = useState(urlState.event);
  const [draftTamper, setDraftTamper] = useState(urlState.tamper);
  const [pendingHandle, setPendingHandle] = useState<'acknowledge' | 'clear' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  // 筛选参数与 URL 同步（replaceState，不产生历史记录堆积）
  useEffect(() => {
    const search = urlStateToSearch(urlState);
    const current = window.location.search;
    if (search !== current) {
      window.history.replaceState(null, '', `${window.location.pathname}${search}`);
    }
  }, [urlState]);

  const runAction = async (execute: () => Promise<AlarmHandleResultView>, verb: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPendingHandle(null);
    setActionError(null);
    setNotice(null);
    try {
      const result = await execute();
      setNotice(result.replayed ? `该告警已是目标状态，重复操作已幂等忽略（无重复写入/审计）` : `告警${verb}成功`);
      onRefresh();
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const applyFilter = () => {
    if (tab === 'alarm') onApplyUrlState({ ...urlState, alarm: draftAlarm });
    else if (tab === 'event') onApplyUrlState({ ...urlState, event: draftEvent });
    else onApplyUrlState({ ...urlState, tamper: draftTamper });
  };

  const alarm = alarmDetail.kind === 'ready' ? alarmDetail.alarm : null;

  return (
    <div className="alarms-page" data-testid="alarms-page">
      <div className="tab-bar" role="tablist" data-testid="alarm-tabs">
        {ALARM_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-testid={`tab-${t}`}
            className={tab === t ? 'tab active' : 'tab'}
            onClick={() => onApplyUrlState({ ...urlState, tab: t })}
          >
            {ALARM_TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="filter-bar" data-testid="alarm-filter-bar">
        {!isCustomerRole ? (
          <>
            <label htmlFor="alarm-filter-customer">所属客户</label>
            <select
              id="alarm-filter-customer"
              data-testid="filter-customer"
              value={(tab === 'alarm' ? draftAlarm : tab === 'event' ? draftEvent : draftTamper).customerId ?? ''}
              onChange={(event) => {
                const value = event.target.value === '' ? null : event.target.value;
                if (tab === 'alarm') setDraftAlarm({ ...draftAlarm, customerId: value });
                else if (tab === 'event') setDraftEvent({ ...draftEvent, customerId: value });
                else setDraftTamper({ ...draftTamper, customerId: value });
              }}
            >
              <option value="">全部</option>
              {customerOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <CommonFilterFields
          tab={tab}
          draftAlarm={draftAlarm}
          draftEvent={draftEvent}
          draftTamper={draftTamper}
          onChangeAlarm={setDraftAlarm}
          onChangeEvent={setDraftEvent}
          onChangeTamper={setDraftTamper}
        />
        <button type="button" className="primary-button" data-testid="filter-search" onClick={applyFilter}>
          筛选
        </button>
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      {tab === 'alarm' ? (
        <CursorTable
          ariaLabel="告警列表"
          columns={[
            {
              key: 'severity',
              header: '严重度',
              render: (a) => (
                <span
                  className={`severity-badge severity-${a.severity.toLowerCase()}`}
                  data-testid={`severity-${a.alarmId}`}
                >
                  {ALARM_SEVERITY_LABELS[a.severity]}
                </span>
              ),
            },
            { key: 'code', header: '代码', render: (a) => a.code },
            { key: 'deviceId', header: '设备', render: (a) => a.deviceId },
            { key: 'status', header: '状态', render: (a) => ALARM_STATUS_LABELS[a.status] },
            { key: 'message', header: '内容', render: (a) => a.message ?? '—' },
            { key: 'detectedTime', header: '发生时间', render: (a) => <TimeText iso={a.detectedTime} /> },
            {
              key: 'actions',
              header: '操作',
              render: (a) => (
                <button
                  type="button"
                  data-testid={`alarm-detail-${a.alarmId}`}
                  onClick={() => onSelectAlarm(a.alarmId)}
                >
                  详情
                </button>
              ),
            },
          ]}
          rows={alarms.rows === null ? null : [...alarms.rows]}
          rowKey={(a) => a.alarmId}
          rowClassName={(a) => (a.severity === 'CRITICAL' ? 'severity-critical' : undefined)}
          {...(alarms.loading !== undefined ? { loading: alarms.loading } : {})}
          {...(alarms.error !== undefined ? { error: alarms.error } : {})}
          {...(alarms.nextCursor !== undefined ? { nextCursor: alarms.nextCursor } : {})}
          onNextPage={(cursor) => onLoadMore('alarm', cursor)}
          onRefresh={onRefresh}
          emptyText="暂无告警"
        />
      ) : null}

      {tab === 'event' ? (
        <CursorTable
          ariaLabel="事件列表"
          columns={[
            { key: 'occurredAt', header: '发生时间', render: (e) => <TimeText iso={e.occurredAt} /> },
            { key: 'deviceId', header: '设备', render: (e) => e.deviceId },
            { key: 'eventType', header: '事件类型', render: (e) => e.eventType },
            { key: 'username', header: '操作员', render: (e) => e.username ?? '—' },
            { key: 'source', header: '来源', render: (e) => e.source ?? '—' },
            { key: 'remarks', header: '备注', render: (e) => e.remarks ?? '—' },
          ]}
          rows={events.rows === null ? null : [...events.rows]}
          rowKey={(e) => e.eventId}
          {...(events.loading !== undefined ? { loading: events.loading } : {})}
          {...(events.error !== undefined ? { error: events.error } : {})}
          {...(events.nextCursor !== undefined ? { nextCursor: events.nextCursor } : {})}
          onNextPage={(cursor) => onLoadMore('event', cursor)}
          onRefresh={onRefresh}
          emptyText="暂无事件"
        />
      ) : null}

      {tab === 'tamper' ? (
        <CursorTable
          ariaLabel="防拆事件列表"
          columns={[
            { key: 'occurredAt', header: '发生时间', render: (t) => <TimeText iso={t.occurredAt} /> },
            { key: 'deviceId', header: '设备', render: (t) => t.deviceId },
            { key: 'eventType', header: '事件类型', render: (t) => t.eventType },
            {
              key: 'severity',
              header: '严重度',
              render: (t) => (
                <span className={`severity-badge severity-${t.severity.toLowerCase()}`}>
                  {ALARM_SEVERITY_LABELS[t.severity]}
                </span>
              ),
            },
            { key: 'component', header: '部件', render: (t) => t.component ?? '—' },
            { key: 'details', header: '细节', render: (t) => <code>{JSON.stringify(t.details)}</code> },
            { key: 'actionTaken', header: '设备处置', render: (t) => t.actionTaken ?? '—' },
          ]}
          rows={tampers.rows === null ? null : [...tampers.rows]}
          rowKey={(t) => t.tamperEventId}
          {...(tampers.loading !== undefined ? { loading: tampers.loading } : {})}
          {...(tampers.error !== undefined ? { error: tampers.error } : {})}
          {...(tampers.nextCursor !== undefined ? { nextCursor: tampers.nextCursor } : {})}
          onNextPage={(cursor) => onLoadMore('tamper', cursor)}
          onRefresh={onRefresh}
          emptyText="暂无防拆事件"
        />
      ) : null}

      {alarmDetail.kind === 'loading' ? (
        <div role="status" data-testid="alarm-detail-loading">
          加载中…
        </div>
      ) : null}
      {alarmDetail.kind === 'error' ? <ErrorNotice error={alarmDetail.error} onRefresh={onRefresh} /> : null}

      {alarm !== null ? (
        <aside className="alarm-detail" data-testid="alarm-detail" aria-label="告警详情" data-severity={alarm.severity}>
          <h4>
            告警详情
            <span className={`severity-badge severity-${alarm.severity.toLowerCase()}`} data-testid="detail-severity">
              {ALARM_SEVERITY_LABELS[alarm.severity]}
            </span>
          </h4>
          <dl>
            <dt>告警 ID</dt>
            <dd>{alarm.alarmId}</dd>
            <dt>代码 / 类别</dt>
            <dd>
              {alarm.code} / {alarm.category}
            </dd>
            <dt>设备</dt>
            <dd>{alarm.deviceId}</dd>
            <dt>状态</dt>
            <dd data-testid="detail-status">{ALARM_STATUS_LABELS[alarm.status]}</dd>
            <dt>发生时间</dt>
            <dd>
              <TimeText iso={alarm.detectedTime} />
            </dd>
            <dt>部件</dt>
            <dd>{alarm.component ?? '—'}</dd>
            <dt>当前值 / 阈值</dt>
            <dd>
              {alarm.currentValue ?? '—'} / {alarm.threshold ?? '—'}
              {alarm.unit !== null ? ` ${alarm.unit}` : ''}
            </dd>
            <dt>内容</dt>
            <dd>{alarm.message ?? '—'}</dd>
            <dt>建议处置</dt>
            <dd>{alarm.recommendedAction ?? '—'}</dd>
            {alarm.acknowledgedBy !== null ? (
              <>
                <dt>确认</dt>
                <dd data-testid="detail-ack">
                  {alarm.acknowledgedBy}
                  {alarm.acknowledgedAt !== null ? (
                    <>
                      {' '}
                      <TimeText iso={alarm.acknowledgedAt} />
                    </>
                  ) : null}
                  {alarm.acknowledgeReason !== null ? ` — ${alarm.acknowledgeReason}` : ''}
                </dd>
              </>
            ) : null}
            {alarm.clearedAt !== null ? (
              <>
                <dt>清除</dt>
                <dd data-testid="detail-clear">
                  {alarm.clearedBy ?? '设备上报'} <TimeText iso={alarm.clearedAt} />
                  {alarm.clearReason !== null ? ` — ${alarm.clearReason}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
          <div className="detail-actions">
            <button type="button" onClick={onCloseAlarmDetail}>
              关闭
            </button>
            <button
              type="button"
              className="primary-button"
              data-testid="alarm-acknowledge"
              disabled={!gateAlarmAction('acknowledge', alarm.status, role).enabled || busy}
              {...(gateAlarmAction('acknowledge', alarm.status, role).reason !== null
                ? { title: gateAlarmAction('acknowledge', alarm.status, role).reason ?? '' }
                : {})}
              onClick={() => setPendingHandle('acknowledge')}
            >
              确认
            </button>
            <button
              type="button"
              className="danger-button"
              data-testid="alarm-clear"
              disabled={!gateAlarmAction('clear', alarm.status, role).enabled || busy}
              {...(gateAlarmAction('clear', alarm.status, role).reason !== null
                ? { title: gateAlarmAction('clear', alarm.status, role).reason ?? '' }
                : {})}
              onClick={() => setPendingHandle('clear')}
            >
              清除
            </button>
          </div>
        </aside>
      ) : null}

      <ConfirmDialog
        open={pendingHandle === 'acknowledge'}
        title="确认告警"
        requireReason
        reasonLabel="确认原因"
        {...(alarm !== null
          ? { description: `确认表示已知悉并跟进（ACTIVE→ACKNOWLEDGED），原因写入审计。告警：${alarm.code}` }
          : {})}
        confirmText="确认告警"
        onConfirm={(reason) => {
          if (alarm !== null) void runAction(() => onAcknowledge(alarm.alarmId, reason), '确认');
        }}
        onCancel={() => setPendingHandle(null)}
      />
      <ConfirmDialog
        open={pendingHandle === 'clear'}
        title="清除告警"
        danger
        requireReason
        reasonLabel="清除原因"
        {...(alarm !== null ? { description: `清除为终态（→CLEARED），原因写入审计。告警：${alarm.code}` } : {})}
        confirmText="确认清除"
        onConfirm={(reason) => {
          if (alarm !== null) void runAction(() => onClear(alarm.alarmId, reason), '清除');
        }}
        onCancel={() => setPendingHandle(null)}
      />
    </div>
  );
}

function CommonFilterFields({
  tab,
  draftAlarm,
  draftEvent,
  draftTamper,
  onChangeAlarm,
  onChangeEvent,
  onChangeTamper,
}: {
  readonly tab: AlarmTab;
  readonly draftAlarm: AlarmPageUrlState['alarm'];
  readonly draftEvent: AlarmPageUrlState['event'];
  readonly draftTamper: AlarmPageUrlState['tamper'];
  readonly onChangeAlarm: (f: AlarmPageUrlState['alarm']) => void;
  readonly onChangeEvent: (f: AlarmPageUrlState['event']) => void;
  readonly onChangeTamper: (f: AlarmPageUrlState['tamper']) => void;
}) {
  const draft = tab === 'alarm' ? draftAlarm : tab === 'event' ? draftEvent : draftTamper;
  const patch = (key: 'siteId' | 'deviceId' | 'from' | 'to', value: string) => {
    const v = value === '' ? null : value;
    if (tab === 'alarm') onChangeAlarm({ ...draftAlarm, [key]: v });
    else if (tab === 'event') onChangeEvent({ ...draftEvent, [key]: v });
    else onChangeTamper({ ...draftTamper, [key]: v });
  };
  const patchEnum = (key: 'severity' | 'status' | 'eventType', value: string) => {
    const v = value === '' ? null : value;
    if (key === 'severity' && tab === 'alarm') onChangeAlarm({ ...draftAlarm, severity: v as never });
    else if (key === 'severity' && tab === 'tamper') onChangeTamper({ ...draftTamper, severity: v as never });
    else if (key === 'status' && tab === 'alarm') onChangeAlarm({ ...draftAlarm, status: v as never });
    else if (key === 'eventType' && tab === 'event') onChangeEvent({ ...draftEvent, eventType: v });
    else if (key === 'eventType' && tab === 'tamper') onChangeTamper({ ...draftTamper, eventType: v });
  };

  return (
    <>
      <label htmlFor="filter-site">站点</label>
      <input
        id="filter-site"
        data-testid="filter-site"
        value={draft.siteId ?? ''}
        onChange={(e) => patch('siteId', e.target.value)}
      />
      <label htmlFor="filter-device">设备</label>
      <input
        id="filter-device"
        data-testid="filter-device"
        value={draft.deviceId ?? ''}
        onChange={(e) => patch('deviceId', e.target.value)}
      />
      {tab !== 'event' ? (
        <>
          <label htmlFor="filter-severity">严重度</label>
          <select
            id="filter-severity"
            data-testid="filter-severity"
            value={(draft as { severity: string | null }).severity ?? ''}
            onChange={(e) => patchEnum('severity', e.target.value)}
          >
            <option value="">全部</option>
            {ALARM_SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {ALARM_SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {tab === 'alarm' ? (
        <>
          <label htmlFor="filter-status">状态</label>
          <select
            id="filter-status"
            data-testid="filter-status"
            value={draftAlarm.status ?? ''}
            onChange={(e) => patchEnum('status', e.target.value)}
          >
            <option value="">全部</option>
            {ALARM_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {ALARM_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {tab !== 'alarm' ? (
        <>
          <label htmlFor="filter-event-type">事件类型</label>
          <input
            id="filter-event-type"
            data-testid="filter-event-type"
            value={(draft as { eventType: string | null }).eventType ?? ''}
            onChange={(e) => patchEnum('eventType', e.target.value)}
          />
        </>
      ) : null}
      <label htmlFor="filter-from">起始时间</label>
      <input
        id="filter-from"
        data-testid="filter-from"
        placeholder="2026-09-01T00:00:00Z"
        value={draft.from ?? ''}
        onChange={(e) => patch('from', e.target.value)}
      />
      <label htmlFor="filter-to">截止时间</label>
      <input
        id="filter-to"
        data-testid="filter-to"
        placeholder="2026-09-07T00:00:00Z"
        value={draft.to ?? ''}
        onChange={(e) => patch('to', e.target.value)}
      />
    </>
  );
}
