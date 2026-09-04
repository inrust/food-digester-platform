/**
 * CT-04 Notification 与 Command 目录。
 *
 * 事实源：contracts/mqtt/notification-catalog.json 与 command-catalog.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-001@1.0.0（MAINTENANCE 按 Suspended 限制）。
 *
 * 功能边界：不实现 MQTT 发布或设备动作。
 */

// ---------- Notification ----------

export type DeviceAction =
  | 'SYNC'
  | 'CHECK_CERTIFICATE_STATUS'
  | 'ROTATE_CERTIFICATE'
  | 'AWAIT_OTA_MESSAGE'
  | 'CANCEL_PENDING_OTA'
  | 'ENTER_SUSPENDED_MODE'
  | 'ENTER_RETIRED_MODE';

export type NotificationType =
  | 'SYNC_REQUIRED'
  | 'LICENSE_CHANGED'
  | 'CONFIG_CHANGED'
  | 'USERS_CHANGED'
  | 'STATUS_CHANGED'
  | 'ASSIGNMENT_CHANGED'
  | 'CERTIFICATE_EXPIRING'
  | 'CERTIFICATE_ROTATION_REQUIRED'
  | 'OTA_AVAILABLE'
  | 'OTA_CANCELLED'
  | 'SECURITY_POLICY_UPDATED'
  | 'DEVICE_SUSPENDED'
  | 'DEVICE_RETIRED';

export interface NotificationSpec {
  readonly type: NotificationType;
  readonly deviceAction: DeviceAction;
  readonly description: string;
}

export const NOTIFICATION_CATALOG: Readonly<Record<NotificationType, NotificationSpec>> = {
  SYNC_REQUIRED: { type: 'SYNC_REQUIRED', deviceAction: 'SYNC', description: '调用 /api/v1/device/sync' },
  LICENSE_CHANGED: { type: 'LICENSE_CHANGED', deviceAction: 'SYNC', description: '调用 /api/v1/device/sync' },
  CONFIG_CHANGED: { type: 'CONFIG_CHANGED', deviceAction: 'SYNC', description: '调用 /api/v1/device/sync' },
  USERS_CHANGED: { type: 'USERS_CHANGED', deviceAction: 'SYNC', description: '调用 /api/v1/device/sync' },
  STATUS_CHANGED: { type: 'STATUS_CHANGED', deviceAction: 'SYNC', description: '调用 /api/v1/device/sync' },
  ASSIGNMENT_CHANGED: { type: 'ASSIGNMENT_CHANGED', deviceAction: 'SYNC', description: '调用 /api/v1/device/sync' },
  CERTIFICATE_EXPIRING: {
    type: 'CERTIFICATE_EXPIRING',
    deviceAction: 'CHECK_CERTIFICATE_STATUS',
    description: '调用证书状态 API',
  },
  CERTIFICATE_ROTATION_REQUIRED: {
    type: 'CERTIFICATE_ROTATION_REQUIRED',
    deviceAction: 'ROTATE_CERTIFICATE',
    description: '调用证书轮换 API',
  },
  OTA_AVAILABLE: { type: 'OTA_AVAILABLE', deviceAction: 'AWAIT_OTA_MESSAGE', description: '等待/接收 OTA Topic' },
  OTA_CANCELLED: { type: 'OTA_CANCELLED', deviceAction: 'CANCEL_PENDING_OTA', description: '取消待执行升级' },
  SECURITY_POLICY_UPDATED: { type: 'SECURITY_POLICY_UPDATED', deviceAction: 'SYNC', description: 'Sync 最新安全策略' },
  DEVICE_SUSPENDED: {
    type: 'DEVICE_SUSPENDED',
    deviceAction: 'ENTER_SUSPENDED_MODE',
    description: '进入 Suspended 模式',
  },
  DEVICE_RETIRED: { type: 'DEVICE_RETIRED', deviceAction: 'ENTER_RETIRED_MODE', description: '进入 Retired 模式' },
} as const;

