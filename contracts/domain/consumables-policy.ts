/**
 * DEC-008 耗材正式名称、数据来源与阈值策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/domain/consumables-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-008@0.2.0（status=pending，本策略为暂定实现，冻结后整体替换）。
 *
 * 消费方：DB-01（Schema 基线）、BE-IOT-05（耗材上报接入）、BE-CNS-01（耗材查询）、FE-18（耗材展示）。
 * 约束：类型代码与数据来源规则可直接执行；正式名称与展示阈值是 DEC-008
 * 待冻结内容，读取时失败关闭（抛 PolicyParameterPendingError）。
 */

import { PolicyParameterPendingError } from '../security/certificate-package-policy.ts';

export type ConsumablesPolicyStatus = 'provisional' | 'frozen';

export type ConsumableTypeCode = 'CARBON_FILTER' | 'BIO_ADDITIVE';

export class UnknownConsumableTypeError extends Error {
  readonly typeCode: string;

  constructor(typeCode: string) {
    super(`UNKNOWN_CONSUMABLE_TYPE: ${typeCode}（不在 DEC-008 类型代码封闭集合内）`);
    this.name = 'UnknownConsumableTypeError';
    this.typeCode = typeCode;
  }
}

export interface ConsumablesPolicy {
  readonly policyVersion: string;
  readonly status: ConsumablesPolicyStatus;
  readonly types: {
    readonly codes: readonly ConsumableTypeCode[];
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly dataSource: {
    readonly mode: 'device-reported-only';
    /** 禁止云端臆测百分比，锁定为 false。 */
    readonly cloudDerivedPercentage: false;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly display: {
    /** DEC-008 待冻结参数；provisional 为 null。 */
    readonly names: Readonly<Record<ConsumableTypeCode, string | null>>;
    readonly thresholds: Readonly<Record<ConsumableTypeCode, number | null>>;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-008 v0.2.0，pending）：
 * 暂用 CARBON_FILTER、BIO_ADDITIVE；仅保存设备已定义上报值，不由云端臆测百分比。
 */
export const CONSUMABLES_POLICY: ConsumablesPolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  types: {
    codes: ['CARBON_FILTER', 'BIO_ADDITIVE'],
    consumers: ['DB-01', 'BE-IOT-05', 'BE-CNS-01', 'FE-18'],
    note: '暂定耗材类型代码（封闭集合）。新增类型必须先走 DEC-008 冻结或版本升级，禁止代码中硬编码其他耗材类型。',
  },
  dataSource: {
    mode: 'device-reported-only',
    cloudDerivedPercentage: false,
    consumers: ['BE-IOT-05', 'BE-CNS-01', 'DB-01'],
    note: '仅保存设备已定义上报值（原始值原样入库）；云端不得由上报值推算/臆测剩余百分比或寿命。设备未上报的维度在 API 与 UI 中显示为未知，不得填充估算值。',
  },
  display: {
    names: { CARBON_FILTER: null, BIO_ADDITIVE: null },
    thresholds: { CARBON_FILTER: null, BIO_ADDITIVE: null },
    consumers: ['FE-18', 'BE-CNS-01'],
    note: 'DEC-008 待冻结参数：正式展示名称与展示/告警阈值。当前均为 null；FE-18 冻结前显示类型代码原文并标注待定，不得使用原型名称（碳包/活性菌等）。',
  },
  pendingParameters: ['display.names.CARBON_FILTER', 'display.names.BIO_ADDITIVE', 'display.thresholds.CARBON_FILTER', 'display.thresholds.BIO_ADDITIVE'],
  frozenUpgradePath:
    'DEC-008 冻结时：按 decision-change-template 变更 DEC-008 至 >=1.0.0，填入正式名称与阈值并提升 policyVersion、status 改 frozen；若类型代码变更需同步 DB 枚举与 BE-IOT-05 校验。',
} as const;

/** 耗材类型代码封闭集合。 */
export function getConsumableTypeCodes(): readonly ConsumableTypeCode[] {
  return CONSUMABLES_POLICY.types.codes;
}

/** 是否为已知耗材类型。未知类型返回 false（失败关闭）。 */
export function isKnownConsumableType(typeCode: string): typeCode is ConsumableTypeCode {
  return (CONSUMABLES_POLICY.types.codes as readonly string[]).includes(typeCode);
}

function requireKnownType(typeCode: string): ConsumableTypeCode {
  if (!isKnownConsumableType(typeCode)) throw new UnknownConsumableTypeError(typeCode);
  return typeCode;
}

/** 数据来源：恒为 device-reported-only（锁定规则）。 */
export function getConsumableDataSource(): 'device-reported-only' {
  return CONSUMABLES_POLICY.dataSource.mode;
}

/** 云端是否允许推算耗材百分比：恒为 false（锁定规则）。 */
export function isCloudPercentageDerivationAllowed(): boolean {
  return CONSUMABLES_POLICY.dataSource.cloudDerivedPercentage;
}

/** 正式展示名称。未知类型抛 UnknownConsumableTypeError；DEC-008 冻结前抛 PolicyParameterPendingError。 */
export function getConsumableDisplayName(typeCode: string): string {
  const code = requireKnownType(typeCode);
  const name = CONSUMABLES_POLICY.display.names[code];
  if (name === null) throw new PolicyParameterPendingError(`display.names.${code}`);
  return name;
}

/** 展示/告警阈值。未知类型抛 UnknownConsumableTypeError；DEC-008 冻结前抛 PolicyParameterPendingError。 */
export function getConsumableThreshold(typeCode: string): number {
  const code = requireKnownType(typeCode);
  const threshold = CONSUMABLES_POLICY.display.thresholds[code];
  if (threshold === null) throw new PolicyParameterPendingError(`display.thresholds.${code}`);
  return threshold;
}

/** 策略当前状态：provisional 表示 DEC-008 未冻结。 */
export function getConsumablesPolicyStatus(): ConsumablesPolicyStatus {
  return CONSUMABLES_POLICY.status;
}
