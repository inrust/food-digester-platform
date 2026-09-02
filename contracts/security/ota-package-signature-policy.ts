/**
 * OTA 固件包签名策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/security/ota-package-signature-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：实施方案 §20 风险表（OTA 包签名机制未确定，上线前冻结签名格式和
 * 信任根）；当前无登记决策 ID，冻结时先按 decision-change-template 登记。
 *
 * 消费方：BE-OTA-01（Firmware Package 上传验签）；下发通道 BE-OTA-03。
 * 约束：定性规则（服务端验签强制且失败关闭、签名载荷固定覆盖
 * model+version+packageType+sha256、信任根带外分发禁止内嵌）可直接执行；
 * 签名算法/信任根/编码是待冻结内容，读取时失败关闭
 * （抛 PolicyParameterPendingError），禁止臆测默认值。
 */

import { PolicyParameterPendingError } from './certificate-package-policy.ts';

export type OtaSignaturePolicyStatus = 'provisional' | 'frozen';

export type OtaSignaturePayloadField = 'model' | 'version' | 'packageType' | 'sha256';

export interface OtaPackageSignaturePolicy {
  readonly policyVersion: string;
  readonly status: OtaSignaturePolicyStatus;
  readonly verification: {
    /** 服务端验签强制，锁定为 true。 */
    readonly serverSide: true;
    /** 验签失败一律拒绝（失败关闭），锁定为 true。 */
    readonly failClosed: true;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly payload: {
    /** 签名覆盖的规范载荷字段与顺序（锁定）。 */
    readonly fields: readonly OtaSignaturePayloadField[];
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly signature: {
    /** 待冻结参数；provisional 为 null。 */
    readonly algorithm: string | null;
    readonly trustRoot: string | null;
    readonly encoding: string | null;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly trust: {
    readonly rootDistribution: 'out-of-band';
    /** 禁止从上传请求/包内元数据获取信任根，锁定为 false。 */
    readonly embeddedTrustRootAllowed: false;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（签名机制未冻结，实施方案 §20 风险表）：
 * 服务端验签强制 + 失败关闭；载荷锁定 model+version+packageType+sha256；
 * 信任根带外分发；算法/信任根/编码待冻结。
 */
export const OTA_PACKAGE_SIGNATURE_POLICY: OtaPackageSignaturePolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  verification: {
    serverSide: true,
    failClosed: true,
    consumers: ['BE-OTA-01'],
    note: '固件包必须经服务端验签才能进入可发布（VERIFIED）状态；验签任一环节（对象/大小/Hash/签名）失败一律拒绝（失败关闭），不得跳过或降级为仅 Hash 校验。',
  },
  payload: {
    fields: ['model', 'version', 'packageType', 'sha256'],
    consumers: ['BE-OTA-01'],
    note: '签名覆盖的规范载荷字段与顺序固定为 model+version+packageType+sha256：防型号/版本错配包被重签名混用（型号不匹配即签名不匹配）。具体序列化格式随签名算法一同冻结。',
  },
  signature: {
    algorithm: null,
    trustRoot: null,
    encoding: null,
    consumers: ['BE-OTA-01'],
    note: '待冻结参数：签名算法标识（如 Ed25519/ECDSA-P256）、信任根（公钥/KMS Key 标识）、签名编码（hex/base64 等）。provisional 期间为 null，读取失败关闭，禁止臆测默认值。',
  },
  trust: {
    rootDistribution: 'out-of-band',
    embeddedTrustRootAllowed: false,
    consumers: ['BE-OTA-01'],
    note: '信任根带外分发（部署配置/KMS），禁止从上传请求或包内元数据获取信任根；API 响应、日志与审计不输出信任根材料。',
  },
  pendingParameters: ['signature.algorithm', 'signature.trustRoot', 'signature.encoding'],
  frozenUpgradePath:
    'OTA 上线前：先按 decision-change-template 登记 OTA 包签名决策（算法/信任根/编码/载荷序列化格式）并补充 x-decision-versions 引用，再填入本策略、提升 policyVersion 至 >=1.0.0、status 改 frozen；同时提供固定测试向量供 BE-OTA-01/BE-OTA-03 与设备端复验。',
} as const;

function requireFrozen<T>(value: T | null, parameter: string): T {
  if (value === null) throw new PolicyParameterPendingError(parameter);
  return value;
}

/** 签名算法标识。签名机制冻结前调用抛 PolicyParameterPendingError。 */
export function getOtaSignatureAlgorithm(): string {
  return requireFrozen(OTA_PACKAGE_SIGNATURE_POLICY.signature.algorithm, 'signature.algorithm');
}

/** 信任根（公钥/KMS Key 标识）。签名机制冻结前调用抛 PolicyParameterPendingError。 */
export function getOtaSignatureTrustRoot(): string {
  return requireFrozen(OTA_PACKAGE_SIGNATURE_POLICY.signature.trustRoot, 'signature.trustRoot');
}

/** 签名编码（hex/base64 等）。签名机制冻结前调用抛 PolicyParameterPendingError。 */
export function getOtaSignatureEncoding(): string {
  return requireFrozen(OTA_PACKAGE_SIGNATURE_POLICY.signature.encoding, 'signature.encoding');
}

/** 签名覆盖的规范载荷字段与顺序（锁定规则），供验签构造载荷。 */
export function getOtaSignaturePayloadFields(): readonly OtaSignaturePayloadField[] {
  return OTA_PACKAGE_SIGNATURE_POLICY.payload.fields;
}

/** 服务端验签是否强制：恒为 true（锁定规则）。 */
export function isServerSideSignatureVerificationRequired(): boolean {
  return OTA_PACKAGE_SIGNATURE_POLICY.verification.serverSide;
}

/** 验签是否失败关闭：恒为 true（锁定规则）。 */
export function isSignatureVerificationFailClosed(): boolean {
  return OTA_PACKAGE_SIGNATURE_POLICY.verification.failClosed;
}

/** 是否允许内嵌信任根：恒为 false（锁定规则，信任根带外分发）。 */
export function isEmbeddedTrustRootAllowed(): boolean {
  return OTA_PACKAGE_SIGNATURE_POLICY.trust.embeddedTrustRootAllowed;
}

/** 策略当前状态：provisional 表示签名机制未冻结，消费方不得把值固化为不可迁移结构。 */
export function getOtaSignaturePolicyStatus(): OtaSignaturePolicyStatus {
  return OTA_PACKAGE_SIGNATURE_POLICY.status;
}
