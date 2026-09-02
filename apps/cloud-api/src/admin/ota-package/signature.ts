/**
 * BE-OTA-01 固件包签名验签：策略查询门面、签名 verifier 端口与规范载荷构造。
 *
 * 签名格式由项目冻结值驱动（contracts/security/ota-package-signature-policy，
 * 当前 provisional）：
 * - 组合根必须经该契约模块的查询函数接线本门面（cloud-api 不经 tsc 构建引用
 *   contracts 源码包；禁止直接读 JSON 或复制暂定值）；
 * - 冻结前 getSignatureAlgorithm/TrustRoot/Encoding 抛 PolicyParameterPendingError
 *   （失败关闭），Service 不兜底、映射为 409：任何包不得进入 VERIFIED；
 * - 定性规则已锁定并由本模块执行：签名载荷固定覆盖 model+version+packageType+sha256
 *   （防型号/版本错配包被重签名混用）；信任根只来自策略（带外分发），绝不从
 *   上传请求或包内元数据获取；
 * - FirmwareSignatureVerifier 为算法 adapter 端口（冻结后接 Ed25519/KMS 等实现）。
 */

/** 签名策略查询门面（镜像 ota-package-signature-policy.ts 的冻结参数查询函数签名）。 */
export interface OtaSignaturePolicyQuery {
  /** 签名算法标识（冻结前抛 PolicyParameterPendingError）。 */
  readonly getSignatureAlgorithm: () => string;
  /** 信任根（公钥/KMS Key 标识；冻结前抛 PolicyParameterPendingError）。 */
  readonly getSignatureTrustRoot: () => string;
  /** 签名编码（hex/base64 等；冻结前抛 PolicyParameterPendingError）。 */
  readonly getSignatureEncoding: () => string;
  /** 签名覆盖的规范载荷字段与顺序（锁定规则，非冻结参数）。 */
  readonly getSignaturePayloadFields: () => readonly string[];
}

/** 签名 verifier 端口：冻结后由具体算法实现（如 Ed25519/KMS Verify 适配器）。 */
export interface FirmwareSignatureVerifier {
  /** 算法标识；必须等于策略 algorithm，否则拒绝验签（防接线错配）。 */
  readonly algorithmId: string;
  /** 验证 signature 是否为目标载荷的有效签名；实现方不得持久化信任根材料。 */
  readonly verify: (input: {
    readonly payload: string;
    readonly signature: string;
    readonly trustRoot: string;
    readonly encoding: string;
  }) => Promise<boolean> | boolean;
}

/** 参与规范载荷的字段集合（与策略 payload.fields 一致；顺序由策略驱动）。 */
export const SIGNATURE_PAYLOAD_FIELDS = ['model', 'version', 'packageType', 'sha256'] as const;

export type SignaturePayloadField = (typeof SIGNATURE_PAYLOAD_FIELDS)[number];

/** 载荷字段取值（sha256 归一化为小写 hex，消除大小写歧义）。 */
export type SignaturePayloadValues = Readonly<Record<SignaturePayloadField, string>>;

/** 规范载荷版本前缀（暂定值；载荷序列化格式随签名机制一同冻结，冻结后整体替换）。 */
export const SIGNATURE_PAYLOAD_FORMAT = 'FDP-OTA-SIG-v1' as const;

/**
 * 构造规范载荷：字段与顺序由策略 payload.fields 驱动（签名格式由冻结值驱动）。
 * 策略含未知字段 → 抛错（失败关闭，不静默略过）。
 */
export function buildSignaturePayload(fields: readonly string[], values: SignaturePayloadValues): string {
  const parts: string[] = [SIGNATURE_PAYLOAD_FORMAT];
  for (const field of fields) {
    const value = (values as Record<string, string>)[field];
    if (value === undefined) {
      throw new Error(`Unknown OTA signature payload field from policy: ${field}`);
    }
    parts.push(`${field}=${value}`);
  }
  return parts.join('\n');
}

/** 是否策略待冻结错误（PolicyParameterPendingError；contracts 侧失败关闭信号）。 */
export function isPolicyParameterPending(err: unknown): boolean {
  return err instanceof Error && err.name === 'PolicyParameterPendingError';
}
