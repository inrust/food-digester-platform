/**
 * BE-MED-01 Media 对象存储与预签名 URL 适配端口（S3 adapter 注入点）。
 *
 * 模块无 AWS 依赖：IAC-01 Media Bucket（独立受控 Bucket）与预签名实现由部署层
 * 接线（环境变量 MEDIA_BUCKET_NAME，见 infra app-dependencies-stack）。
 *
 * 安全约束（contracts/media/media-upload-policy 锁定规则）：
 * - objectPath 一律服务端生成（buildMediaObjectKey：media/{customerId}/{deviceId}/{sessionId}/{fileName}），
 *   客户端不得指向任意 Bucket/Key；
 * - 预签名上传/下载 URL 短期有效（策略暂定值 900s），部署层签名器按同一 TTL 实现；
 * - 哈希/大小重算由部署层流式实现。
 */

/** 对象存储读取端口（部署层接 S3 HeadObject + 流式 SHA-256）。 */
export interface MediaObjectStorage {
  /** 对象存在性 + 实际大小；不存在返回 null。 */
  readonly statObject: (key: string) => Promise<{ readonly sizeBytes: number } | null>;
  /** 流式重算对象 SHA-256（小写 hex）；对象不存在返回 null。 */
  readonly computeSha256: (key: string) => Promise<string | null>;
}

/** 预签名 URL 签名器端口（部署层接 S3 presigned PUT/GET）。 */
export interface MediaUrlSigner {
  readonly signUpload: (input: { readonly key: string; readonly expiresAt: Date }) => string;
  readonly signDownload: (input: { readonly key: string; readonly expiresAt: Date }) => string;
}

/** 服务端生成对象 Key（设备前缀；fileName 须经安全字符校验，见 service）。 */
export function buildMediaObjectKey(input: {
  readonly customerId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly fileName: string;
}): string {
  return `media/${input.customerId}/${input.deviceId}/${input.sessionId}/${input.fileName}`;
}

/**
 * 解析媒体对象 Key；不符合固定模板（恰好 5 段且前缀 media）返回 null。
 */
export function parseMediaObjectKey(
  key: string,
): { customerId: string; deviceId: string; sessionId: string; fileName: string } | null {
  const parts = key.split('/');
  if (parts.length !== 5 || parts[0] !== 'media') return null;
  const [customerId, deviceId, sessionId, fileName] = [parts[1]!, parts[2]!, parts[3]!, parts[4]!];
  if (!customerId || !deviceId || !sessionId || !fileName) return null;
  return { customerId, deviceId, sessionId, fileName };
}
