import { Button, Input } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
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
import type { Role } from '@fdp/auth/browser';
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
      readonly alarm: AlarmView;
    };
export interface AlarmsPageProps {
  readonly role: Role;
  /** Customer 角色：隐藏客户筛选（服务端强制本 Customer scope）。 */
  readonly isCustomerRole: boolean;
  readonly customerOptions: readonly FilterOption[];
  readonly siteOptions?: readonly (FilterOption & {
    customerId: string;
  })[];
  readonly deviceOptions?: readonly (FilterOption & {
    customerId: string;
    siteId: string;
  })[];
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
  siteOptions = [],
  deviceOptions = [],
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
      setNotice(
        result.replayed
          ? translate('page.49a63f10ceb5')
          : translate('page.5078424f7e0e') + verb + translate('page.51991a5d111a'),
      );
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
      <header className="page-header">
        <h1>{translate('design.page.alarms')}</h1>
      </header>
      <div className="tab-bar" role="tablist" data-testid="alarm-tabs">
        {ALARM_TABS.map((t) => (
          <Button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-testid={`tab-${t}`}
            className={tab === t ? 'tab active' : 'tab'}
            onClick={() => onApplyUrlState({ ...urlState, tab: t })}
          >
            {ALARM_TAB_LABELS[t]}
          </Button>
        ))}
      </div>

