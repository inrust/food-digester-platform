/**
 * BE-OTA-01 固件包对象存储与预签名上传 URL 适配端口（S3 adapter 注入点）。
 *
 * 模块无 AWS 依赖：IAC-01 OTA Bucket（KMS 加密、阻断公网）与预签名实现由部署层
 * 接线（环境变量 OTA_BUCKET_NAME，见 infra app-dependencies-stack）。
 *
 * 安全约束：
 * - objectKey 一律由服务端生成（buildFirmwareObjectKey），客户端不得指定
 *   Bucket/Key（防任意 Key 覆盖/读取）；
 * - 预签名上传 URL 短期有效（OTA_UPLOAD_URL_TTL_SECONDS，900s 暂定值）；
 * - 哈希重算由部署层流式实现（不得把整包读入 Lambda 内存上限之外）。
 */

/** 预签名上传 URL 有效期（秒，暂定值；部署层签名器应与其一致）。 */
export const OTA_UPLOAD_URL_TTL_SECONDS = 900 as const;

/** 固件包大小上限（字节，512MiB 暂定值；OTA 上线前随签名机制一同复核）。 */
export const MAX_FIRMWARE_PACKAGE_SIZE_BYTES = 512 * 1024 * 1024;

/** 对象存储读取端口（部署层接 S3 HeadObject + 流式 SHA-256）。 */
export interface OtaPackageStorage {
  /** 对象存在性 + 实际大小；不存在返回 null。 */
  readonly statObject: (key: string) => Promise<{ readonly sizeBytes: number } | null>;
  /** 流式重算对象 SHA-256（小写 hex）；对象不存在返回 null。 */
  readonly computeSha256: (key: string) => Promise<string | null>;
}

/** 预签名上传 URL 签名器端口（部署层接 S3 presigned PUT）。 */
export interface OtaUploadUrlSigner {
  readonly signUpload: (input: { readonly key: string; readonly expiresAt: Date }) => Promise<string> | string;
}

/** model/version 合法字符（objectKey 组成部分，禁止路径分隔符与穿越）。 */
export const FIRMWARE_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 服务端生成对象 Key：firmware-packages/{model}/{packageType}/{version}/{packageId}。 */
export function buildFirmwareObjectKey(input: {
  readonly model: string;
  readonly packageType: string;
  readonly version: string;
  readonly packageId: string;
}): string {
  return `firmware-packages/${input.model}/${input.packageType}/${input.version}/${input.packageId}`;
}
