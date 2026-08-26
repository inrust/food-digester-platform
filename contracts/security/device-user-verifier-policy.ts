/**
 * DEC-004 Device User 密码验证格式（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/security/device-user-verifier-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-004@0.2.0（status=pending，本策略为暂定实现，冻结后整体替换）。
 *
 * 消费方：BE-DUSR-02（KDF adapter / Sync DTO）；下发通道 BE-SYNC-01。
 * 约束：定性规则（设备本地专用、禁止复用云端密码 Hash、每用户独立 salt、
 * 仅 Sync 下发）可直接执行；KDF 具体格式（算法/参数/salt/hash 长度）是
 * DEC-004 待冻结内容，读取时失败关闭（抛 PolicyParameterPendingError）。
 */

import { PolicyParameterPendingError } from './certificate-package-policy.ts';

export type VerifierPolicyStatus = 'provisional' | 'frozen';

export type VerifierMaterialField = 'version' | 'kdf' | 'salt' | 'hash';

export type DistributionChannel = 'SYNC';

export interface DeviceUserVerifierPolicy {
  readonly policyVersion: string;
  readonly status: VerifierPolicyStatus;
  readonly separation: {
    readonly purpose: 'device-local-only';
    /** 禁止复用云端密码 Hash，锁定为 false。 */
    readonly cloudHashReuse: false;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly material: {
    readonly fields: readonly VerifierMaterialField[];
    /** DEC-004 待冻结参数；provisional 为 null。 */
    readonly kdf: string | null;
    readonly kdfParameters: Readonly<Record<string, number | string>> | null;
    readonly saltBytes: number | null;
    readonly hashBytes: number | null;
    readonly saltPerUser: true;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly distribution: {
    readonly channels: readonly DistributionChannel[];
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-004 v0.2.0，pending）：
 * 设备本地专用加盐验证值，禁止复用云端密码 Hash。
 */
export const DEVICE_USER_VERIFIER_POLICY: DeviceUserVerifierPolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  separation: {
    purpose: 'device-local-only',
    cloudHashReuse: false,
    consumers: ['BE-DUSR-02'],
    note: '验证值仅供设备本地登录校验；禁止复用 Cognito 或云端用户密码 Hash；与云端账号体系完全分离，不赋予云端登录权限。',
  },
  material: {
    fields: ['version', 'kdf', 'salt', 'hash'],
    kdf: null,
    kdfParameters: null,
    saltBytes: null,
    hashBytes: null,
    saltPerUser: true,
    consumers: ['BE-DUSR-02'],
    note: '验证材料结构固定为 version+kdf+salt+hash 四字段，version 支持算法迁移。kdf/kdfParameters/saltBytes/hashBytes 为 DEC-004 待冻结参数，当前 null。每用户独立随机 salt（不同 salt 结果必须不同）。',
  },
  distribution: {
    channels: ['SYNC'],
    consumers: ['BE-DUSR-02', 'BE-SYNC-01'],
    note: '验证材料仅经 Unified Device Sync（BE-SYNC-01）的 Device Users 域下发；任何查询类 API 不得返回；接口日志与业务审计必须脱敏（盐值可按冻结规则保留，hash 永不入日志）。',
  },
  pendingParameters: ['material.kdf', 'material.kdfParameters', 'material.saltBytes', 'material.hashBytes'],
  frozenUpgradePath:
    'DEC-004 冻结时：按 decision-change-template 变更 DEC-004 至 >=1.0.0，填入 KDF 算法、参数与 salt/hash 长度并提升 policyVersion、status 改 frozen；同时提供固定测试向量供设备方复验（BE-DUSR-02 验收基准）。',
} as const;

function requireFrozen<T>(value: T | null, parameter: string): T {
  if (value === null) throw new PolicyParameterPendingError(parameter);
  return value;
}

/** KDF 算法标识。DEC-004 冻结前调用抛 PolicyParameterPendingError。 */
export function getVerifierKdf(): string {
  return requireFrozen(DEVICE_USER_VERIFIER_POLICY.material.kdf, 'material.kdf');
}

/** KDF 参数（迭代次数/内存等）。DEC-004 冻结前调用抛 PolicyParameterPendingError。 */
export function getVerifierKdfParameters(): Readonly<Record<string, number | string>> {
  return requireFrozen(DEVICE_USER_VERIFIER_POLICY.material.kdfParameters, 'material.kdfParameters');
}

/** salt 长度（字节）。DEC-004 冻结前调用抛 PolicyParameterPendingError。 */
export function getVerifierSaltBytes(): number {
  return requireFrozen(DEVICE_USER_VERIFIER_POLICY.material.saltBytes, 'material.saltBytes');
}

/** hash 输出长度（字节）。DEC-004 冻结前调用抛 PolicyParameterPendingError。 */
export function getVerifierHashBytes(): number {
  return requireFrozen(DEVICE_USER_VERIFIER_POLICY.material.hashBytes, 'material.hashBytes');
}

/** 验证材料固定字段（version+kdf+salt+hash），供 Sync DTO 与生成器使用。 */
export function getVerifierMaterialFields(): readonly VerifierMaterialField[] {
  return DEVICE_USER_VERIFIER_POLICY.material.fields;
}

/** 是否允许复用云端密码 Hash：恒为 false（锁定规则）。 */
export function isCloudHashReuseAllowed(): boolean {
  return DEVICE_USER_VERIFIER_POLICY.separation.cloudHashReuse;
}

/** 是否要求每用户独立 salt：恒为 true（锁定规则）。 */
export function isPerUserSaltRequired(): boolean {
  return DEVICE_USER_VERIFIER_POLICY.material.saltPerUser;
}

/** 验证材料是否允许经指定通道下发。未知通道返回 false（失败关闭）。 */
export function isDistributionChannelAllowed(channel: string): channel is DistributionChannel {
  return (DEVICE_USER_VERIFIER_POLICY.distribution.channels as readonly string[]).includes(channel);
}

/** 策略当前状态：provisional 表示 DEC-004 未冻结，消费方不得把值固化为不可迁移结构。 */
export function getVerifierPolicyStatus(): VerifierPolicyStatus {
  return DEVICE_USER_VERIFIER_POLICY.status;
}
