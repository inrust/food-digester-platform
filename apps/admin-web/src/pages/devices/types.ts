/**
 * FE-06 设备台账/控制台数据类型：镜像 admin-device-api.json（BE-DEV-01）
 * 与 admin-device-console-api.json（BE-DEV-05）。
 */

export type Connectivity = 'ONLINE' | 'OFFLINE';

export interface SiteRef {
  readonly id: string;
  readonly name: string;
  readonly region: string | null;
  readonly subregion: string | null;
}

export interface CustomerRef {
  readonly id: string;
  readonly name: string;
}

export interface DeviceContractSummaryView {
  readonly contractId: string;
  readonly contractNumber: string;
  readonly name: string;
  readonly status: 'DRAFT' | 'EFFECTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'TERMINATED';
  readonly endAt: string;
}

/** BE-DEV-01 Device.certificate：仅摘要（ID/指纹/状态），契约不返回完整证书/私钥。 */
export interface DeviceCertificateSummaryView {
  readonly certificateId: string;
  readonly fingerprint: string;
  readonly status: 'PENDING_CLAIM' | 'ACTIVE' | 'REVOKED' | 'EXPIRED';
}

/** BE-DEV-01 Device.license：当前授权摘要（DOM-02；与 Contract 状态独立，DEC-007）。 */
export interface DeviceLicenseSummaryView {
  readonly licenseId: string;
  readonly status: 'Draft' | 'Issued' | 'Active' | 'ExpiringSoon' | 'Renewed' | 'Expired' | 'Revoked';
  readonly validFrom: string;
  readonly validTo: string;
  /** 已启用 Entitlement 编码。 */
  readonly entitlements: readonly string[];
}

export interface DeviceView {
  readonly id: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: string;
  readonly alias: string | null;
  readonly firmwareVersion: string | null;
  readonly customer: CustomerRef | null;
  readonly site: SiteRef | null;
  readonly lifecycleStatus: string;
  readonly operationalStatus: 'Active' | 'Maintenance' | 'Suspended' | 'Retired' | null;
  readonly connectivity: Connectivity;
  readonly lastHeartbeatAt: string | null;
  readonly certificate: DeviceCertificateSummaryView | null;
  readonly license: DeviceLicenseSummaryView | null;
  readonly contract: DeviceContractSummaryView | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------- 控制台（BE-DEV-05） ----------

export interface ObservedBlockView {
  readonly observedAt: string | null;
  readonly stale: boolean;
}

export type ComponentHealth = 'NORMAL' | 'WARNING' | 'FAILED';

export interface ComponentsView extends ObservedBlockView {
  readonly status: {
    readonly overall: ComponentHealth | null;
    readonly temperature: ComponentHealth | null;
    readonly humidity: ComponentHealth | null;
    readonly weight: ComponentHealth | null;
    readonly gas: ComponentHealth | null;
  };
}

export interface MetricValueView {
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly unit: 'kg' | '%' | '°C' | 'kW' | 'ppm' | 'A';
}

export interface MetricsView extends ObservedBlockView {
  readonly metrics: Readonly<Record<string, MetricValueView | null>>;
}

export interface NetworkView extends ObservedBlockView {
  readonly signalStrength: number | null;
  readonly networkType: string | null;
  readonly networkStatus: string | null;
}

export interface ConsoleConsumableView {
  readonly consumableType: 'CARBON_FILTER' | 'BIO_ADDITIVE';
  readonly remainingPercent: number | null;
  readonly stale: boolean;
  readonly observedAt: string | null;
}

export interface ConsoleAlarmView {
  readonly alarmId: string;
  readonly code: string;
  readonly severity: 'INFO' | 'WARNING' | 'MAJOR' | 'CRITICAL';
  readonly status: 'ACTIVE' | 'ACKNOWLEDGED' | 'CLEARED';
  readonly detectedTime: string;
}

export interface EsgDayView {
  readonly summaryDate: string;
  readonly carbonReductionKg: number | null;
  readonly powerConsumptionKwh: number | null;
  readonly feedingWeightKg: number | null;
}

export interface LatestMediaView {
  readonly mediaId: string;
  readonly mediaType: string;
  readonly captureTime: string;
}

export interface ConsoleDeviceBrief {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly alias: string | null;
  readonly model: string;
  readonly lifecycleStatus: string;
  readonly operationalStatus: string | null;
  readonly connectivity: Connectivity;
  readonly licenseStatus: string | null;
  readonly firmwareVersion: string | null;
}

export interface DeviceConsoleView {
  readonly generatedAt: string;
  readonly device: ConsoleDeviceBrief;
  readonly components: ComponentsView;
  readonly metrics: MetricsView;
  readonly network: NetworkView;
  readonly consumables: readonly ConsoleConsumableView[];
  readonly recentAlarms: readonly ConsoleAlarmView[];
  readonly contract: DeviceContractSummaryView | null;
  readonly esgLast7Days: readonly EsgDayView[];
  readonly latestMedia: LatestMediaView | null;
}
