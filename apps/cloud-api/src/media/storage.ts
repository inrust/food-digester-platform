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

export { buildMediaObjectKey, parseMediaObjectKey } from '@fdp/media';
export type { MediaObjectStorage } from '@fdp/media';

/** 预签名 URL 签名器端口（部署层接 S3 presigned PUT/GET）。 */
export interface MediaUrlSigner {
  readonly signUpload: (input: { readonly key: string; readonly expiresAt: Date }) => string;
  readonly signDownload: (input: { readonly key: string; readonly expiresAt: Date }) => string;
}
