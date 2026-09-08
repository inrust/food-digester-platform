/**
 * FE-10 Alarm/Event/Tamper 数据类型：镜像 admin-alarm-api.json（BE-ALM-01）。
 */

export type AlarmSeverity = 'INFO' | 'WARNING' | 'MAJOR' | 'CRITICAL';
export type AlarmStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'CLEARED';

export interface AlarmView {
  readonly alarmId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly code: string;
  readonly category: string;
  readonly severity: AlarmSeverity;
  readonly status: AlarmStatus;
  readonly detectedTime: string;
  readonly component: string | null;
  readonly currentValue: string | null;
  readonly threshold: string | null;
  readonly unit: string | null;
  readonly message: string | null;
  readonly recommendedAction: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgeReason: string | null;
  readonly clearedBy: string | null;
  readonly clearedAt: string | null;
  readonly clearReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AlarmHandleResultView extends AlarmView {
  /** 幂等重放：目标状态已达成，无写入/审计/领域事件。 */
  readonly replayed: boolean;
}

export interface DeviceEventView {
  readonly eventId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly eventType: string;
  readonly userId: string | null;
  readonly username: string | null;
  readonly source: string | null;
  readonly remarks: string | null;
  readonly occurredAt: string;
}

export interface TamperEventView {
  readonly tamperEventId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly eventType: string;
  readonly severity: AlarmSeverity;
  readonly component: string | null;
  /** 设备上报的结构化细节（原样透传，展示为 JSON）。 */
  readonly details: unknown;
  readonly actionTaken: string | null;
  readonly occurredAt: string;
}