// ---------- Command ----------

export type CommandCategory = 'MACHINE' | 'MOTOR' | 'HEATING' | 'VENTILATION' | 'DISCHARGE' | 'DEVICE';

/** 设备 Operational 状态。MAINTENANCE 为 DEC-001 冻结值（按 Suspended 限制）。 */
export type OperationalStatus = 'ACTIVE' | 'MAINTENANCE' | 'SUSPENDED' | 'RETIRED';

export type CommandCode =
  | 'START'
  | 'STOP'
  | 'PAUSE'
  | 'RESUME'
  | 'EMERGENCY_STOP'
  | 'AGITATOR_FORWARD'
  | 'AGITATOR_REVERSE'
  | 'AGITATOR_STOP'
  | 'HEATING_ON'
  | 'HEATING_OFF'
  | 'SET_TARGET_TEMPERATURE'
  | 'EXHAUST_ON'
  | 'EXHAUST_OFF'
  | 'AIR_SUPPLY_ON'
  | 'AIR_SUPPLY_OFF'
  | 'DISCHARGE_START'
  | 'DISCHARGE_STOP'
  | 'REBOOT'
  | 'SHUTDOWN'
  | 'FACTORY_RESET'
  | 'TAKE_SNAPSHOT'
  | 'FORCE_SYNC';

export interface CommandSpec {
  readonly command: CommandCode;
  readonly category: CommandCategory;
  /** 高风险命令：要求更严格的权限、确认凭证、审计和超时策略。 */
  readonly highRisk: boolean;
  /** 允许执行的设备 Operational 状态。 */
  readonly allowedStatuses: readonly OperationalStatus[];
}

const ACTIVE_ONLY = ['ACTIVE'] as const;
const STOP_DIAG_SYNC_MAINT = ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'] as const;

