import { translate } from '../../i18n/i18n.js';
/**
 * FE-12 Remote Command 纯逻辑：CT-04 命令目录镜像、原型快捷动作映射、门控、文案、CT-06 锚点。
 *
 * - COMMAND_CATALOG 逐条镜像 contracts/mqtt/command-catalog.json（22 个，CT-04），
 *   parity 测试与目录 JSON 双向锁定；只允许目录内 command code 提交（无协议 code 禁止）；
 * - allowedStatuses 基于设备 Operational 状态轴；MAINTENANCE 按 DEC-001 视同 SUSPENDED；
 *   RETIRED 拒绝全部；离线/无 REMOTE_CONTROL Entitlement 一并禁用（与后端限制一致，
 *   后端 DEVICE_STATE_NOT_ALLOWED/FORBIDDEN 兜底）；
 * - DEC-018 排除 M/N（搅拌间隔/时长）；温度阈值不走命令 API，跳转 Configuration（FE-09）；
 * - DEC-023 高风险命令：confirmText 必须与命令名完全一致；服务端另验 JWT auth_time 的近期重新认证。
 */
import { hasPermission } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
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
/** 温度阈值由 Configuration 版本发布；保留协议目录项，但禁止管理后台命令表单提交。 */
export const SUBMITTABLE_COMMAND_CATALOG = COMMAND_CATALOG.filter((spec) => spec.command !== 'SET_TARGET_TEMPERATURE');
export function isSubmittableCommand(command: CommandName): boolean {
  return command !== 'SET_TARGET_TEMPERATURE';
}
/** 命令中文名（文案可追溯到 command code：展示为“中文名（CODE）”）。 */
export const COMMAND_LABELS: Readonly<Record<CommandName, string>> = {
  get START() {
    return translate('ui.ebd26da42171');
  },
  get STOP() {
    return translate('ui.a17f70a8d3d6');
  },
  get PAUSE() {
    return translate('ui.130448bce675');
  },
  get RESUME() {
    return translate('ui.67be57f398c6');
  },
  get EMERGENCY_STOP() {
    return translate('ui.6ec0e33e8353');
  },
  get AGITATOR_FORWARD() {
    return translate('ui.a791153d7099');
  },
  get AGITATOR_REVERSE() {
    return translate('ui.302db26add86');
  },
  get AGITATOR_STOP() {
    return translate('ui.798423336475');
  },
  get HEATING_ON() {
    return translate('ui.82f46c784997');
  },
  get HEATING_OFF() {
    return translate('ui.b726e412a1ac');
  },
  get SET_TARGET_TEMPERATURE() {
    return translate('ui.d874f7e0b1c2');
  },
  get EXHAUST_ON() {
    return translate('ui.681915a148c7');
  },
  get EXHAUST_OFF() {
    return translate('ui.83a69d28a0bb');
  },
  get AIR_SUPPLY_ON() {
    return translate('ui.3c0604e30961');
  },
  get AIR_SUPPLY_OFF() {
    return translate('ui.98012a55b28a');
  },
  get DISCHARGE_START() {
    return translate('ui.7d693441fff7');
  },
  get DISCHARGE_STOP() {
    return translate('ui.e406d173c4b6');
  },
  get REBOOT() {
    return translate('ui.385c272e35c6');
  },
  get SHUTDOWN() {
    return translate('ui.f96455d5274f');
  },
  get FACTORY_RESET() {
    return translate('ui.b9c9edf399fe');
  },
  get TAKE_SNAPSHOT() {
    return translate('ui.b2ca7defb780');
  },
  get FORCE_SYNC() {
    return translate('ui.7cd5f9c88f36');
  },
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
  {
    key: 'agitatorForward',
    get label() {
      return translate('ui.a791153d7099');
    },
    command: 'AGITATOR_FORWARD',
  },
  {
    key: 'agitatorReverse',
    get label() {
      return translate('ui.302db26add86');
    },
    command: 'AGITATOR_REVERSE',
  },
  {
    key: 'heating',
    get label() {
      return translate('ui.6c1dd3e618c9');
    },
    commandGroup: ['HEATING_ON', 'HEATING_OFF'],
  },
  {
    key: 'exhaust',
    get label() {
      return translate('ui.d7d729612964');
    },
    commandGroup: ['EXHAUST_ON', 'EXHAUST_OFF'],
  },
  {
    key: 'reboot',
    get label() {
      return translate('ui.385c272e35c6');
    },
    command: 'REBOOT',
  },
  {
    key: 'shutdown',
    get label() {
      return translate('ui.f96455d5274f');
    },
    command: 'SHUTDOWN',
  },
  {
    key: 'modeSwitch',
    get label() {
      return translate('ui.6e5969dc8312');
    },
    commandGroup: ['START', 'STOP', 'PAUSE', 'RESUME', 'EMERGENCY_STOP'],
  },
  {
    key: 'factoryReset',
    get label() {
      return translate('ui.b9c9edf399fe');
    },
    command: 'FACTORY_RESET',
  },
];
/** DEC-018 V1 仅允许温度阈值从本页跳转 Configuration；被排除的 M/N 不渲染入口。 */
export const CONFIG_REDIRECTS = [
  {
    key: 'updateThreshold',
    get label() {
      return translate('ui.09929e0c32c8');
    },
    get hint() {
      return translate('ui.c50ecad143c0');
    },
  },
] as const;
// ---------- 门控 ----------
export interface CommandGate {
  readonly allowed: boolean;
  readonly reason: string | null;
}
export function commandSpecOf(command: CommandName): CommandSpec {
  const spec = COMMAND_CATALOG.find((c) => c.command === command);
  if (spec === undefined) throw new Error(translate('ui.881a0b59fcf5') + (command as string));
  return spec;
}
/**
 * 命令可用性 = command:send ∩ Operational 状态轴（CT-04 allowedStatuses；MAINTENANCE 视同
 * SUSPENDED 由 catalog 自身表达）∩ 在线 ∩ REMOTE_CONTROL Entitlement。后端仍最终裁决。
 */
