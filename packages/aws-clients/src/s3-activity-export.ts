/** BE-DEV-05：活动导出 CSV 的 S3 写入与短期下载 URL 生产适配器。 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export interface S3ActivityExportConfig {
  readonly bucket: string;
  readonly region?: string;
  readonly client?: S3Client;
  /** 测试注入点；生产缺省使用 AWS SDK S3 presigner。 */
  readonly presign?: (client: S3Client, command: GetObjectCommand, expiresIn: number) => Promise<string>;
  readonly now?: () => Date;
}

export interface ActivityExportAwsPorts {
  readonly storage: {
    put(input: { readonly key: string; readonly body: string; readonly contentType: string }): Promise<void>;
  };
  readonly urlSigner: {
    sign(input: { readonly key: string; readonly expiresAt: Date }): Promise<string>;
  };
}

export function createS3ActivityExportPorts(config: S3ActivityExportConfig): ActivityExportAwsPorts {
  const client = config.client ?? new S3Client(config.region ? { region: config.region } : {});
  const now = config.now ?? (() => new Date());
  const presign =
    config.presign ??
    ((s3: S3Client, command: GetObjectCommand, expiresIn: number) => getSignedUrl(s3, command, { expiresIn }));

  return {
    storage: {
      async put({ key, body, contentType }) {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
          }),
        );
      },
    },
    urlSigner: {
      async sign({ key, expiresAt }) {
        const seconds = Math.ceil((expiresAt.getTime() - now().getTime()) / 1000);
        const expiresIn = Math.max(1, Math.min(MAX_PRESIGN_SECONDS, seconds));
        return presign(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), expiresIn);
      },
    },
  };
}
