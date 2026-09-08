/**
 * FE-12 Remote Command 纯逻辑：CT-04 命令目录镜像、原型快捷动作映射、门控、文案、CT-06 锚点。
 *
 * - COMMAND_CATALOG 逐条镜像 contracts/mqtt/command-catalog.json（22 个，CT-04），
 *   parity 测试与目录 JSON 双向锁定；只允许目录内 command code 提交（无协议 code 禁止）；
 * - allowedStatuses 基于设备 Operational 状态轴；MAINTENANCE 按 DEC-001 视同 SUSPENDED；
 *   RETIRED 拒绝全部；离线/无 REMOTE_CONTROL Entitlement 一并禁用（与后端限制一致，
 *   后端 DEVICE_STATE_NOT_ALLOWED/FORBIDDEN 兜底）；
 * - M/N（搅拌间隔/时长）与温度阈值不走命令 API：跳转 Configuration 版本发布（FE-09）；
 * - 高风险命令：confirmText 必须与命令名完全一致，confirmedAt 由提交时刻生成（300s TTL）。
 */
import { hasPermission } from '@fdp/auth';
import type { Role } from '@fdp/auth';
import type { DeviceView } from '../devices/types.js';
import type { CommandCategory, CommandName, CommandStatus } from './types.js';

export interface CommandSpec {
  readonly command: CommandName;
  readonly category: CommandCategory;
  readonly highRisk: boolean;
  readonly allowedStatuses: readonly ('ACTIVE' | 'MAINTENANCE' | 'SUSPENDED' | 'RETIRED')[];
}

