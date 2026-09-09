/** OTA 固件 S3 与 KMS 生产适配器。 */
import { createHash } from 'node:crypto';
import { VerifyCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export interface OtaFirmwareS3Config {
  readonly bucket: string;
  readonly region?: string;
  readonly client?: S3Client;
  readonly now?: () => Date;
  readonly presign?: (
    client: S3Client,
    command: GetObjectCommand | PutObjectCommand,
    expiresIn: number,
  ) => Promise<string>;
}

export interface OtaFirmwareS3Ports {
  readonly storage: {
    statObject(key: string): Promise<{ readonly sizeBytes: number } | null>;
    computeSha256(key: string): Promise<string | null>;
  };
  readonly uploadUrlSigner: {
    signUpload(input: { readonly key: string; readonly expiresAt: Date }): Promise<string>;
  };
  readonly downloadUrlSigner: {
    signDownload(input: { readonly key: string; readonly expiresAt: Date }): Promise<string>;
  };
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    candidate?.name === 'NoSuchKey' || candidate?.name === 'NotFound' || candidate?.$metadata?.httpStatusCode === 404
  );
}

export function createOtaFirmwareS3Ports(config: OtaFirmwareS3Config): OtaFirmwareS3Ports {
  const client = config.client ?? new S3Client(config.region ? { region: config.region } : {});
  const now = config.now ?? (() => new Date());
  const presign =
    config.presign ??
    ((s3: S3Client, command: GetObjectCommand | PutObjectCommand, expiresIn: number) =>
      getSignedUrl(s3, command, { expiresIn }));
  const expiresIn = (expiresAt: Date): number =>
    Math.max(1, Math.min(MAX_PRESIGN_SECONDS, Math.ceil((expiresAt.getTime() - now().getTime()) / 1000)));

  return {
    storage: {
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
    },
    uploadUrlSigner: {
      signUpload: ({ key, expiresAt }) =>
        presign(client, new PutObjectCommand({ Bucket: config.bucket, Key: key }), expiresIn(expiresAt)),
    },
    downloadUrlSigner: {
      signDownload: ({ key, expiresAt }) =>
        presign(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), expiresIn(expiresAt)),
    },
  };
}

export const OTA_FIRMWARE_SIGNATURE_ALGORITHM = 'RSASSA_PKCS1_V1_5_SHA_256' as const;
export const OTA_FIRMWARE_TRUST_ROOT = 'AWS_KMS_ASYMMETRIC_SIGNING_KEY' as const;

export interface KmsFirmwareSignatureVerifierConfig {
  readonly keyId: string;
  readonly region?: string;
  readonly client?: KMSClient;
}

/** DEC-022：KMS 非对称 RSA-2048/SHA-256 验签；签名在线路上使用 base64。 */
export function createKmsFirmwareSignatureVerifier(config: KmsFirmwareSignatureVerifierConfig) {
  const client = config.client ?? new KMSClient(config.region ? { region: config.region } : {});
  return {
    algorithmId: OTA_FIRMWARE_SIGNATURE_ALGORITHM,
    async verify(input: { payload: string; signature: string; trustRoot: string; encoding: string }) {
      if (input.trustRoot !== OTA_FIRMWARE_TRUST_ROOT || input.encoding !== 'base64') return false;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.signature)) return false;
      let signature: Buffer;
      try {
        signature = Buffer.from(input.signature, 'base64');
      } catch {
        return false;
      }
      if (signature.length !== 256) return false;
      const result = await client.send(
        new VerifyCommand({
          KeyId: config.keyId,
          Message: Buffer.from(input.payload, 'utf8'),
          MessageType: 'RAW',
          Signature: signature,
          SigningAlgorithm: OTA_FIRMWARE_SIGNATURE_ALGORITHM,
        }),
      );
      return result.SignatureValid === true;
    },
  };
}
