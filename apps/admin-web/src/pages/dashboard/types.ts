/**
 * FE-03 总览页数据类型：镜像 contracts/rest/admin-dashboard-api.json（BE-DASH-01）。
 * 字段与契约一一对应，禁止引入原型硬编码演示值。
 */

export type DenyReason =
  'FORBIDDEN' | 'UNKNOWN_COMMAND' | 'DEVICE_RETIRED' | 'DEVICE_SUSPENDED_RESTRICTED' | 'DEVICE_MAINTENANCE_RESTRICTED';

export interface CommandActionView {
  readonly command: string;
  readonly allowed: boolean;
  readonly denyReason: DenyReason | null;
}

export interface ConsumableSummaryView {
  readonly consumableType: 'CARBON_FILTER' | 'BIO_ADDITIVE';
  readonly remainingPercent: number | null;
  readonly stale: boolean;
}

export type AlarmSeverity = 'INFO' | 'WARNING' | 'MAJOR' | 'CRITICAL';

export interface AlarmSummaryView {
  readonly alarmId: string;
  readonly deviceId: string;
  readonly customerId: string | null;
  readonly code: string;
  readonly severity: AlarmSeverity;
  readonly status: 'ACTIVE' | 'ACKNOWLEDGED' | 'CLEARED';
  readonly detectedTime: string;
}

export interface DeviceCardView {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly alias: string | null;
  readonly model: string;
  readonly lifecycleStatus: string;
  readonly operationalStatus: 'Active' | 'Maintenance' | 'Suspended' | 'Retired' | null;
  readonly connectivity: 'ONLINE' | 'OFFLINE';
  readonly licenseStatus: string | null;
  readonly firmwareVersion: string | null;
  readonly signalStrength: number | null;
  readonly networkType: string | null;
  readonly consumables: readonly ConsumableSummaryView[];
  readonly actions: readonly CommandActionView[];
}

export interface DashboardOverviewView {
  readonly generatedAt: string;
  readonly contracts: { readonly effectiveTotal: number };
  readonly devices: {
    readonly total: number;
    readonly online: number;
    readonly onlineRatePct: number;
    readonly licenseDistribution: Readonly<Record<string, number>>;
  };
  readonly esgToday: {
    readonly summaryDate: string;
    readonly carbonReductionKg: number;
    readonly powerConsumptionKwh: number;
    readonly feedingWeightKg: number;
  };
  readonly latestAlarms: readonly AlarmSummaryView[];
  readonly deviceCards: readonly DeviceCardView[];
}