/** CT-04 命令目录镜像（22 个）；与 contracts/mqtt/command-catalog.json parity 锁定。 */
export const COMMAND_CATALOG: readonly CommandSpec[] = [
  { command: 'START', category: 'MACHINE', highRisk: false, allowedStatuses: ['ACTIVE'] },
  { command: 'STOP', category: 'MACHINE', highRisk: false, allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'] },
  { command: 'PAUSE', category: 'MACHINE', highRisk: false, allowedStatuses: ['ACTIVE'] },
  { command: 'RESUME', category: 'MACHINE', highRisk: false, allowedStatuses: ['ACTIVE'] },
  {
    command: 'EMERGENCY_STOP',
    category: 'MACHINE',
    highRisk: true,
    allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'],
  },
  { command: 'AGITATOR_FORWARD', category: 'MOTOR', highRisk: true, allowedStatuses: ['ACTIVE'] },
  { command: 'AGITATOR_REVERSE', category: 'MOTOR', highRisk: true, allowedStatuses: ['ACTIVE'] },
  {
    command: 'AGITATOR_STOP',
    category: 'MOTOR',
    highRisk: true,
    allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'],
  },
  { command: 'HEATING_ON', category: 'HEATING', highRisk: true, allowedStatuses: ['ACTIVE'] },
  {
    command: 'HEATING_OFF',
    category: 'HEATING',
    highRisk: true,
    allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'],
  },
  { command: 'SET_TARGET_TEMPERATURE', category: 'HEATING', highRisk: true, allowedStatuses: ['ACTIVE'] },
  { command: 'EXHAUST_ON', category: 'VENTILATION', highRisk: false, allowedStatuses: ['ACTIVE'] },
  {
    command: 'EXHAUST_OFF',
    category: 'VENTILATION',
    highRisk: false,
    allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'],
  },
  { command: 'AIR_SUPPLY_ON', category: 'VENTILATION', highRisk: false, allowedStatuses: ['ACTIVE'] },
  {
    command: 'AIR_SUPPLY_OFF',
    category: 'VENTILATION',
    highRisk: false,
    allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'],
  },
  { command: 'DISCHARGE_START', category: 'DISCHARGE', highRisk: true, allowedStatuses: ['ACTIVE'] },
  {
    command: 'DISCHARGE_STOP',
    category: 'DISCHARGE',
    highRisk: true,
    allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'],
  },
  { command: 'REBOOT', category: 'DEVICE', highRisk: false, allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'] },
  { command: 'SHUTDOWN', category: 'DEVICE', highRisk: true, allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'] },
  { command: 'FACTORY_RESET', category: 'DEVICE', highRisk: true, allowedStatuses: ['ACTIVE'] },
  {
    command: 'TAKE_SNAPSHOT',
    category: 'DEVICE',
    highRisk: false,
    allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'],
  },
  {
    command: 'FORCE_SYNC',
    category: 'DEVICE',
    highRisk: false,
    allowedStatuses: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED'],
  },
];

/** 命令中文名（文案可追溯到 command code：展示为“中文名（CODE）”）。 */
export const COMMAND_LABELS: Readonly<Record<CommandName, string>> = {
  START: '启动',
  STOP: '停止',
  PAUSE: '暂停',
  RESUME: '恢复运行',
  EMERGENCY_STOP: '紧急停止',
  AGITATOR_FORWARD: '搅拌器前向旋转',
  AGITATOR_REVERSE: '搅拌器后向旋转',
  AGITATOR_STOP: '搅拌器停止',
  HEATING_ON: '加热开启',
  HEATING_OFF: '加热关闭',
  SET_TARGET_TEMPERATURE: '设置目标温度',
  EXHAUST_ON: '排气开启',
  EXHAUST_OFF: '排气关闭',
  AIR_SUPPLY_ON: '送风开启',
  AIR_SUPPLY_OFF: '送风关闭',
  DISCHARGE_START: '排料开始',
  DISCHARGE_STOP: '排料停止',
  REBOOT: '重启',
  SHUTDOWN: '关机',
  FACTORY_RESET: '恢复出厂设置',
  TAKE_SNAPSHOT: '抓取快照',
  FORCE_SYNC: '强制同步',
};

/** 原型 8 个快捷动作 → CT-04 正式命令映射（文案可追溯到 command code）。 */
export interface QuickActionSpec {
  readonly key: string;
  readonly label: string;
  /** 直接映射的命令；模式切换/加热/排气为可选组（表单内选择组内具体命令）。 */
  readonly command?: CommandName;
  /** 可选命令组（模式切换 = MACHINE 类，由操作者在表单选择具体命令；不提交组名本身）。 */
  readonly commandGroup?: readonly CommandName[];
}

export const QUICK_ACTIONS: readonly QuickActionSpec[] = [
  { key: 'agitatorForward', label: '搅拌器前向旋转', command: 'AGITATOR_FORWARD' },
  { key: 'agitatorReverse', label: '搅拌器后向旋转', command: 'AGITATOR_REVERSE' },
  { key: 'heating', label: '加热', commandGroup: ['HEATING_ON', 'HEATING_OFF'] },
  { key: 'exhaust', label: '排气', commandGroup: ['EXHAUST_ON', 'EXHAUST_OFF'] },
  { key: 'reboot', label: '重启', command: 'REBOOT' },
  { key: 'shutdown', label: '关机', command: 'SHUTDOWN' },
  { key: 'modeSwitch', label: '模式切换', commandGroup: ['START', 'STOP', 'PAUSE', 'RESUME', 'EMERGENCY_STOP'] },
  { key: 'factoryReset', label: '恢复出厂设置', command: 'FACTORY_RESET' },
];

/** M/N（搅拌间隔/时长）与温度阈值走 Configuration 版本发布，不走命令 API。 */
export const CONFIG_REDIRECTS = [
  {
    key: 'updateStrategy',
    label: '更新策略（旋转间隔 M/时长 N）',
    hint: '经 Configuration 版本发布（/configurations），不产生设备命令',
  },
  {
    key: 'updateThreshold',
    label: '更新阈值（温度阈值）',
    hint: '经 Configuration 版本发布（/configurations），不产生设备命令',
  },
] as const;

// ---------- 门控 ----------

export interface CommandGate {
  readonly allowed: boolean;
  readonly reason: string | null;
}

export function commandSpecOf(command: CommandName): CommandSpec {
  const spec = COMMAND_CATALOG.find((c) => c.command === command);
  if (spec === undefined) throw new Error(`未知命令（无协议 command code）：${command as string}`);
  return spec;
}

/**
 * 命令可用性 = command:send ∩ Operational 状态轴（CT-04 allowedStatuses；MAINTENANCE 视同
 * SUSPENDED 由 catalog 自身表达）∩ 在线 ∩ REMOTE_CONTROL Entitlement。后端仍最终裁决。
 */
export function gateCommand(command: CommandName, device: DeviceView | null, role: Role): CommandGate {
  if (!hasPermission(role, 'command:send')) {
    return { allowed: false, reason: '需要命令下发权限（command:send）' };
  }
  if (device === null) {
    return { allowed: false, reason: '请先选择设备' };
  }
  if (device.lifecycleStatus === 'Retired') {
    return { allowed: false, reason: '设备已退役，拒绝全部命令' };
  }
  const operational = device.operationalStatus?.toUpperCase() ?? null;
  if (operational === null) {
    return { allowed: false, reason: '设备运行状态未知，禁止下发' };
  }
  const spec = commandSpecOf(command);
  if (!(spec.allowedStatuses as readonly string[]).includes(operational)) {
    return { allowed: false, reason: `当前运行状态（${device.operationalStatus}）不允许该命令` };
  }
  if (device.connectivity === 'OFFLINE') {
    return { allowed: false, reason: '设备离线，禁止下发' };
  }
  if (!(device.license?.entitlements ?? []).includes('REMOTE_CONTROL')) {
    return { allowed: false, reason: '无远程控制授权（REMOTE_CONTROL Entitlement）' };
  }
  return { allowed: true, reason: null };
}

/** timeoutSec 校验（契约 1..3600）。 */
export function validateTimeoutSec(raw: string): string | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3600) return '超时时间须为 1~3600 秒整数';
  return null;
}

export const COMMAND_STATUS_LABELS: Readonly<Record<CommandStatus, string>> = {
  CREATED: '已创建',
  AUTHORIZED: '已授权',
  PUBLISHING: '发布中',
  PUBLISHED: '已下发',
  ACKNOWLEDGED: '设备已确认',
  SUCCEEDED: '执行成功',
  FAILED: '执行失败',
  TIMED_OUT: '已超时',
  CANCELLED: '已取消',
};

export const COMMAND_STATUS_OPTIONS = Object.keys(COMMAND_STATUS_LABELS) as CommandStatus[];

export const ACK_RESULT_LABELS: Readonly<Record<string, string>> = {
  SUCCESS: '成功',
  FAILED: '失败',
  RECEIVED: '已收到（无执行结果）',
};

export const ACTIVITY_LEVEL_OPTIONS = ['INFO', 'WARNING', 'MAJOR', 'CRITICAL'] as const;
export const ACTIVITY_LEVEL_LABELS: Readonly<Record<string, string>> = {
  INFO: '提示',
  WARNING: '警告',
  MAJOR: '重要',
  CRITICAL: '严重',
};
export const ACTIVITY_KIND_LABELS: Readonly<Record<string, string>> = {
  EVENT: '事件',
  ALARM: '告警',
};

/** 迟到 ACK：命令已 TIMED_OUT/CANCELLED 后仍收到的 ACK。 */
export function isLateAck(status: CommandStatus, acks: readonly { readonly ackAt: string }[]): boolean {
  return (status === 'TIMED_OUT' || status === 'CANCELLED') && acks.length > 0;
}

// ---------- CT-06 锚点（device-operate 页 Adopt/Adapt 元素；camPlay/camStop 为 Reject 不入表） ----------

export const DEVICE_OPERATE_COVERAGE: Readonly<Record<string, string>> = {
  'device-operate.button.agitatorForward': 'quick-agitatorForward',
  'device-operate.button.agitatorReverse': 'quick-agitatorReverse',
  'device-operate.button.heating': 'quick-heating',
  'device-operate.button.exhaust': 'quick-exhaust',
  'device-operate.button.reboot': 'quick-reboot',
  'device-operate.button.shutdown': 'quick-shutdown',
  'device-operate.button.modeSwitch': 'quick-modeSwitch',
  'device-operate.button.factoryReset': 'quick-factoryReset',
  'device-operate.button.updateStrategy': 'goto-config-strategy',
  'device-operate.button.updateThreshold': 'goto-config-threshold',
  'device-operate.button.saveAlias': 'alias-edit',
  'device-operate.table.activityLog': 'activity-table',
  'device-operate.button.logFilter': 'activity-filter-search',
  'device-operate.button.logExport': 'activity-export',
};