export function gateCommand(command: CommandName, device: DeviceView | null, role: Role): CommandGate {
  if (!hasPermission(role, 'command:send')) {
    return { allowed: false, reason: translate('ui.15c2ea45c817') };
  }
  if (device === null) {
    return { allowed: false, reason: translate('ui.7b372e6a09a3') };
  }
  if (device.lifecycleStatus === 'Retired') {
    return { allowed: false, reason: translate('ui.08a65f6c7ff2') };
  }
  const operational = device.operationalStatus?.toUpperCase() ?? null;
  if (operational === null) {
    return { allowed: false, reason: translate('ui.2cef9665f8db') };
  }
  const spec = commandSpecOf(command);
  if (!(spec.allowedStatuses as readonly string[]).includes(operational)) {
    return {
      allowed: false,
      reason: translate('ui.0187d9f37dc4') + device.operationalStatus + translate('ui.38a1f3f1b2d4'),
    };
  }
  if (device.connectivity === 'OFFLINE') {
    return { allowed: false, reason: translate('ui.142e91d054f0') };
  }
  if (!(device.license?.entitlements ?? []).includes('REMOTE_CONTROL')) {
    return { allowed: false, reason: translate('ui.80747f87e39d') };
  }
  return { allowed: true, reason: null };
}
/** timeoutSec 校验（契约 1..3600）。 */
export function validateTimeoutSec(raw: string): string | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3600) return translate('ui.2eb284c530b8');
  return null;
}
export const COMMAND_STATUS_LABELS: Readonly<Record<CommandStatus, string>> = {
  get CREATED() {
    return translate('ui.62cfc53516b6');
  },
  get AUTHORIZED() {
    return translate('ui.284cc0bae14b');
  },
  get PUBLISHING() {
    return translate('ui.7e4da0f6e774');
  },
  get PUBLISH_FAILED() {
    return translate('page.7e7f5d44c467');
  },
  get PUBLISHED() {
    return translate('ui.f96ee524b7dd');
  },
  get ACKNOWLEDGED() {
    return translate('ui.ec8d53e36298');
  },
  get SUCCEEDED() {
    return translate('ui.6c189aad4dfe');
  },
  get FAILED() {
    return translate('ui.9746cfc7d257');
  },
  get TIMED_OUT() {
    return translate('ui.411ebfdad774');
  },
  get CANCELLED() {
    return translate('page.a5ffdc95eeb0');
  },
};
export const COMMAND_STATUS_OPTIONS = Object.keys(COMMAND_STATUS_LABELS) as CommandStatus[];
export const ACK_RESULT_LABELS: Readonly<Record<string, string>> = {
  get SUCCESS() {
    return translate('page.51991a5d111a');
  },
  get FAILED() {
    return translate('ui.3e3c8068bb0e');
  },
  get RECEIVED() {
    return translate('ui.10eccdc35e10');
  },
};
export const ACTIVITY_LEVEL_OPTIONS = ['INFO', 'WARNING', 'MAJOR', 'CRITICAL'] as const;
export const ACTIVITY_LEVEL_LABELS: Readonly<Record<string, string>> = {
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
export const ACTIVITY_KIND_LABELS: Readonly<Record<string, string>> = {
  get EVENT() {
    return translate('page.550e3280629d');
  },
  get ALARM() {
    return translate('page.5078424f7e0e');
  },
};
/** 迟到 ACK：命令已 TIMED_OUT/CANCELLED 后仍收到的 ACK。 */
export function isLateAck(
  status: CommandStatus,
  acks: readonly {
    readonly ackAt: string;
  }[],
): boolean {
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
  'device-operate.button.updateThreshold': 'goto-config-threshold',
  'device-operate.button.saveAlias': 'alias-edit',
  'device-operate.table.activityLog': 'activity-table',
  'device-operate.button.logFilter': 'activity-filter-search',
  'device-operate.button.logExport': 'activity-export',
};
