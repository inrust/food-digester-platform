/** BE-IOT-09：Media Bucket 的 HeadObject + 流式 SHA-256 生产适配器。 */
import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface S3MediaObjectStorageConfig {
  readonly bucket: string;
  readonly client?: S3Client;
  readonly region?: string;
}

export interface MediaObjectStoragePort {
  statObject(key: string): Promise<{ readonly sizeBytes: number } | null>;
  computeSha256(key: string): Promise<string | null>;
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    candidate?.name === 'NoSuchKey' || candidate?.name === 'NotFound' || candidate?.$metadata?.httpStatusCode === 404
  );
}

export function createS3MediaObjectStorage(config: S3MediaObjectStorageConfig): MediaObjectStoragePort {
  const client = config.client ?? new S3Client(config.region ? { region: config.region } : {});
  return {
    async statObject(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return typeof result.ContentLength === 'number' ? { sizeBytes: result.ContentLength } : null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async computeSha256(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        if (!result.Body) return null;
        const hash = createHash('sha256');
        for await (const chunk of result.Body as AsyncIterable<Uint8Array>) hash.update(chunk);
        return hash.digest('hex');
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}
