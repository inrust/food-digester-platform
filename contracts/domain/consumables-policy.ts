/**
 * DEC-008 耗材正式名称、数据来源与阈值策略（冻结策略）。
 *
 * 事实源：contracts/domain/consumables-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-008@1.0.0（status=frozen，本策略为冻结实现）。
 *
 * 消费方：DB-01（Schema 基线）、BE-IOT-05（耗材上报接入）、BE-CNS-01（耗材查询）、FE-18（耗材展示）。
 * DEC-008@1.0.0 已冻结正式名称、低余量阈值和 24 小时数据过期规则。
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
    /** 冻结的正式名称与低余量阈值；类型保留 null 供未来 provisional 版本失败关闭。 */
    readonly names: Readonly<Record<ConsumableTypeCode, string | null>>;
    readonly thresholds: Readonly<Record<ConsumableTypeCode, number | null>>;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly freshness: {
    readonly staleAfterHours: number;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * DEC-008@1.0.0 冻结值。
 */
export const CONSUMABLES_POLICY: ConsumablesPolicy = {
  policyVersion: '1.0.0',
  status: 'frozen',
  types: {
    codes: ['CARBON_FILTER', 'BIO_ADDITIVE'],
    consumers: ['DB-01', 'BE-IOT-05', 'BE-CNS-01', 'FE-18'],
    note: '冻结的耗材类型代码封闭集合。新增类型必须提升 DEC-008 与策略版本，禁止代码中硬编码其他耗材类型。',
  },
  dataSource: {
    mode: 'device-reported-only',
    cloudDerivedPercentage: false,
    consumers: ['BE-IOT-05', 'BE-CNS-01', 'DB-01'],
    note: '仅保存设备已定义上报值（原始值原样入库）；云端不得由上报值推算/臆测剩余百分比或寿命。设备未上报的维度在 API 与 UI 中显示为未知，不得填充估算值。',
  },
  display: {
    names: { CARBON_FILTER: '碳滤网', BIO_ADDITIVE: '生物添加剂' },
    thresholds: { CARBON_FILTER: 20, BIO_ADDITIVE: 15 },
    consumers: ['FE-18', 'BE-CNS-01'],
    note: '正式名称与低余量阈值：碳滤网 20%，生物添加剂 15%。百分比必须来自设备上报，云端不推算。',
  },
  freshness: {
    staleAfterHours: 24,
    consumers: ['BE-CNS-01', 'FE-18'],
    note: 'observedAt 距查询时点超过 24 小时，或从未上报时，展示为数据过期/未知。',
  },
  pendingParameters: [],
  frozenUpgradePath:
    '名称、阈值、过期时间或类型代码变化必须提升 DEC-008 与 policyVersion，并同步 DB、接入校验、API 和前端。',
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

/** 正式展示名称。未知类型失败关闭；参数缺失时抛 PolicyParameterPendingError。 */
export function getConsumableDisplayName(typeCode: string): string {
  const code = requireKnownType(typeCode);
  const name = CONSUMABLES_POLICY.display.names[code];
  if (name === null) throw new PolicyParameterPendingError(`display.names.${code}`);
  return name;
}

/** 展示/告警阈值。未知类型失败关闭；参数缺失时抛 PolicyParameterPendingError。 */
export function getConsumableThreshold(typeCode: string): number {
  const code = requireKnownType(typeCode);
  const threshold = CONSUMABLES_POLICY.display.thresholds[code];
  if (threshold === null) throw new PolicyParameterPendingError(`display.thresholds.${code}`);
  return threshold;
}

/** 设备上报值在多少小时后标记为过期。 */
export function getConsumableStaleAfterHours(): number {
  return CONSUMABLES_POLICY.freshness.staleAfterHours;
}

/** 策略当前状态：frozen 表示 DEC-008 已冻结。 */
export function getConsumablesPolicyStatus(): ConsumablesPolicyStatus {
  return CONSUMABLES_POLICY.status;
}
