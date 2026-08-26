/**
 * DEC-003 一次性证书包领取策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/security/certificate-package-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-003@0.2.0（status=pending，本策略为暂定实现，冻结后整体替换）。
 *
 * 消费方：SEC-01（secure package service）、BE-ONB-03（签发与 Status API）、
 * BE-CERT-02（轮换）。
 * 约束：定性规则（KMS 信封加密、一次性领取、成功领取后销毁、丢失后重签）
 * 可直接执行；定量参数（retentionSeconds、maxClaims）是 DEC-003 待冻结内容，
 * 读取时失败关闭（抛 PolicyParameterPendingError），禁止臆测默认值。
 */

export type PolicyStatus = 'provisional' | 'frozen';

export type DestructionTrigger = 'SUCCESSFUL_CLAIM' | 'NEW_CERTIFICATE_FIRST_HEARTBEAT';

export interface CertificatePackagePolicy {
  readonly policyVersion: string;
  readonly status: PolicyStatus;
  readonly storage: {
    readonly encryption: 'kms-envelope';
    readonly retention: 'short-term';
    /** DEC-003 待冻结参数；provisional 为 null。 */
    readonly retentionSeconds: number | null;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly claim: {
    readonly oneTime: true;
    /** DEC-003 待冻结参数；provisional 为 null。 */
    readonly maxClaims: number | null;
    readonly destroyOnSuccessfulClaim: true;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly lossHandling: {
    readonly mode: 'reissue';
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly destructionTriggers: {
    readonly triggers: readonly DestructionTrigger[];
    readonly consumers: readonly string[];
    readonly note: string;
  };
  /** DEC-003 冻结前必须显式给出数值的参数路径列表。 */
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-003 v0.2.0，pending）：
 * KMS 加密短期保存；成功领取后销毁；丢失后重签。
 */
export const CERTIFICATE_PACKAGE_POLICY: CertificatePackagePolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  storage: {
    encryption: 'kms-envelope',
    retention: 'short-term',
    retentionSeconds: null,
    consumers: ['SEC-01', 'BE-ONB-03', 'BE-CERT-02'],
    note: 'AWS 返回私钥后立即 KMS 信封加密；retentionSeconds 为 DEC-003 待冻结参数，当前 null。明文私钥永不落库；日志/审计只记录证书包指纹。',
  },
  claim: {
    oneTime: true,
    maxClaims: null,
    destroyOnSuccessfulClaim: true,
    consumers: ['SEC-01', 'BE-ONB-03', 'BE-CERT-02'],
    note: '一次性领取：成功领取后立即销毁密文包；maxClaims 为 DEC-003 待冻结参数，当前 null。重复领取在冻结前按失败关闭处理（拒绝并告警），不放行第二次明文下发。',
  },
  lossHandling: {
    mode: 'reissue',
    consumers: ['SEC-01', 'BE-ONB-03', 'BE-CERT-02'],
    note: '证书包丢失后重签新证书包（不恢复旧包明文）；重签走与首次签发相同的加密与领取约束。',
  },
  destructionTriggers: {
    triggers: ['SUCCESSFUL_CLAIM', 'NEW_CERTIFICATE_FIRST_HEARTBEAT'],
    consumers: ['SEC-01', 'BE-ONB-03', 'BE-ONB-04', 'BE-CERT-02'],
    note: '销毁触发点：成功领取；或新证书首个合法 Heartbeat（轮换场景确认后停用旧证并销毁新证书包）。销毁为不可逆删除密文材料并写业务审计。',
  },
  pendingParameters: ['storage.retentionSeconds', 'claim.maxClaims'],
  frozenUpgradePath:
    'DEC-003 冻结时：按 decision-change-template 变更 DEC-003 至 >=1.0.0，将 retentionSeconds/maxClaims 填入冻结数值并提升 policyVersion、status 改 frozen；消费方代码无需修改（数据驱动）。',
} as const;

export class PolicyParameterPendingError extends Error {
  readonly parameter: string;

  constructor(parameter: string) {
    super(`POLICY_PARAMETER_PENDING: ${parameter}（DEC-003 待冻结参数，禁止臆测默认值）`);
    this.name = 'PolicyParameterPendingError';
    this.parameter = parameter;
  }
}

/**
 * 读取待冻结数值参数。参数未冻结（null）时失败关闭抛错。
 */
function requireFrozenNumber(value: number | null, parameter: string): number {
  if (value === null) throw new PolicyParameterPendingError(parameter);
  return value;
}

/** 证书包短期保存时长（秒）。DEC-003 冻结前调用抛 PolicyParameterPendingError。 */
export function getRetentionSeconds(): number {
  return requireFrozenNumber(CERTIFICATE_PACKAGE_POLICY.storage.retentionSeconds, 'storage.retentionSeconds');
}

/** 允许领取次数。DEC-003 冻结前调用抛 PolicyParameterPendingError。 */
export function getMaxClaims(): number {
  return requireFrozenNumber(CERTIFICATE_PACKAGE_POLICY.claim.maxClaims, 'claim.maxClaims');
}

/** 是否一次性领取（成功领取后销毁密文包）。 */
export function isOneTimeClaim(): boolean {
  return CERTIFICATE_PACKAGE_POLICY.claim.oneTime && CERTIFICATE_PACKAGE_POLICY.claim.destroyOnSuccessfulClaim;
}

/** 存储加密方式。 */
export function getStorageEncryption(): 'kms-envelope' {
  return CERTIFICATE_PACKAGE_POLICY.storage.encryption;
}

/** 丢失处置模式。 */
export function getLossHandlingMode(): 'reissue' {
  return CERTIFICATE_PACKAGE_POLICY.lossHandling.mode;
}

/** 是否属于证书包销毁触发点。未知值返回 false（失败关闭）。 */
export function isDestructionTrigger(value: string): value is DestructionTrigger {
  return (CERTIFICATE_PACKAGE_POLICY.destructionTriggers.triggers as readonly string[]).includes(value);
}

/** 重复领取在冻结前的处理：失败关闭（拒绝）。DEC-003 冻结后按 maxClaims 重新判定。 */
export function isRepeatClaimAllowed(): boolean {
  if (CERTIFICATE_PACKAGE_POLICY.claim.maxClaims === null) return false;
  return CERTIFICATE_PACKAGE_POLICY.claim.maxClaims > 1;
}

/** 策略当前状态：provisional 表示 DEC-003 未冻结，消费方不得把值固化为不可迁移结构。 */
export function getPolicyStatus(): PolicyStatus {
  return CERTIFICATE_PACKAGE_POLICY.status;
}
