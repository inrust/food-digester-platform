/**
 * 由 scripts/generate-payload-types.mjs 从 contracts/mqtt/schemas/*.schema.json 生成。
 * 请勿手工编辑；修改 Schema 后重新运行生成器。
 */

/** 消息 meta（下行：seq 可选，DEC-006）。 */
export interface Meta {
  id: string;
  ts: string;
  seq?: number;
  schemaVer?: string;
}

/** 上行消息 meta：seq 必填。 */
export interface MetaSeq extends Meta {
  seq: number;
}

export interface Audit {
  hash: string;
}

export interface AckData {
  /** DEC-015 判别字段：COMMAND 与 OTA_TARGET 关联字段禁止混用。 */
  objectType: "COMMAND" | "OTA_TARGET";
  /** 关联的 Command meta.id，如 CMD-DEV001-6001。 */
  commandId?: string;
  /** V1 命令白名单（22 个，command-catalog.json，CT-04）。 */
  command?: "START" | "STOP" | "PAUSE" | "RESUME" | "EMERGENCY_STOP" | "AGITATOR_FORWARD" | "AGITATOR_REVERSE" | "AGITATOR_STOP" | "HEATING_ON" | "HEATING_OFF" | "SET_TARGET_TEMPERATURE" | "EXHAUST_ON" | "EXHAUST_OFF" | "AIR_SUPPLY_ON" | "AIR_SUPPLY_OFF" | "DISCHARGE_START" | "DISCHARGE_STOP" | "REBOOT" | "SHUTDOWN" | "FACTORY_RESET" | "TAKE_SNAPSHOT" | "FORCE_SYNC";
  result?: "SUCCESS" | "FAILED";
  executeTimeMs?: number;
  /** OTA_TARGET 回执关联的云端 OtaTarget ID。 */
  otaTargetId?: string;
  /** DEC-015 冻结的 OTA 多阶段状态。 */
  status?: "DOWNLOADING" | "INSTALLING" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK";
  errorCode?: string | null;
  message?: string;
}

export interface AckPayload {
  meta: MetaSeq;
  audit?: never;
  data: AckData;
}

export interface AlarmData {
  code?: string;
  category?: string;
  severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status?: "ACTIVE" | "CLEARED";
  detectedTime?: string;
  component?: string;
  currentValue?: number;
  threshold?: number;
  unit?: string;
  message?: string;
  recommendedAction?: string;
}

export interface AlarmPayload {
  meta: MetaSeq;
  audit?: never;
  data: AlarmData;
}

export interface CommandData {
  /** V1 命令白名单（22 个，command-catalog.json，CT-04）；meta.id 即 commandId。 */
  command: "START" | "STOP" | "PAUSE" | "RESUME" | "EMERGENCY_STOP" | "AGITATOR_FORWARD" | "AGITATOR_REVERSE" | "AGITATOR_STOP" | "HEATING_ON" | "HEATING_OFF" | "SET_TARGET_TEMPERATURE" | "EXHAUST_ON" | "EXHAUST_OFF" | "AIR_SUPPLY_ON" | "AIR_SUPPLY_OFF" | "DISCHARGE_START" | "DISCHARGE_STOP" | "REBOOT" | "SHUTDOWN" | "FACTORY_RESET" | "TAKE_SNAPSHOT" | "FORCE_SYNC";
  /** 请求发起者；云端以身份上下文为准，不信任客户端声明（ADP-001）。 */
  requestedBy?: string;
  requestTime: string;
  timeoutSec: number;
  remarks?: string;
}

export interface CommandPayload {
  meta: Meta;
  audit?: never;
  data: CommandData;
}

export interface EventData {
  eventType?: string;
  userId?: string;
  username?: string;
  source?: "LOCAL" | "REMOTE";
  remarks?: string;
}

export interface EventPayload {
  meta: MetaSeq;
  audit?: never;
  data: EventData;
}

export interface HeartbeatData {
  deviceStatus: "ONLINE" | "DEGRADED" | "OFFLINE";
  uptimeSeconds: number;
  firmwareVersion: string;
  operationalStatus: "ACTIVE" | "SUSPENDED" | "RETIRED";
  machineRunning: boolean;
  /** DEC-013 正式枚举使用 DISCHARGING；DISCHARING 仅由入口兼容转换器在截止时间前接收。 */
  machineMode: "IDLE" | "PROCESSING" | "HEATING" | "DISCHARGING" | "STOPPED" | "ERROR";
  licenseStatus: "ACTIVE" | "EXPIRING" | "EXPIRED" | "REVOKED";
  licenseExpiryDate?: string;
  /** 通信设计标记为 Enum 但未给出完整枚举值（示例 4G），冻结前按非空字符串处理。 */
  networkType: string;
  networkStatus: "CONNECTED" | "WEAK" | "DISCONNECTED";
  signalStrength?: number;
  cpuUsagePct?: number;
  memoryUsagePct?: number;
  /** DEC-013 冻结：可选 number，范围 0～100，禁止 null。 */
  storageUsagePct?: number;
  sensorOverallStatus: "NORMAL" | "WARNING" | "FAILED";
  temperatureSensor?: "NORMAL" | "WARNING" | "FAILED";
  humiditySensor?: "NORMAL" | "WARNING" | "FAILED";
  weightSensor?: "NORMAL" | "WARNING" | "FAILED";
  gasSensor?: "NORMAL" | "WARNING" | "FAILED";
  certificateStatus?: "VALID" | "EXPIRING" | "EXPIRED" | "REVOKED";
  /** 通信设计仅给出示例 NORMAL；DEC-013 保持可选非空字符串，存在时禁止 null。 */
  tamperStatus?: string;
}

