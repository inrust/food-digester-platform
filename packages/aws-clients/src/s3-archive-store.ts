/**
 * BE-ARC-02 S3 Archive ObjectStore 适配器（Archive Worker 的写入端口实现）。
 * 仅 PutObject；生命周期/Object Lock/长期归档运维归边界外。
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface S3ArchiveObjectStoreConfig {
  /** Archive Bucket 名（IAC-01：fdp-{env}-archive-{accountId}）。 */
  readonly bucket: string;
  /** 注入的 S3 客户端（测试可 mock）；缺省按 region 创建。 */
  readonly client?: S3Client;
  readonly region?: string;
}

export interface ArchiveObjectStorePort {
  putObject(params: { key: string; body: Uint8Array; contentType: string }): Promise<void>;
}

export function createS3ArchiveObjectStore(config: S3ArchiveObjectStoreConfig): ArchiveObjectStorePort {
  const client = config.client ?? new S3Client(config.region ? { region: config.region } : {});
  return {
    async putObject({ key, body, contentType }) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
  };
}
