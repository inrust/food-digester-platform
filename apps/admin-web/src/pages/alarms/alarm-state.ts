import { translate } from '../../i18n/i18n.js';
/**
 * FE-10 Alarm/Event/Tamper 纯逻辑：状态机矩阵、权限门、文案、筛选 ⇄ URL 同步。
 *
 * - 状态机（BE-ALM-01 领域封闭校验）：ACTIVE→确认/清除；ACKNOWLEDGED→清除；CLEARED 终态；
 *   重复确认/清除幂等（replayed=true，页面提示“重复操作已幂等忽略”）；
 * - 确认/清除仅 alarm:write（PlatformSuperAdmin/PlatformOperator）；
 * - Customer 角色租户隔离由服务端强制（跨 Customer → 404），前端不渲染客户筛选；
 * - 功能边界：本页只呈现业务告警/事件/防拆，不混入 AWS 运维告警（CloudWatch/SQS/RDS）。
 */
import { hasPermission } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
import type { AlarmListFilter, EventListFilter, TamperListFilter } from './alarms-api.js';
import type { AlarmSeverity, AlarmStatus } from './types.js';
export const ALARM_SEVERITY_OPTIONS: readonly AlarmSeverity[] = ['INFO', 'WARNING', 'MAJOR', 'CRITICAL'];
export const ALARM_SEVERITY_LABELS: Readonly<Record<AlarmSeverity, string>> = {
  get INFO() {
    return translate('ui.ab3656a956f5');
  },
  get WARNING() {
    return translate('ui.5521e368d87e');
  },
  get MAJOR() {
    return translate('ui.b7f46707527b');
  },
  get CRITICAL() {
    return translate('ui.81ffc6f5a47f');
  },
};
export const ALARM_STATUS_OPTIONS: readonly AlarmStatus[] = ['ACTIVE', 'ACKNOWLEDGED', 'CLEARED'];
export const ALARM_STATUS_LABELS: Readonly<Record<AlarmStatus, string>> = {
  get ACTIVE() {
    return translate('ui.b2548636f024');
  },
  get ACKNOWLEDGED() {
    return translate('ui.d9fea67ad2be');
  },
  get CLEARED() {
    return translate('ui.1214e9850cfd');
  },
};
export type AlarmAction = 'acknowledge' | 'clear';
/** 状态 → 允许动作（契约领域封闭校验的镜像）。 */
export const ALARM_ACTION_MATRIX: Readonly<Record<AlarmStatus, readonly AlarmAction[]>> = {
  ACTIVE: ['acknowledge', 'clear'],
  ACKNOWLEDGED: ['clear'],
  CLEARED: [],
};
export interface AlarmActionGate {
  readonly enabled: boolean;
  readonly reason: string | null;
}
export function gateAlarmAction(action: AlarmAction, status: AlarmStatus, role: Role): AlarmActionGate {
  if (!ALARM_ACTION_MATRIX[status].includes(action)) {
    return { enabled: false, reason: translate('ui.c22aac24933c') };
  }
  if (!hasPermission(role, 'alarm:write')) {
    return { enabled: false, reason: translate('ui.65aeb526f733') };
  }
  return { enabled: true, reason: null };
}
// ---------- 筛选 ⇄ URL 同步（验收：筛选参数与 URL 同步） ----------
export type AlarmTab = 'alarm' | 'event' | 'tamper';
export const ALARM_TABS: readonly AlarmTab[] = ['alarm', 'event', 'tamper'];
export const ALARM_TAB_LABELS: Readonly<Record<AlarmTab, string>> = {
  get alarm() {
    return translate('page.5078424f7e0e');
  },
  get event() {
    return translate('page.550e3280629d');
  },
  get tamper() {
    return translate('ui.734b3aa67bdc');
  },
};
export const EMPTY_ALARM_FILTER: Required<AlarmListFilter> = {
  customerId: null,
  siteId: null,
  deviceId: null,
  severity: null,
  status: null,
  from: null,
  to: null,
};
export const EMPTY_EVENT_FILTER: Required<EventListFilter> = {
  customerId: null,
  siteId: null,
  deviceId: null,
  eventType: null,
  from: null,
  to: null,
};
export const EMPTY_TAMPER_FILTER: Required<TamperListFilter> = {
  customerId: null,
  siteId: null,
  deviceId: null,
  eventType: null,
  severity: null,
  from: null,
  to: null,
};
/** 页面 URL 状态：当前 Tab + 各 Tab 已应用筛选。 */
export interface AlarmPageUrlState {
  readonly tab: AlarmTab;
  readonly alarm: Required<AlarmListFilter>;
  readonly event: Required<EventListFilter>;
  readonly tamper: Required<TamperListFilter>;
}
export const DEFAULT_URL_STATE: AlarmPageUrlState = {
  tab: 'alarm',
  alarm: EMPTY_ALARM_FILTER,
  event: EMPTY_EVENT_FILTER,
  tamper: EMPTY_TAMPER_FILTER,
};
const COMMON_KEYS = ['customerId', 'siteId', 'deviceId', 'from', 'to'] as const;
function readEnum<T extends string>(value: string | null, options: readonly T[]): T | null {
  return value !== null && (options as readonly string[]).includes(value) ? (value as T) : null;
}
/** 序列化为查询串（仅当前 Tab 的筛选入 URL；null 不写入）。 */
export function urlStateToSearch(state: AlarmPageUrlState): string {
  const params = new URLSearchParams();
  params.set('tab', state.tab);
  const active = state[state.tab] as Record<string, string | null>;
  for (const key of COMMON_KEYS) {
    const value = active[key];
    if (value !== null && value !== '') params.set(key, value);
  }
  if (state.tab !== 'event') {
    const severity = (active as Required<AlarmListFilter>).severity ?? (active as Required<TamperListFilter>).severity;
    if (severity) params.set('severity', severity);
  }
  if (state.tab === 'alarm') {
    const status = (active as Required<AlarmListFilter>).status;
    if (status) params.set('status', status);
  }
  if (state.tab !== 'alarm') {
    const eventType = (active as Required<EventListFilter>).eventType;
    if (eventType !== null && eventType !== '') params.set('eventType', eventType);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}
/** 从查询串解析（未知/非法枚举静默丢弃；缺省回退默认）。 */
export function urlStateFromSearch(search: string): AlarmPageUrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const tabParam = params.get('tab');
  const tab: AlarmTab = (ALARM_TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as AlarmTab) : 'alarm';
  const common = {
    customerId: params.get('customerId'),
    siteId: params.get('siteId'),
    deviceId: params.get('deviceId'),
    from: params.get('from'),
    to: params.get('to'),
  };
  const severity = readEnum(params.get('severity'), ALARM_SEVERITY_OPTIONS);
  const status = readEnum(params.get('status'), ALARM_STATUS_OPTIONS);
  const eventType = params.get('eventType');
  return {
    tab,
    alarm: {
      ...EMPTY_ALARM_FILTER,
      ...common,
      severity: tab === 'alarm' ? severity : null,
      status: tab === 'alarm' ? status : null,
    },
    event: { ...EMPTY_EVENT_FILTER, ...common, eventType: tab === 'event' ? eventType : null },
    tamper: {
      ...EMPTY_TAMPER_FILTER,
      ...common,
      severity: tab === 'tamper' ? severity : null,
      eventType: tab === 'tamper' ? eventType : null,
    },
  };
}
