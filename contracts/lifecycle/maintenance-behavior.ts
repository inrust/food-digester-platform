/**
 * DEC-001 Maintenance 行为矩阵（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/lifecycle/maintenance-behavior-matrix.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-001@0.2.0（status=pending，本矩阵为暂定实现，冻结后整体替换）。
 *
 * 消费方：DOM-01、BE-SYNC-01、BE-DEV-04、BE-CMD-01、BE-CMD-02。
 * 约束：消费方只能经本模块查询矩阵，禁止直接读取 JSON 字段或复制暂定值；
 * 未列出的行为一律失败关闭（fallbackPolicy=deny）。
 */

import { isCommandAllowed, commandDenyReason } from '../mqtt/catalogs.ts';

export type MatrixStatus = 'provisional' | 'frozen';

export type MaintenanceBehavior =
  | 'SYNC'
  | 'MAINTENANCE_COMMANDS'
  | 'PROCESSING_COMMANDS'
  | 'TELEMETRY_INGESTION'
  | 'ALARM_EVENT_TAMPER_PROCESSING'
  | 'OTA'
  | 'RETIREMENT';

export interface BehaviorSpec {
  readonly allowed: boolean;
  /** 仅 SYNC 行为：Maintenance 下设备 Sync 节奏（秒）。 */
  readonly syncIntervalSeconds?: number;
  /** 消费该行为条目的任务 ID。 */
  readonly consumers: readonly string[];
  readonly note: string;
}

export interface MaintenanceBehaviorMatrix {
  readonly matrixVersion: string;
  readonly status: MatrixStatus;
  readonly fallbackPolicy: 'deny';
  readonly commandPolicy: {
    readonly mode: 'same-as-suspended' | 'explicit';
    readonly reference: string;
    readonly note: string;
  };
  readonly behaviors: Readonly<Record<MaintenanceBehavior, BehaviorSpec>>;
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-001 v0.2.0，pending）：
 * MAINTENANCE 为独立 Operational 状态；行为限制暂按 Suspended，
 * 但允许维护、同步、遥测、告警和 OTA。
 */
export const MAINTENANCE_BEHAVIOR_MATRIX: MaintenanceBehaviorMatrix = {
  matrixVersion: '0.1.0',
  status: 'provisional',
  fallbackPolicy: 'deny',
  commandPolicy: {
    mode: 'same-as-suspended',
    reference: 'contracts/mqtt/command-catalog.json',
    note: '命令允许集合与 Suspended 一致：仅安全停止、诊断、同步、必要维护和恢复类命令；START/RESUME/加热/搅拌/排料等启动处理类命令拒绝。唯一事实源为 command-catalog.json 的 allowedStatuses，本矩阵不重复列举命令。',
  },
  behaviors: {
    SYNC: {
      allowed: true,
      syncIntervalSeconds: 900,
      consumers: ['BE-SYNC-01'],
      note: '允许 Unified Device Sync；节奏按 Suspended 的 15 分钟（Active 为 5 分钟）；重连和 Notification 后立即调用的契约不变。',
    },
    MAINTENANCE_COMMANDS: {
      allowed: true,
      consumers: ['BE-CMD-01', 'BE-CMD-02', 'DOM-01'],
      note: '允许维护、诊断、安全停止、同步和恢复类命令；具体白名单按 commandPolicy 引用 command-catalog.json 判定。',
    },
    PROCESSING_COMMANDS: {
      allowed: false,
      consumers: ['BE-CMD-01', 'BE-CMD-02'],
      note: '启动处理类命令（START/RESUME/PAUSE/搅拌/加热/排气开启/排料开始/FACTORY_RESET）拒绝，与 Suspended 一致。',
    },
    TELEMETRY_INGESTION: {
      allowed: true,
      consumers: ['DOM-01'],
      note: '遥测上行链路保持接收、校验、幂等与归档；最新状态投影继续更新，不因 Maintenance 静默丢弃。',
    },
    ALARM_EVENT_TAMPER_PROCESSING: {
      allowed: true,
      consumers: ['DOM-01'],
      note: 'Alarm/Event/Tamper 上行处理保持；Tamper 触发的自动挂起策略不受 Maintenance 影响。',
    },
    OTA: {
      allowed: true,
      consumers: ['DOM-01', 'BE-CMD-01'],
      note: '允许 OTA 下发与状态接收（暂定值明确允许，区别于 Suspended 的处理启动限制）；仍需 OTA Entitlement 与 Campaign 目标校验。',
    },
    RETIREMENT: {
      allowed: true,
      consumers: ['BE-DEV-04'],
      note: 'Maintenance 不阻塞退役工作流；退役顺序（撤销授权→通知→设备确认→证书停用）不变。',
    },
  },
  frozenUpgradePath:
    'DEC-001 冻结时：按 decision-change-template 变更 DEC-001 至 >=1.0.0，整体替换本文件并提升 matrixVersion；消费方仅通过 maintenance-behavior.ts 访问，不直接读字段，确保暂定值可迁移。',
} as const;

export class MaintenanceMatrixError extends Error {
  readonly kind: 'UNKNOWN_BEHAVIOR';

