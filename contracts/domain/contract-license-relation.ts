/**
 * DEC-007 Contract 与 License 关系策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/domain/contract-license-relation.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-007@0.2.0（status=pending，全部为定性规则，已可直接执行）。
 *
 * 消费方：DB-01（Schema 基线）、BE-CON-01、BE-CON-02、BE-LIC-01、FE-17、DOM-03。
 */

export type RelationPolicyStatus = 'provisional' | 'frozen';

export type ContractScope = 'commercial-lease-term' | 'device-association';
export type LicenseScope = 'device-capability-authorization';

export interface ContractLicenseRelationPolicy {
  readonly policyVersion: string;
  readonly status: RelationPolicyStatus;
  readonly ownership: {
    readonly contractScope: readonly ContractScope[];
    readonly licenseScope: readonly LicenseScope[];
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly linkage: {
    /** 创建 Contract 不自动激活 License，锁定为 false。 */
    readonly contractCreateActivatesLicense: false;
    /** 解绑 Contract 不自动撤销 License，锁定为 false。 */
    readonly contractUnbindRevokesLicense: false;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly presentation: {
    /** Contract 状态独立展示，不等同 License 状态，锁定为 true。 */
    readonly contractStatusIndependentOfLicense: true;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-007 v0.2.0，pending）：
 * Contract 管商业租期和设备关联；License 管设备能力授权；创建 Contract 不自动激活 License。
 */
export const CONTRACT_LICENSE_RELATION: ContractLicenseRelationPolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  ownership: {
    contractScope: ['commercial-lease-term', 'device-association'],
    licenseScope: ['device-capability-authorization'],
    consumers: ['DB-01', 'BE-CON-01', 'BE-CON-02', 'BE-LIC-01', 'DOM-03'],
    note: 'Contract 只管商业租期（startAt/endAt）与设备关联；License 只管设备能力授权。两者为独立实体，各自持有独立状态机（DOM-03），任何一方不得把对方字段并入自身表结构。',
  },
  linkage: {
    contractCreateActivatesLicense: false,
    contractUnbindRevokesLicense: false,
    consumers: ['BE-CON-01', 'BE-CON-02', 'BE-LIC-01'],
    note: '创建 Contract 不自动激活 License（License 激活走独立显式动作）；续约走 renewContract；解绑不自动撤销 License（依据 prototype-traceability.yaml 已登记语义）。',
  },
  presentation: {
    contractStatusIndependentOfLicense: true,
    consumers: ['FE-17', 'BE-CON-02'],
    note: 'Contract 状态与 License 状态独立展示：合约列表状态列不得直接显示 License 状态；License 授权摘要在合约详情中独立字段展示（getDeviceLicense.summary）。',
  },
  pendingParameters: [],
  frozenUpgradePath:
    'DEC-007 冻结时：按 decision-change-template 变更 DEC-007 至 >=1.0.0，status 改 frozen；暂定值未变化则仅改状态，若变化需重新评审 linkage/presentation 并同步 prototype-traceability.yaml 相关 basis。',
} as const;

/** Contract 职责集合。 */
export function getContractScope(): readonly ContractScope[] {
  return CONTRACT_LICENSE_RELATION.ownership.contractScope;
}

/** License 职责集合。 */
export function getLicenseScope(): readonly LicenseScope[] {
  return CONTRACT_LICENSE_RELATION.ownership.licenseScope;
}

/** 职责归属判定：commercial-lease-term/device-association → contract；device-capability-authorization → license；未知职责返回 null（失败关闭）。 */
export function getScopeOwner(scope: string): 'contract' | 'license' | null {
  if ((CONTRACT_LICENSE_RELATION.ownership.contractScope as readonly string[]).includes(scope)) return 'contract';
  if ((CONTRACT_LICENSE_RELATION.ownership.licenseScope as readonly string[]).includes(scope)) return 'license';
  return null;
}

/** 创建 Contract 是否自动激活 License：恒为 false（锁定规则）。 */
export function doesContractCreateActivateLicense(): boolean {
  return CONTRACT_LICENSE_RELATION.linkage.contractCreateActivatesLicense;
}

/** 解绑 Contract 是否自动撤销 License：恒为 false（锁定规则）。 */
export function doesContractUnbindRevokeLicense(): boolean {
  return CONTRACT_LICENSE_RELATION.linkage.contractUnbindRevokesLicense;
}

/** Contract 状态是否独立于 License 展示：恒为 true（锁定规则）。 */
export function isContractStatusIndependentOfLicense(): boolean {
  return CONTRACT_LICENSE_RELATION.presentation.contractStatusIndependentOfLicense;
}

/** 策略当前状态：provisional 表示 DEC-007 未冻结。 */
export function getRelationPolicyStatus(): RelationPolicyStatus {
  return CONTRACT_LICENSE_RELATION.status;
}
