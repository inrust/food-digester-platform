/**
 * DEC-004 Device User 密码验证格式（已冻结）。
 *
 * 事实源：contracts/security/device-user-verifier-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-004@1.0.0（status=frozen）。
 *
 * 消费方：BE-DUSR-02（KDF adapter / Sync DTO）；下发通道 BE-SYNC-01。
 * 约束：Argon2id v=19（m=32768 KiB、t=3、p=1、salt=16、hash=32），
 * 通过 Sync 的 passwordHash 字段按 PHC 字符串下发。
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
    /** 冻结的 KDF 标识与参数。 */
    readonly kdf: string | null;
    readonly kdfParameters: Readonly<Record<string, number | string>> | null;
    readonly encoding: 'phc-string';
    readonly wireField: 'passwordHash';
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
 * 冻结值（DEC-004 v1.0.0）。
 */
export const DEVICE_USER_VERIFIER_POLICY: DeviceUserVerifierPolicy = {
  policyVersion: '1.0.0',
  status: 'frozen',
  separation: {
    purpose: 'device-local-only',
    cloudHashReuse: false,
    consumers: ['BE-DUSR-02'],
    note: '验证值仅供设备本地登录校验；禁止复用 Cognito 或云端用户密码 Hash；与云端账号体系完全分离，不赋予云端登录权限。',
  },
  material: {
    fields: ['version', 'kdf', 'salt', 'hash'],
    kdf: 'argon2id',
    kdfParameters: {
      version: 19,
      memoryKib: 32768,
      iterations: 3,
      parallelism: 1,
      targetMillisecondsMin: 250,
      targetMillisecondsMax: 500,
    },
    encoding: 'phc-string',
    wireField: 'passwordHash',
    saltBytes: 16,
    hashBytes: 32,
    saltPerUser: true,
    consumers: ['BE-DUSR-02'],
    note: '内部逻辑材料为 version+kdf+salt+hash；线协议统一编码为 passwordHash PHC 字符串。每用户使用 16 字节独立随机 salt，输出 32 字节。',
  },
  distribution: {
    channels: ['SYNC'],
    consumers: ['BE-DUSR-02', 'BE-SYNC-01'],
    note: '验证材料仅经 Unified Device Sync（BE-SYNC-01）的 Device Users.passwordHash 下发；任何查询类 API 不得返回；接口日志与业务审计必须整体遮蔽 PHC 字符串。',
  },
  pendingParameters: [],
  frozenUpgradePath:
    '策略已按 DEC-004@1.0.0 冻结；后续算法或参数升级必须新增材料版本和决策版本，并在兼容窗口内同时验证旧、新 PHC 字符串。',
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

/** 策略当前状态。 */
export function getVerifierPolicyStatus(): VerifierPolicyStatus {
  return DEVICE_USER_VERIFIER_POLICY.status;
}
