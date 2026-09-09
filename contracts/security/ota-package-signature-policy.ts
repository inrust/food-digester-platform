/**
 * OTA 固件包签名策略（DEC-022@1.0.0）。
 *
 * 事实源：contracts/security/ota-package-signature-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：实施方案 §20 风险表（OTA 包签名机制未确定，上线前冻结签名格式和
 * 信任根）；冻结决策登记为 DEC-022@1.0.0。
 *
 * 消费方：BE-OTA-01（Firmware Package 上传验签）；下发通道 BE-OTA-03。
 * 约束：定性规则（服务端验签强制且失败关闭、签名载荷固定覆盖
 * model+version+packageType+sha256、信任根带外分发禁止内嵌）可直接执行；
 * 算法/信任根类型/编码已冻结，部署层使用环境 KMS Key ARN。
 */

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
    readonly algorithm: string;
    readonly trustRoot: string;
    readonly encoding: string;
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
 * DEC-022 冻结值：KMS RSA-2048 + RSASSA PKCS#1 v1.5 SHA-256 + base64。
 */
export const OTA_PACKAGE_SIGNATURE_POLICY: OtaPackageSignaturePolicy = {
  policyVersion: '1.0.0',
  status: 'frozen',
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
    algorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
    trustRoot: 'AWS_KMS_ASYMMETRIC_SIGNING_KEY',
    encoding: 'base64',
    consumers: ['BE-OTA-01'],
    note: 'DEC-022：AWS KMS RSA-2048 非对称密钥，SigningAlgorithm=RSASSA_PKCS1_V1_5_SHA_256，签名以 base64 编码；运行时使用环境绑定 KMS Key ARN 执行 Verify。',
  },
  trust: {
    rootDistribution: 'out-of-band',
    embeddedTrustRootAllowed: false,
    consumers: ['BE-OTA-01'],
    note: '信任根带外分发（部署配置/KMS），禁止从上传请求或包内元数据获取信任根；API 响应、日志与审计不输出信任根材料。',
  },
  pendingParameters: [],
  frozenUpgradePath:
    '算法、编码、信任根类型或规范载荷变更必须提升 DEC-022 和本策略版本，同步 KMS adapter、固定测试向量、设备端验签及目标 AWS 验收。',
} as const;

/** 签名算法标识。 */
export function getOtaSignatureAlgorithm(): string {
  return OTA_PACKAGE_SIGNATURE_POLICY.signature.algorithm;
}

/** 冻结的信任根类型（实际 KMS Key ARN 由部署配置注入）。 */
export function getOtaSignatureTrustRoot(): string {
  return OTA_PACKAGE_SIGNATURE_POLICY.signature.trustRoot;
}

/** 冻结的签名编码。 */
export function getOtaSignatureEncoding(): string {
  return OTA_PACKAGE_SIGNATURE_POLICY.signature.encoding;
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

/** 策略当前状态；当前为 DEC-022@1.0.0 frozen，若登记异常回退则消费方必须失败关闭。 */
export function getOtaSignaturePolicyStatus(): OtaSignaturePolicyStatus {
  return OTA_PACKAGE_SIGNATURE_POLICY.status;
}
