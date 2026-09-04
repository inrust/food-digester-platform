/**
 * DEC-003 一次性证书包领取策略（已冻结）。
 *
 * 事实源：contracts/security/certificate-package-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-003@1.0.0（status=frozen）。
 *
 * 消费方：SEC-01（secure package service）、BE-ONB-03（签发与 Status API）、
 * BE-CERT-02（轮换）。
 * 约束：KMS 信封加密保存 86400 秒，仅一次成功领取，成功响应提交后销毁；
 * 响应不确定、包丢失或过期时吊销未确认新证书后重签。
 */

export type PolicyStatus = 'provisional' | 'frozen';

export type DestructionTrigger = 'SUCCESSFUL_CLAIM' | 'NEW_CERTIFICATE_FIRST_HEARTBEAT';

export interface CertificatePackagePolicy {
  readonly policyVersion: string;
  readonly status: PolicyStatus;
  readonly storage: {
    readonly encryption: 'kms-envelope';
    readonly retention: 'short-term';
    /** 冻结保存期限（秒）。 */
    readonly retentionSeconds: number | null;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly claim: {
    readonly oneTime: true;
    /** 冻结的成功领取次数上限。 */
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
 * 冻结值（DEC-003 v1.0.0）。
 */
export const CERTIFICATE_PACKAGE_POLICY: CertificatePackagePolicy = {
  policyVersion: '1.0.0',
  status: 'frozen',
  storage: {
    encryption: 'kms-envelope',
    retention: 'short-term',
    retentionSeconds: 86400,
    consumers: ['SEC-01', 'BE-ONB-03', 'BE-CERT-02'],
    note: 'AWS 返回私钥后立即 KMS 信封加密，密文包最多保存 86400 秒。明文私钥永不落库；日志/审计只记录证书包指纹。',
  },
  claim: {
    oneTime: true,
    maxClaims: 1,
    destroyOnSuccessfulClaim: true,
    consumers: ['SEC-01', 'BE-ONB-03', 'BE-CERT-02'],
    note: '一次性领取：只允许一次成功响应；服务端提交 2xx 响应后立即销毁密文包。重复领取拒绝并告警，不放行第二次明文下发。',
  },
  lossHandling: {
    mode: 'reissue',
    consumers: ['SEC-01', 'BE-ONB-03', 'BE-CERT-02'],
    note: '响应不确定、证书包丢失或过期后不恢复旧包明文；吊销未确认的新证书，再按首次签发约束重签。',
  },
  destructionTriggers: {
    triggers: ['SUCCESSFUL_CLAIM', 'NEW_CERTIFICATE_FIRST_HEARTBEAT'],
    consumers: ['SEC-01', 'BE-ONB-03', 'BE-ONB-04', 'BE-CERT-02'],
    note: '销毁触发点：成功领取；或新证书首个合法 Heartbeat（轮换场景确认后停用旧证并销毁新证书包）。销毁为不可逆删除密文材料并写业务审计。',
  },
  pendingParameters: [],
  frozenUpgradePath: '策略已按 DEC-003@1.0.0 冻结；后续修改必须新增决策版本、同步消费方并提供迁移与回滚说明。',
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

/** 证书包短期保存时长（秒）。 */
export function getRetentionSeconds(): number {
  return requireFrozenNumber(CERTIFICATE_PACKAGE_POLICY.storage.retentionSeconds, 'storage.retentionSeconds');
}

/** 允许成功领取次数。 */
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

/** 是否允许重复成功领取。DEC-003@1.0.0 恒为 false。 */
export function isRepeatClaimAllowed(): boolean {
  if (CERTIFICATE_PACKAGE_POLICY.claim.maxClaims === null) return false;
  return CERTIFICATE_PACKAGE_POLICY.claim.maxClaims > 1;
}

/** 策略当前状态。 */
export function getPolicyStatus(): PolicyStatus {
  return CERTIFICATE_PACKAGE_POLICY.status;
}
