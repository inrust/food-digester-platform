/**
 * Media 上传策略（DEC-024@1.0.0 冻结值）。
 *
 * 事实源：contracts/media/media-upload-policy.json（本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-005@1.0.0（存储分离与保留期，已冻结，见 media-retention-policy）；
 * 上传限制（大小/UTC 日配额/TTL）由 DEC-024@1.0.0 冻结。
 *
 * 消费方：BE-MED-01（上传会话 / 元数据校验 / 下载 URL）。
 * 约束：mediaTypes、objectKey 与 limits 均为冻结项，消费方经本模块查询函数访问。
 */

export type MediaUploadPolicyStatus = 'frozen';

export type MediaType = 'IMAGE' | 'VIDEO';

export interface MediaUploadPolicy {
  readonly policyVersion: string;
  readonly status: MediaUploadPolicyStatus;
  /** 媒体类型集合（与 CT-03 media.schema.json 枚举一致，锁定）。 */
  readonly mediaTypes: readonly MediaType[];
  readonly limits: {
    /** 各类型大小上限（KB，DEC-024）。 */
    readonly maxSizeKb: Readonly<Record<MediaType, number>>;
    /** 每设备 UTC 自然日上传会话配额（DEC-024）。 */
    readonly dailyUploadQuotaPerDevice: number;
    /** 预签名上传 URL TTL（秒，DEC-024）。 */
    readonly uploadUrlTtlSeconds: number;
    /** 预签名下载 URL TTL（秒，DEC-024）。 */
    readonly downloadUrlTtlSeconds: number;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly objectKey: {
    /** 服务端生成 Key 的固定模板（锁定）。 */
    readonly pattern: 'media/{customerId}/{deviceId}/{sessionId}/{fileName}';
    /** 禁止客户端指定 Bucket/Key（锁定 false）。 */
    readonly clientProvidedKeyAllowed: false;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/** DEC-024 冻结值：IMAGE ≤ 10MiB、VIDEO ≤ 200MiB、每设备 UTC 自然日 100 会话、预签名 TTL 900s。 */
export const MEDIA_UPLOAD_POLICY: MediaUploadPolicy = {
  policyVersion: '1.0.0',
  status: 'frozen',
  mediaTypes: ['IMAGE', 'VIDEO'],
  limits: {
    maxSizeKb: { IMAGE: 10240, VIDEO: 204800 },
    dailyUploadQuotaPerDevice: 100,
    uploadUrlTtlSeconds: 900,
    downloadUrlTtlSeconds: 900,
    consumers: ['BE-MED-01'],
    note: 'DEC-024@1.0.0：IMAGE ≤ 10MiB（10240KB）、VIDEO ≤ 200MiB（204800KB）、每设备 UTC 自然日最多签发 100 个上传会话、上传/下载预签名 URL 均为 900s。',
  },
  objectKey: {
    pattern: 'media/{customerId}/{deviceId}/{sessionId}/{fileName}',
    clientProvidedKeyAllowed: false,
    consumers: ['BE-MED-01'],
    note: 'objectPath 服务端按设备前缀生成；Media 元数据报文的 objectPath 必须与某有效会话的签发 Key 完全一致（逐字符相等），跨设备/跨会话/任意 Key 一律拒绝。',
  },
  pendingParameters: [],
  frozenUpgradePath: '已按 DEC-024@1.0.0 冻结；后续变更必须提升 DEC 与 policyVersion，并同步契约、实现和测试。',
} as const;

/** 媒体类型集合（与 CT-03 media.schema.json 枚举一致）。 */
export function getMediaTypes(): readonly MediaType[] {
  return MEDIA_UPLOAD_POLICY.mediaTypes;
}

/** 指定类型的大小上限（KB，DEC-024 冻结值）。 */
export function getMaxSizeKb(mediaType: MediaType): number {
  return MEDIA_UPLOAD_POLICY.limits.maxSizeKb[mediaType];
}

/** 每设备 UTC 自然日上传会话配额（DEC-024 冻结值）。 */
export function getDailyUploadQuotaPerDevice(): number {
  return MEDIA_UPLOAD_POLICY.limits.dailyUploadQuotaPerDevice;
}

/** 预签名上传 URL TTL（秒，DEC-024 冻结值）。 */
export function getUploadUrlTtlSeconds(): number {
  return MEDIA_UPLOAD_POLICY.limits.uploadUrlTtlSeconds;
}

/** 预签名下载 URL TTL（秒，DEC-024 冻结值）。 */
export function getDownloadUrlTtlSeconds(): number {
  return MEDIA_UPLOAD_POLICY.limits.downloadUrlTtlSeconds;
}

/** 是否允许客户端指定 Bucket/Key：恒为 false（锁定规则）。 */
export function isClientProvidedKeyAllowed(): boolean {
  return MEDIA_UPLOAD_POLICY.objectKey.clientProvidedKeyAllowed;
}

/** 服务端生成 Key 的固定模板（锁定规则）。 */
export function getObjectKeyPattern(): string {
  return MEDIA_UPLOAD_POLICY.objectKey.pattern;
}

/** 策略当前状态：frozen 表示上传限制已由 DEC-024 冻结。 */
export function getMediaUploadPolicyStatus(): MediaUploadPolicyStatus {
  return MEDIA_UPLOAD_POLICY.status;
}
