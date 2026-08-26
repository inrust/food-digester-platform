/**
 * DEC-010 原型设备状态映射策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/domain/device-status-axes-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-010@0.2.0（status=pending，本策略为暂定实现，冻结后整体替换）。
 *
 * 消费方：DB-01、DOM-01、DOM-03、BE-DEV-01、BE-DEV-05、FE-03、FE-06。
 * 约束：四轴分离与派生原则可直接执行；"启用"的具体派生规则（enabledDisplay.rule）
 * 是 DEC-010 待冻结内容，读取时失败关闭（抛 PolicyParameterPendingError）。
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
    /** DEC-010 待冻结参数；provisional 为 null。 */
    readonly rule: string | null;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-010 v0.2.0，pending）：
 * connectivity、lifecycle、operational、license 四轴分离；"启用"由明确业务规则派生。
 */
export const DEVICE_STATUS_AXES_POLICY: DeviceStatusAxesPolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  axes: {
    list: ['connectivity', 'lifecycle', 'operational', 'license'],
    singleFieldMixing: false,
    consumers: ['DB-01', 'DOM-01', 'DOM-03', 'BE-DEV-01', 'BE-DEV-05', 'FE-03', 'FE-06'],
    note: '设备状态按四轴独立建模与展示：connectivity（在线/离线）、lifecycle（注册/激活/停用等）、operational（运行/维护/待机）、license（授权状态）。禁止用单一字段混用表达（如原型的"是否启用/启用状态/在线/离线/维护/待机"合并列）。',
  },
  enabledDisplay: {
    derived: true,
    storedAsField: false,
    rule: null,
    consumers: ['BE-DEV-01', 'FE-03', 'FE-06'],
    note: '"启用"展示值必须由明确业务规则从四轴派生，不得作为独立字段存储。DEC-010 待冻结参数：rule（具体派生规则，如 lifecycle=ACTIVE 且 license 有效），当前 null；冻结前 API/页面不得输出 enabled 字段或"启用"文案。',
  },
  pendingParameters: ['enabledDisplay.rule'],
  frozenUpgradePath:
    'DEC-010 冻结时：按 decision-change-template 变更 DEC-010 至 >=1.0.0，填入 enabledDisplay.rule 的明确派生规则并提升 policyVersion、status 改 frozen；规则变更需同步 FE-03/FE-06 展示与 BE-DEV-01 查询契约。',
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

/** "启用"的具体派生规则。DEC-010 冻结前调用抛 PolicyParameterPendingError。 */
export function getEnabledDerivationRule(): string {
  const rule = DEVICE_STATUS_AXES_POLICY.enabledDisplay.rule;
  if (rule === null) throw new PolicyParameterPendingError('enabledDisplay.rule');
  return rule;
}

/** 冻结前是否允许输出 enabled 字段或"启用"文案：恒为 false（规则未冻结）。 */
export function isEnabledDisplayAvailable(): boolean {
  return DEVICE_STATUS_AXES_POLICY.enabledDisplay.rule !== null;
}

/** 策略当前状态：provisional 表示 DEC-010 未冻结。 */
export function getStatusAxesPolicyStatus(): StatusAxesPolicyStatus {
  return DEVICE_STATUS_AXES_POLICY.status;
}
