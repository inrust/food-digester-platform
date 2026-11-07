/**
 * FE-10 Alarm/Event/Tamper 数据类型：镜像 admin-alarm-api.json（BE-ALM-01）。
 */

import type { Alarm, DeviceEvent } from '@fdp/contracts/rest/image-types.js';
export type AlarmView = Alarm;
export type AlarmSeverity = Alarm['severity'];
export type AlarmStatus = Alarm['status'];
export type DeviceEventView = DeviceEvent;

export interface AlarmHandleResultView extends AlarmView {
  /** Idempotent replay of an already completed action. */
  readonly replayed: boolean;
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
