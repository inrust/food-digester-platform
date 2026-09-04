/**
 * DEC-010 原型设备状态映射策略（冻结策略）。
 *
 * 事实源：contracts/domain/device-status-axes-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-010@1.0.0（status=frozen，本策略为冻结实现）。
 *
 * 消费方：DB-01、DOM-01、DOM-03、BE-DEV-01、BE-DEV-05、FE-03、FE-06。
 * DEC-010@1.0.0 已冻结四轴分离和 "启用" 派生规则。
 */

import { PolicyParameterPendingError } from '../security/certificate-package-policy.ts';

export type StatusAxesPolicyStatus = 'provisional' | 'frozen';

export type DeviceStatusAxis = 'connectivity' | 'lifecycle' | 'operational' | 'license';

export interface DeviceStatusAxesPolicy {
  readonly policyVersion: string;
  readonly status: StatusAxesPolicyStatus;
  readonly axes: {
    readonly list: readonly DeviceStatusAxis[];
    /** 禁止单一字段混用多维状态，锁定为 false。 */
    readonly singleFieldMixing: false;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly enabledDisplay: {
    /** "启用"必须由业务规则派生，锁定为 true。 */
    readonly derived: true;
    /** "启用"不得作为独立存储字段，锁定为 false。 */
    readonly storedAsField: false;
    /** 冻结的启用派生规则；类型保留 null 供未来 provisional 版本失败关闭。 */
    readonly rule: string | null;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * DEC-010@1.0.0 冻结值。
 */
export const DEVICE_STATUS_AXES_POLICY: DeviceStatusAxesPolicy = {
  policyVersion: '1.0.0',
  status: 'frozen',
  axes: {
    list: ['connectivity', 'lifecycle', 'operational', 'license'],
    singleFieldMixing: false,
    consumers: ['DB-01', 'DOM-01', 'DOM-03', 'BE-DEV-01', 'BE-DEV-05', 'FE-03', 'FE-06'],
    note: '设备状态按四轴独立建模与展示：connectivity（在线/离线）、lifecycle（注册/激活/停用等）、operational（运行/维护/待机）、license（授权状态）。禁止用单一字段混用表达（如原型的"是否启用/启用状态/在线/离线/维护/待机"合并列）。',
  },
  enabledDisplay: {
    derived: true,
    storedAsField: false,
    rule: 'lifecycle=Active AND license IN (Active, ExpiringSoon, Renewed)',
    consumers: ['BE-DEV-01', 'FE-03', 'FE-06'],
    note: '启用仅在 lifecycle=Active 且存在有效 License（Active、ExpiringSoon 或 Renewed）时为 true；connectivity 与 operational 不影响启用值。该值只派生展示，不落库。',
  },
  pendingParameters: [],
  frozenUpgradePath: '派生规则或状态轴变化必须提升 DEC-010 与 policyVersion，并同步 BE-DEV-01、FE-03、FE-06。',
} as const;

/** 设备状态轴封闭集合（四轴）。 */
export function getDeviceStatusAxes(): readonly DeviceStatusAxis[] {
  return DEVICE_STATUS_AXES_POLICY.axes.list;
}

/** 是否为合法状态轴。未知轴返回 false（失败关闭）。 */
export function isKnownStatusAxis(axis: string): axis is DeviceStatusAxis {
  return (DEVICE_STATUS_AXES_POLICY.axes.list as readonly string[]).includes(axis);
}

/** 是否禁止单一字段混用多维状态：恒为 true（锁定规则）。 */
export function isSingleFieldStatusMixingForbidden(): boolean {
  return !DEVICE_STATUS_AXES_POLICY.axes.singleFieldMixing;
}

/** "启用"是否必须由业务规则派生：恒为 true（锁定规则）。 */
export function isEnabledDisplayDerived(): boolean {
  return DEVICE_STATUS_AXES_POLICY.enabledDisplay.derived;
}

/** "启用"是否可作为独立存储字段：恒为 false（锁定规则）。 */
export function isEnabledStoredAsField(): boolean {
  return DEVICE_STATUS_AXES_POLICY.enabledDisplay.storedAsField;
}

/** "启用"的具体派生规则；参数缺失时失败关闭。 */
export function getEnabledDerivationRule(): string {
  const rule = DEVICE_STATUS_AXES_POLICY.enabledDisplay.rule;
  if (rule === null) throw new PolicyParameterPendingError('enabledDisplay.rule');
  return rule;
}

/** 冻结规则齐备时允许输出派生的 enabled 字段或"启用"文案。 */
export function isEnabledDisplayAvailable(): boolean {
  return DEVICE_STATUS_AXES_POLICY.enabledDisplay.rule !== null;
}

/** 策略当前状态：frozen 表示 DEC-010 已冻结。 */
export function getStatusAxesPolicyStatus(): StatusAxesPolicyStatus {
  return DEVICE_STATUS_AXES_POLICY.status;
}