export const COMMAND_CATALOG: Readonly<Record<CommandCode, CommandSpec>> = {
  // Machine Operation
  START: { command: 'START', category: 'MACHINE', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  STOP: { command: 'STOP', category: 'MACHINE', highRisk: false, allowedStatuses: STOP_DIAG_SYNC_MAINT },
  PAUSE: { command: 'PAUSE', category: 'MACHINE', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  RESUME: { command: 'RESUME', category: 'MACHINE', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  EMERGENCY_STOP: {
    command: 'EMERGENCY_STOP',
    category: 'MACHINE',
    highRisk: true,
    allowedStatuses: STOP_DIAG_SYNC_MAINT,
  },
  // Motor
  AGITATOR_FORWARD: { command: 'AGITATOR_FORWARD', category: 'MOTOR', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  AGITATOR_REVERSE: { command: 'AGITATOR_REVERSE', category: 'MOTOR', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  AGITATOR_STOP: { command: 'AGITATOR_STOP', category: 'MOTOR', highRisk: true, allowedStatuses: STOP_DIAG_SYNC_MAINT },
  // Heating
  HEATING_ON: { command: 'HEATING_ON', category: 'HEATING', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  HEATING_OFF: { command: 'HEATING_OFF', category: 'HEATING', highRisk: true, allowedStatuses: STOP_DIAG_SYNC_MAINT },
  SET_TARGET_TEMPERATURE: {
    command: 'SET_TARGET_TEMPERATURE',
    category: 'HEATING',
    highRisk: true,
    allowedStatuses: ACTIVE_ONLY,
  },
  // Ventilation
  EXHAUST_ON: { command: 'EXHAUST_ON', category: 'VENTILATION', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  EXHAUST_OFF: {
    command: 'EXHAUST_OFF',
    category: 'VENTILATION',
    highRisk: false,
    allowedStatuses: STOP_DIAG_SYNC_MAINT,
  },
  AIR_SUPPLY_ON: { command: 'AIR_SUPPLY_ON', category: 'VENTILATION', highRisk: false, allowedStatuses: ACTIVE_ONLY },
  AIR_SUPPLY_OFF: {
    command: 'AIR_SUPPLY_OFF',
    category: 'VENTILATION',
    highRisk: false,
    allowedStatuses: STOP_DIAG_SYNC_MAINT,
  },
  // Discharge
  DISCHARGE_START: { command: 'DISCHARGE_START', category: 'DISCHARGE', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  DISCHARGE_STOP: {
    command: 'DISCHARGE_STOP',
    category: 'DISCHARGE',
    highRisk: true,
    allowedStatuses: STOP_DIAG_SYNC_MAINT,
  },
  // Device
  REBOOT: { command: 'REBOOT', category: 'DEVICE', highRisk: false, allowedStatuses: STOP_DIAG_SYNC_MAINT },
  SHUTDOWN: { command: 'SHUTDOWN', category: 'DEVICE', highRisk: true, allowedStatuses: STOP_DIAG_SYNC_MAINT },
  FACTORY_RESET: { command: 'FACTORY_RESET', category: 'DEVICE', highRisk: true, allowedStatuses: ACTIVE_ONLY },
  TAKE_SNAPSHOT: {
    command: 'TAKE_SNAPSHOT',
    category: 'DEVICE',
    highRisk: false,
    allowedStatuses: STOP_DIAG_SYNC_MAINT,
  },
  FORCE_SYNC: { command: 'FORCE_SYNC', category: 'DEVICE', highRisk: false, allowedStatuses: STOP_DIAG_SYNC_MAINT },
} as const;

// ---------- 查询函数（未知值运行时拒绝；编译期由联合类型拒绝） ----------

export class CatalogError extends Error {
  readonly kind: 'UNKNOWN_COMMAND' | 'UNKNOWN_NOTIFICATION';

  constructor(kind: CatalogError['kind'], value: string) {
    super(`${kind}: ${value}`);
    this.name = 'CatalogError';
    this.kind = kind;
  }
}

export function isKnownCommand(value: string): value is CommandCode {
  return Object.hasOwn(COMMAND_CATALOG, value);
}

export function isKnownNotification(value: string): value is NotificationType {
  return Object.hasOwn(NOTIFICATION_CATALOG, value);
}

export function getCommand(value: string): CommandSpec {
  if (!isKnownCommand(value)) throw new CatalogError('UNKNOWN_COMMAND', value);
  return COMMAND_CATALOG[value];
}

export function getNotification(value: string): NotificationSpec {
  if (!isKnownNotification(value)) throw new CatalogError('UNKNOWN_NOTIFICATION', value);
  return NOTIFICATION_CATALOG[value];
}

/** 命令是否允许在指定 Operational 状态下执行。未知命令返回 false（拒绝优先）。 */
export function isCommandAllowed(command: string, status: OperationalStatus): boolean {
  if (!isKnownCommand(command)) return false;
  if (status === 'RETIRED') return false;
  return COMMAND_CATALOG[command].allowedStatuses.includes(status);
}

/** 命令执行被拒绝时的稳定原因码，供 API denyReason 使用（BE-CMD-01/BE-DASH-01）。 */
export function commandDenyReason(command: string, status: OperationalStatus): string | null {
  if (!isKnownCommand(command)) return 'UNKNOWN_COMMAND';
  if (isCommandAllowed(command, status)) return null;
  if (status === 'RETIRED') return 'DEVICE_RETIRED';
  if (status === 'SUSPENDED') return 'DEVICE_SUSPENDED_RESTRICTED';
  return 'DEVICE_MAINTENANCE_RESTRICTED';
}

export function listCommands(filter?: { category?: CommandCategory; highRisk?: boolean }): CommandSpec[] {
  return Object.values(COMMAND_CATALOG).filter(
    (spec) =>
      (filter?.category === undefined || spec.category === filter.category) &&
      (filter?.highRisk === undefined || spec.highRisk === filter.highRisk),
  );
}

export function listNotificationsByAction(action: DeviceAction): NotificationSpec[] {
  return Object.values(NOTIFICATION_CATALOG).filter((spec) => spec.deviceAction === action);
}
