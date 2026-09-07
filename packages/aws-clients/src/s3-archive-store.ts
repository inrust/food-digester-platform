/**
 * BE-ARC-02 S3 Archive ObjectStore 适配器（Archive Worker 的写入端口实现）。
 * 仅 PutObject；生命周期/Object Lock/长期归档运维归边界外。
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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

export interface ArchiveObjectReaderPort {
  listKeys(prefix: string): Promise<string[]>;
  getObject(key: string): Promise<Uint8Array>;
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

/** BE-RPL-01：展开 S3 分页并读取归档对象字节。 */
export function createS3ArchiveObjectReader(config: S3ArchiveObjectStoreConfig): ArchiveObjectReaderPort {
  const client = config.client ?? new S3Client(config.region ? { region: config.region } : {});
  return {
    async listKeys(prefix) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
          }),
        );
        for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys.sort();
    },
    async getObject(key) {
      const output = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      if (!output.Body) throw new Error(`S3 archive object body missing: ${key}`);
      return output.Body.transformToByteArray();
    },
  };
}