      <div className="filter-bar" data-testid="alarm-filter-bar">
        {!isCustomerRole ? (
          <>
            <label htmlFor="alarm-filter-customer">{translate('page.467c1137f479')}</label>
            <select
              id="alarm-filter-customer"
              data-testid="filter-customer"
              value={(tab === 'alarm' ? draftAlarm : tab === 'event' ? draftEvent : draftTamper).customerId ?? ''}
              onChange={(event) => {
                const value = event.target.value === '' ? null : event.target.value;
                if (tab === 'alarm') setDraftAlarm({ ...draftAlarm, customerId: value, siteId: null, deviceId: null });
                else if (tab === 'event')
                  setDraftEvent({ ...draftEvent, customerId: value, siteId: null, deviceId: null });
                else setDraftTamper({ ...draftTamper, customerId: value, siteId: null, deviceId: null });
              }}
            >
              <option value="">{translate('page.778fc8f99453')}</option>
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
          siteOptions={siteOptions}
          deviceOptions={deviceOptions}
        />
        <Button type="button" className="primary-button" data-testid="filter-search" onClick={applyFilter}>
          {translate('page.dcce9a144a40')}
        </Button>
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      {tab === 'alarm' ? (
        <CursorTable
          ariaLabel={translate('page.9f383ec237a4')}
          columns={[
            {
              key: 'severity',
              header: translate('page.9272e8abe5ad'),
              render: (a) => (
                <span
                  className={`severity-badge severity-${a.severity.toLowerCase()}`}
                  data-testid={`severity-${a.alarmId}`}
                >
                  {ALARM_SEVERITY_LABELS[a.severity]}
                </span>
              ),
            },
            { key: 'code', header: translate('page.33246dda76cc'), render: (a) => a.code },
            { key: 'deviceId', header: translate('page.01f2c16cda65'), render: (a) => a.deviceId },
            { key: 'status', header: translate('page.62e951a692ff'), render: (a) => ALARM_STATUS_LABELS[a.status] },
            { key: 'message', header: translate('page.163aec9194a1'), render: (a) => a.message ?? '—' },
            {
              key: 'detectedTime',
              header: translate('page.51f85a78cac4'),
              render: (a) => <TimeText iso={a.detectedTime} />,
            },
            {
              key: 'actions',
              header: translate('page.f3ea6d345e2a'),
              render: (a) => (
                <Button
                  type="button"
                  data-testid={`alarm-detail-${a.alarmId}`}
                  onClick={() => onSelectAlarm(a.alarmId)}
                >
                  {translate('page.4f55ee1e687f')}
                </Button>
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
          emptyText={translate('page.187b55b399e6')}
        />
      ) : null}

      {tab === 'event' ? (
        <CursorTable
          ariaLabel={translate('page.dea8862146d0')}
          columns={[
            {
              key: 'occurredAt',
              header: translate('page.51f85a78cac4'),
              render: (e) => <TimeText iso={e.occurredAt} />,
            },
            { key: 'deviceId', header: translate('page.01f2c16cda65'), render: (e) => e.deviceId },
            { key: 'eventType', header: translate('page.5b2d75aa54d1'), render: (e) => e.eventType },
            { key: 'username', header: translate('page.0c7c09a07e12'), render: (e) => e.username ?? '—' },
            { key: 'source', header: translate('page.c63f79e6361e'), render: (e) => e.source ?? '—' },
            { key: 'remarks', header: translate('page.e0361480e3a5'), render: (e) => e.remarks ?? '—' },
          ]}
          rows={events.rows === null ? null : [...events.rows]}
          rowKey={(e) => e.eventId}
          {...(events.loading !== undefined ? { loading: events.loading } : {})}
          {...(events.error !== undefined ? { error: events.error } : {})}
          {...(events.nextCursor !== undefined ? { nextCursor: events.nextCursor } : {})}
          onNextPage={(cursor) => onLoadMore('event', cursor)}
          onRefresh={onRefresh}
          emptyText={translate('page.fad64b342ae1')}
        />
      ) : null}

      {tab === 'tamper' ? (
        <CursorTable
          ariaLabel={translate('page.e1d2a8d43c11')}
          columns={[
            {
              key: 'occurredAt',
              header: translate('page.51f85a78cac4'),
              render: (t) => <TimeText iso={t.occurredAt} />,
            },
            { key: 'deviceId', header: translate('page.01f2c16cda65'), render: (t) => t.deviceId },
            { key: 'eventType', header: translate('page.5b2d75aa54d1'), render: (t) => t.eventType },
            {
              key: 'severity',
              header: translate('page.9272e8abe5ad'),
              render: (t) => (
                <span className={`severity-badge severity-${t.severity.toLowerCase()}`}>
                  {ALARM_SEVERITY_LABELS[t.severity]}
                </span>
              ),
            },
            { key: 'component', header: translate('page.85b4a3ec4eed'), render: (t) => t.component ?? '—' },
            {
              key: 'details',
              header: translate('page.70ecfa4b711b'),
              render: (t) => <code>{JSON.stringify(t.details)}</code>,
            },
            { key: 'actionTaken', header: translate('page.3b1c8c512282'), render: (t) => t.actionTaken ?? '—' },
          ]}
          rows={tampers.rows === null ? null : [...tampers.rows]}
          rowKey={(t) => t.tamperEventId}
          {...(tampers.loading !== undefined ? { loading: tampers.loading } : {})}
          {...(tampers.error !== undefined ? { error: tampers.error } : {})}
          {...(tampers.nextCursor !== undefined ? { nextCursor: tampers.nextCursor } : {})}
          onNextPage={(cursor) => onLoadMore('tamper', cursor)}
          onRefresh={onRefresh}
          emptyText={translate('page.275bdfb11cb5')}
        />
      ) : null}

      {alarmDetail.kind === 'loading' ? (
        <div role="status" data-testid="alarm-detail-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : null}
      {alarmDetail.kind === 'error' ? <ErrorNotice error={alarmDetail.error} onRefresh={onRefresh} /> : null}

      {alarm !== null ? (
        <aside
          className="alarm-detail"
          data-testid="alarm-detail"
          aria-label={translate('page.775787f843fe')}
          data-severity={alarm.severity}
        >
          <h4>
            {translate('page.775787f843fe')}
            <span className={`severity-badge severity-${alarm.severity.toLowerCase()}`} data-testid="detail-severity">
              {ALARM_SEVERITY_LABELS[alarm.severity]}
            </span>
          </h4>
          <dl>
            <dt>{translate('page.beae23e3dcec')}</dt>
            <dd>{alarm.alarmId}</dd>
            <dt>{translate('page.c93a7d7c6a08')}</dt>
            <dd>
              {alarm.code} / {alarm.category}
            </dd>
            <dt>{translate('page.01f2c16cda65')}</dt>
            <dd>{alarm.deviceId}</dd>
            <dt>{translate('page.62e951a692ff')}</dt>
            <dd data-testid="detail-status">{ALARM_STATUS_LABELS[alarm.status]}</dd>
            <dt>{translate('page.51f85a78cac4')}</dt>
            <dd>
              <TimeText iso={alarm.detectedTime} />
            </dd>
            <dt>{translate('page.85b4a3ec4eed')}</dt>
            <dd>{alarm.component ?? '—'}</dd>
            <dt>{translate('page.aaab19f0f7c0')}</dt>
            <dd>
              {alarm.currentValue ?? '—'} / {alarm.threshold ?? '—'}
              {alarm.unit !== null ? ` ${alarm.unit}` : ''}
            </dd>
            <dt>{translate('page.163aec9194a1')}</dt>
            <dd>{alarm.message ?? '—'}</dd>
            <dt>{translate('page.ead76f934c4e')}</dt>
            <dd>{alarm.recommendedAction ?? '—'}</dd>
            {alarm.acknowledgedBy !== null ? (
              <>
                <dt>{translate('page.b56d9ac6c5a0')}</dt>
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
                <dt>{translate('page.7b15e5e8e7bd')}</dt>
                <dd data-testid="detail-clear">
                  {alarm.clearedBy ?? translate('page.32df337af2f3')} <TimeText iso={alarm.clearedAt} />
                  {alarm.clearReason !== null ? ` — ${alarm.clearReason}` : ''}
                </dd>
              </>
            ) : null}
          </dl>
          <div className="detail-actions">
            <Button type="button" onClick={onCloseAlarmDetail}>
              {translate('page.6c14bd7f6f9e')}
            </Button>
            <Button
              type="button"
              className="primary-button"
              data-testid="alarm-acknowledge"
              disabled={!gateAlarmAction('acknowledge', alarm.status, role).enabled || busy}
              {...(gateAlarmAction('acknowledge', alarm.status, role).reason !== null
                ? { title: gateAlarmAction('acknowledge', alarm.status, role).reason ?? '' }
                : {})}
              onClick={() => setPendingHandle('acknowledge')}
            >
              {translate('page.b56d9ac6c5a0')}
            </Button>
            <Button
              type="button"
              className="danger-button"
              data-testid="alarm-clear"
              disabled={!gateAlarmAction('clear', alarm.status, role).enabled || busy}
              {...(gateAlarmAction('clear', alarm.status, role).reason !== null
                ? { title: gateAlarmAction('clear', alarm.status, role).reason ?? '' }
                : {})}
              onClick={() => setPendingHandle('clear')}
            >
              {translate('page.7b15e5e8e7bd')}
            </Button>
          </div>
        </aside>
      ) : null}

      <ConfirmDialog
        open={pendingHandle === 'acknowledge'}
        title={translate('page.a918b708faf6')}
        requireReason
        reasonLabel={translate('page.608cce36ba4b')}
        {...(alarm !== null ? { description: translate('page.2433073de9a3') + alarm.code } : {})}
        confirmText={translate('page.a918b708faf6')}
        onConfirm={(reason) => {
          if (alarm !== null)
            void runAction(() => onAcknowledge(alarm.alarmId, reason), translate('page.b56d9ac6c5a0'));
        }}
        onCancel={() => setPendingHandle(null)}
      />
      <ConfirmDialog
        open={pendingHandle === 'clear'}
        title={translate('page.53e2f828e0bd')}
        danger
        requireReason
        reasonLabel={translate('page.d8817dcb836b')}
        {...(alarm !== null ? { description: translate('page.329ee9d020a2') + alarm.code } : {})}
        confirmText={translate('page.3bc93e7a48c1')}
        onConfirm={(reason) => {
          if (alarm !== null) void runAction(() => onClear(alarm.alarmId, reason), translate('page.7b15e5e8e7bd'));
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
  siteOptions,
  deviceOptions,
}: {
  readonly tab: AlarmTab;
  readonly draftAlarm: AlarmPageUrlState['alarm'];
  readonly draftEvent: AlarmPageUrlState['event'];
  readonly draftTamper: AlarmPageUrlState['tamper'];
  readonly onChangeAlarm: (f: AlarmPageUrlState['alarm']) => void;
  readonly onChangeEvent: (f: AlarmPageUrlState['event']) => void;
  readonly onChangeTamper: (f: AlarmPageUrlState['tamper']) => void;
  readonly siteOptions: readonly (FilterOption & {
    customerId: string;
  })[];
  readonly deviceOptions: readonly (FilterOption & {
    customerId: string;
    siteId: string;
  })[];
}) {
  const draft = tab === 'alarm' ? draftAlarm : tab === 'event' ? draftEvent : draftTamper;
  const sites = siteOptions.filter((site) => !draft.customerId || site.customerId === draft.customerId);
  const devices = deviceOptions.filter(
    (device) =>
      (!draft.customerId || device.customerId === draft.customerId) &&
      (!draft.siteId || device.siteId === draft.siteId),
  );
  const patch = (key: 'siteId' | 'deviceId' | 'from' | 'to', value: string) => {
    const v = value === '' ? null : value;
    if (tab === 'alarm') onChangeAlarm({ ...draftAlarm, [key]: v });
    else if (tab === 'event') onChangeEvent({ ...draftEvent, [key]: v });
    else onChangeTamper({ ...draftTamper, [key]: v });
  };
  const patchSite = (value: string) => {
    const siteId = value === '' ? null : value;
    if (tab === 'alarm') onChangeAlarm({ ...draftAlarm, siteId, deviceId: null });
    else if (tab === 'event') onChangeEvent({ ...draftEvent, siteId, deviceId: null });
    else onChangeTamper({ ...draftTamper, siteId, deviceId: null });
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
      <label htmlFor="filter-site">{translate('page.619bc67325a4')}</label>
      <select
        id="filter-site"
        data-testid="filter-site"
        value={draft.siteId ?? ''}
        onChange={(e) => patchSite(e.target.value)}
      >
        <option value="">{translate('page.778fc8f99453')}</option>
        {sites.map((site) => (
          <option key={site.value} value={site.value}>
            {site.label}
          </option>
        ))}
      </select>
      <label htmlFor="filter-device">{translate('page.01f2c16cda65')}</label>
      <select
        id="filter-device"
        data-testid="filter-device"
        value={draft.deviceId ?? ''}
        onChange={(e) => patch('deviceId', e.target.value)}
      >
        <option value="">{translate('page.778fc8f99453')}</option>
        {devices.map((device) => (
          <option key={device.value} value={device.value}>
            {device.label}
          </option>
        ))}
      </select>
      {tab !== 'event' ? (
        <>
          <label htmlFor="filter-severity">{translate('page.9272e8abe5ad')}</label>
          <select
            id="filter-severity"
            data-testid="filter-severity"
            value={
              (
                draft as {
                  severity: string | null;
                }
              ).severity ?? ''
            }
            onChange={(e) => patchEnum('severity', e.target.value)}
          >
            <option value="">{translate('page.778fc8f99453')}</option>
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
          <label htmlFor="filter-status">{translate('page.62e951a692ff')}</label>
          <select
            id="filter-status"
            data-testid="filter-status"
            value={draftAlarm.status ?? ''}
            onChange={(e) => patchEnum('status', e.target.value)}
          >
            <option value="">{translate('page.778fc8f99453')}</option>
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
          <label htmlFor="filter-event-type">{translate('page.5b2d75aa54d1')}</label>
          <Input
            id="filter-event-type"
            data-testid="filter-event-type"
            value={
              (
                draft as {
                  eventType: string | null;
                }
              ).eventType ?? ''
            }
            onChange={(e) => patchEnum('eventType', e.target.value)}
          />
        </>
      ) : null}
      <label htmlFor="filter-from">{translate('page.503889d576aa')}</label>
      <Input
        id="filter-from"
        data-testid="filter-from"
        placeholder="2026-09-01T00:00:00Z"
        value={draft.from ?? ''}
        onChange={(e) => patch('from', e.target.value)}
      />
      <label htmlFor="filter-to">{translate('page.864048b32f22')}</label>
      <Input
        id="filter-to"
        data-testid="filter-to"
        placeholder="2026-09-07T00:00:00Z"
        value={draft.to ?? ''}
        onChange={(e) => patch('to', e.target.value)}
      />
    </>
  );
}
