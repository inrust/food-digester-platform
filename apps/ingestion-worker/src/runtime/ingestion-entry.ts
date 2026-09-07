import {
  createAwsIotProvisioningClient,
  createKmsDataKeyProvider,
  createSqsJsonSender,
  resolveDatabaseUrl,
} from '@fdp/aws-clients';
import { CERTIFICATE_PACKAGE_MAX_CLAIMS, CERTIFICATE_PACKAGE_RETENTION_SECONDS, SecurePackageService } from '@fdp/auth';
import { createPrismaClient } from '@fdp/database';
import { createBusinessDispatcher } from '../ingest/dispatcher.js';
import { createIngestionHandler, type SqsBatchEventLike, type SqsBatchResponseLike } from '../ingest/handler.js';

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
    }),
  });
}

export async function handler(event: SqsBatchEventLike): Promise<SqsBatchResponseLike> {
  runtimeHandler ??= await initialize();
  return runtimeHandler(event);
}