  constructor(kind: MaintenanceMatrixError['kind'], value: string) {
    super(`${kind}: ${value}`);
    this.name = 'MaintenanceMatrixError';
    this.kind = kind;
  }
}

export function isKnownMaintenanceBehavior(value: string): value is MaintenanceBehavior {
  return Object.hasOwn(MAINTENANCE_BEHAVIOR_MATRIX.behaviors, value);
}

export function getMaintenanceBehavior(value: string): BehaviorSpec {
  if (!isKnownMaintenanceBehavior(value)) {
    throw new MaintenanceMatrixError('UNKNOWN_BEHAVIOR', value);
  }
  return MAINTENANCE_BEHAVIOR_MATRIX.behaviors[value];
}

/**
 * 行为在 Maintenance 状态下是否允许。未列出的行为返回 false（失败关闭）。
 */
export function isMaintenanceBehaviorAllowed(behavior: string): boolean {
  if (!isKnownMaintenanceBehavior(behavior)) return false;
  return MAINTENANCE_BEHAVIOR_MATRIX.behaviors[behavior].allowed;
}

/** Maintenance 下设备 Sync 节奏（秒）。BE-SYNC-01 使用。 */
export function getMaintenanceSyncIntervalSeconds(): number {
  const sync = MAINTENANCE_BEHAVIOR_MATRIX.behaviors.SYNC;
  if (sync.syncIntervalSeconds === undefined) {
    throw new MaintenanceMatrixError('UNKNOWN_BEHAVIOR', 'SYNC.syncIntervalSeconds');
  }
  return sync.syncIntervalSeconds;
}

/**
 * 命令在 Maintenance 状态下是否允许（BE-CMD-01/BE-CMD-02）。
 * 命令矩阵不复制到本模块，直接委托 command-catalog 的 MAINTENANCE 列。
 */
export function isMaintenanceCommandAllowed(command: string): boolean {
  if (!isMaintenanceBehaviorAllowed('MAINTENANCE_COMMANDS')) return false;
  return isCommandAllowed(command, 'MAINTENANCE');
}

/** 命令在 Maintenance 下被拒绝时的稳定原因码（供 API denyReason）。 */
export function maintenanceCommandDenyReason(command: string): string | null {
  if (isMaintenanceCommandAllowed(command)) return null;
  return commandDenyReason(command, 'MAINTENANCE');
}

/** 矩阵当前状态：provisional 表示 DEC-001 未冻结，消费方不得把值固化为不可迁移结构。 */
export function getMaintenanceMatrixStatus(): MatrixStatus {
  return MAINTENANCE_BEHAVIOR_MATRIX.status;
}
