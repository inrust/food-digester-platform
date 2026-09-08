/**
 * FE-12 Remote Command 数据类型：镜像 admin-command-api.json（BE-CMD-01/03）与
 * admin-device-console-api.json 活动日志/导出（BE-DEV-05）。
 */

export type CommandName =
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

export type CommandCategory = 'MACHINE' | 'MOTOR' | 'HEATING' | 'VENTILATION' | 'DISCHARGE' | 'DEVICE';

export type CommandStatus =
  | 'CREATED'
  | 'AUTHORIZED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'ACKNOWLEDGED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED';

/** 创建响应（创建即 AUTHORIZED；幂等重放 replayed=true）。 */
export interface CommandView {
  readonly commandId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly command: CommandName;
  readonly category: CommandCategory;
  readonly highRisk: boolean;
  readonly status: 'AUTHORIZED';
  /** 身份上下文取得（不信任客户端声明；页面不可编辑）。 */
  readonly requestedBy: string;
  readonly requestTime: string;
  readonly timeoutSec: number;
  readonly expiresAt: string;
  readonly remarks: string | null;
  readonly confirmedBy: string | null;
  readonly version: number;
  readonly replayed: boolean;
}

export interface CommandListItemView {
  readonly commandId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly command: CommandName;
  readonly category: CommandCategory;
  readonly highRisk: boolean;
  readonly status: CommandStatus;
  readonly requestedBy: string;
  readonly requestTime: string;
  readonly timeoutSec: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommandAttemptView {
  readonly attemptNo: number;
  readonly publishedAt: string;
}

export interface CommandAckView {
  readonly result: 'SUCCESS' | 'FAILED' | 'RECEIVED';
  readonly executeTimeMs: number | null;
  readonly errorCode: string | null;
  readonly message: string | null;
  readonly ackAt: string;
  /** ack 消息 meta.id（追溯链）。 */
  readonly sourceMessageId: string | null;
}

export interface CommandDetailView extends Omit<CommandListItemView, never> {
  readonly remarks: string | null;
  readonly confirmedBy: string | null;
  readonly attempts: readonly CommandAttemptView[];
  readonly acks: readonly CommandAckView[];
}

// ---------- 活动日志（BE-DEV-05） ----------

export type ActivityLevel = 'INFO' | 'WARNING' | 'MAJOR' | 'CRITICAL';
export type ActivityKind = 'EVENT' | 'ALARM';

export interface ActivityItemView {
  readonly activityId: string;
  readonly kind: ActivityKind;
  readonly level: ActivityLevel;
  readonly occurredAt: string;
  /** EVENT=eventType；ALARM=告警 code。 */
  readonly summary: string;
  readonly detail: Record<string, unknown>;
}

export interface ActivityExportView {
  readonly exportId: string;
  readonly deviceId: string;
  readonly status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  readonly filters: Record<string, unknown>;
  readonly rowCount: number | null;
  readonly downloadUrl: string | null;
  readonly urlExpiresAt: string | null;
  readonly urlExpired: boolean;
  readonly error: string | null;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}
