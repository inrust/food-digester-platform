import { withDataPathTrace, observeDataPathPhase, createRedactingLogger } from '@fdp/observability';
import {
  createAwsIotProvisioningClient,
  createKmsDataKeyProvider,
  createS3MediaObjectStorage,
  createSqsJsonSender,
  resolveDatabaseUrl,
} from '@fdp/aws-clients';
import { CERTIFICATE_PACKAGE_MAX_CLAIMS, CERTIFICATE_PACKAGE_RETENTION_SECONDS, SecurePackageService } from '@fdp/auth';
import { createPrismaClient } from '@fdp/database';
import {
  getDailyUploadQuotaPerDevice,
  getDownloadUrlTtlSeconds,
  getMaxSizeKb,
  getMediaTypes,
  getUploadUrlTtlSeconds,
} from '@fdp/contracts/media/media-upload-policy.js';
import { createBusinessDispatcher } from '../ingest/dispatcher.js';
import { createIngestionHandler, type SqsBatchEventLike, type SqsBatchResponseLike } from '../ingest/handler.js';

const logger = createRedactingLogger(console);

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let runtimeHandler: ((event: SqsBatchEventLike) => Promise<SqsBatchResponseLike>) | undefined;

async function initialize() {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const securePackage = new SecurePackageService({
    db: client,
    keyProvider: createKmsDataKeyProvider({ keyId: required('CERT_PACKAGE_KEY_ARN'), region }),
    config: {
      retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS,
      maxClaims: CERTIFICATE_PACKAGE_MAX_CLAIMS,
    },
  });
  const quarantine = createSqsJsonSender({ queueUrl: required('QUARANTINE_QUEUE_URL'), region });
  return createIngestionHandler({
    client,
    quarantine,
    onValidated: createBusinessDispatcher({
      client,
      securePackage,
      certificateRevoker: createAwsIotProvisioningClient({ region }),
      mediaStorage: createS3MediaObjectStorage({ bucket: required('MEDIA_BUCKET_NAME'), region }),
      mediaUploadPolicy: {
        getMediaTypes,
        getMaxSizeKb: (mediaType) =>
          mediaType === 'IMAGE' || mediaType === 'VIDEO' ? getMaxSizeKb(mediaType) : undefined,
        getDailyUploadQuotaPerDevice,
        getUploadUrlTtlSeconds,
        getDownloadUrlTtlSeconds,
      },
    }),
  });
}

export async function handler(
  event: SqsBatchEventLike,
  context?: { readonly awsRequestId?: string },
): Promise<SqsBatchResponseLike> {
  return withDataPathTrace(
    { ...(context?.awsRequestId ? { lambdaRequestId: context.awsRequestId } : {}), coldStart: !runtimeHandler },
    async () => {
      runtimeHandler ??= await observeDataPathPhase('runtime-initialize', initialize);
      return runtimeHandler(event);
    },
    (row) => logger.info(JSON.stringify(row)),
  );
}