export interface HeartbeatPayload {
  meta: MetaSeq;
  audit?: never;
  data: HeartbeatData;
}

export interface MediaData {
  mediaType?: "IMAGE" | "VIDEO";
  captureTime?: string;
  fileName?: string;
  /** 云存储路径；授权前缀校验由 BE-IOT-08/BE-MED-01 处理。 */
  objectPath?: string;
  sizeKb?: number;
  /** 视频时长，图片为 0。 */
  durationSec?: number;
}

export interface MediaPayload {
  meta: MetaSeq;
  audit?: never;
  data: MediaData;
}

export interface NotificationData {
  /** 通知类型（13 个，notification-catalog.json，CT-04）。 */
  type?: "SYNC_REQUIRED" | "LICENSE_CHANGED" | "CONFIG_CHANGED" | "USERS_CHANGED" | "STATUS_CHANGED" | "ASSIGNMENT_CHANGED" | "CERTIFICATE_EXPIRING" | "CERTIFICATE_ROTATION_REQUIRED" | "OTA_AVAILABLE" | "OTA_CANCELLED" | "SECURITY_POLICY_UPDATED" | "DEVICE_SUSPENDED" | "DEVICE_RETIRED";
  priority?: "LOW" | "NORMAL" | "HIGH";
  title?: string;
  message?: string;
  /** 建议设备动作，如 SYNC。 */
  action?: string;
}

export interface NotificationPayload {
  meta: Meta;
  audit?: never;
  data: NotificationData;
}

export interface OtaData {
  version?: string;
  packageType?: "APP" | "FIRMWARE";
  downloadUrl?: string;
  sha256?: string;
  mandatory?: boolean;
  scheduledTime?: string;
}

export interface OtaPayload {
  meta: Meta;
  audit?: never;
  data: OtaData;
}

export interface EsgReportData {
  reportType?: "CYCLE" | "HOURLY" | "DAILY";
  periodStartTime?: string;
  periodEndTime?: string;
  feedingWeightKg?: number;
  dischargeWeightKg?: number;
  reductionWeightKg?: number;
  cycleCount?: number;
  processingDurationMinutes?: number;
  energyConsumptionKwh?: number;
  averagePowerKw?: number;
  averageO2Pct?: number;
  averageCo2Ppm?: number;
  averageCh4Ppm?: number;
  averageN2oPpm?: number;
  carbonReductionKg?: number;
  /** 计算方法版本，如 DEFAULT_V1。 */
  carbonReductionMethod?: string;
  dataCompletenessPct?: number;
  missingRecordCount?: number;
}

export interface EsgReportPayload {
  meta: MetaSeq;
  audit: Audit;
  data: EsgReportData;
}

export interface TamperData {
  /** 安全事件类型，如 ROOT_DETECTED。 */
  eventType?: string;
  /** 沿用 Alarm 严重度词表；DEC-013 冻结为可选枚举，存在时禁止 null。 */
  severity?: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  component?: string;
  details?: string;
  /** 自动响应动作，如 DEVICE_SUSPENDED。 */
  actionTaken?: string;
}

export interface TamperPayload {
  meta: MetaSeq;
  audit: Audit;
  data: TamperData;
}

export interface TelemetryData {
  feedingWeightKg?: number;
  chamberWeightKg?: number;
  dischargeWeightKg?: number;
  humidityPct?: number;
  ambientTempC?: number;
  heatTemperatureC?: number;
  siloTemperatureC?: number;
  powerConsumptionKw?: number;
  o2Pct?: number;
  co2Ppm?: number;
  ch4Ppm?: number;
  n2oPpm?: number;
  /** DEC-013 正式字段；motorCurrentAmp 仅由入口兼容转换器在截止时间前接收。 */
  currentAmp?: number;
}

export interface TelemetryPayload {
  meta: MetaSeq;
  audit: Audit;
  data: TelemetryData;
}

/** Topic type 到 Payload 类型的映射。 */
export interface PayloadByTopicType {
  ack: AckPayload;
  alarm: AlarmPayload;
  cmd: CommandPayload;
  event: EventPayload;
  heartbeat: HeartbeatPayload;
  media: MediaPayload;
  notification: NotificationPayload;
  ota: OtaPayload;
  report: EsgReportPayload;
  tamper: TamperPayload;
  telemetry: TelemetryPayload;
}
