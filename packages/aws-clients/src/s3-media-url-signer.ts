import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface S3MediaUrlSignerConfig {
  readonly bucket: string;
  readonly region?: string;
  readonly client?: S3Client;
  readonly presign?: typeof getSignedUrl;
}

export interface MediaUrlSignerPort {
  readonly signUpload: (input: {
    readonly key: string;
    readonly expiresAt: Date;
    readonly contentLength: number;
    readonly checksumSha256: string;
  }) => Promise<string>;
  readonly signDownload: (input: { readonly key: string; readonly expiresAt: Date }) => Promise<string>;
}

function ttlSeconds(expiresAt: Date): number {
  const ttl = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  if (ttl < 1 || ttl > 3600) throw new Error('Media presigned URL TTL must be between 1 and 3600 seconds');
  return ttl;
}

function assertMediaKey(key: string): void {
  if (!/^media\/[^/]+\/[^/]+\/[^/]+\/[A-Za-z0-9._-]{1,128}$/.test(key)) {
    throw new Error('Media object key is outside the managed media prefix');
  }
}

function checksumBase64(hex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Media SHA-256 checksum must be hex64');
  return Buffer.from(hex, 'hex').toString('base64');
}

/** S3 PUT/GET 预签名实现：Bucket 固定，Key 限定 media 前缀，上传绑定精确长度与 SHA-256。 */
export function createS3MediaUrlSigner(config: S3MediaUrlSignerConfig): MediaUrlSignerPort {
  const client = config.client ?? new S3Client(config.region ? { region: config.region } : {});
  const presign = config.presign ?? getSignedUrl;
  return {
    async signUpload(input) {
      assertMediaKey(input.key);
      if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
        throw new Error('Media content length must be a positive safe integer');
      }
      return presign(
        client,
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          ContentLength: input.contentLength,
          ChecksumSHA256: checksumBase64(input.checksumSha256),
        }),
        { expiresIn: ttlSeconds(input.expiresAt) },
      );
    },
    async signDownload(input) {
      assertMediaKey(input.key);
      return presign(client, new GetObjectCommand({ Bucket: config.bucket, Key: input.key }), {
        expiresIn: ttlSeconds(input.expiresAt),
      });
    },
  };
}
