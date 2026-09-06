import { createAwsIotProvisioningClient, createKmsDataKeyProvider, resolveDatabaseUrl } from '@fdp/aws-clients';
import { CERTIFICATE_PACKAGE_MAX_CLAIMS, CERTIFICATE_PACKAGE_RETENTION_SECONDS, SecurePackageService } from '@fdp/auth';
import { createPrismaClient } from '@fdp/database';
import { ProvisioningService } from '../provisioning/service.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let sweep: (() => Promise<SweepResult>) | undefined;

interface SweepResult {
  readonly recoveredCertificateIds: readonly string[];
  readonly failedCertificateIds: readonly string[];
  readonly exhaustedBatchBudget: boolean;
}

async function initialize(): Promise<() => Promise<SweepResult>> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const keyProvider = createKmsDataKeyProvider({ keyId: required('CERT_PACKAGE_KEY_ARN'), region });
  const securePackage = new SecurePackageService({
    db: client,
    keyProvider,
    config: {
      retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS,
      maxClaims: CERTIFICATE_PACKAGE_MAX_CLAIMS,
    },
  });
  const provisioning = new ProvisioningService({
    client,
    iot: createAwsIotProvisioningClient({ region }),
    keyProvider,
    config: {
      region,
      accountId: required('FDP_AWS_ACCOUNT_ID'),
      certificateValiditySeconds: Number(process.env.CERTIFICATE_VALIDITY_SECONDS ?? 31_536_000),
    },
  });
  return async () => {
    const recoveredCertificateIds: string[] = [];
    const failedCertificateIds: string[] = [];
    const batchSize = 100;
    const maxBatches = 10;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const expired = await securePackage.findExpiredPackageIds(batchSize);
      for (const certificateId of expired) {
        try {
          await provisioning.recoverExpiredCertificate(certificateId);
          recoveredCertificateIds.push(certificateId);
        } catch {
          failedCertificateIds.push(certificateId);
        }
      }
      if (expired.length < batchSize) {
        return { recoveredCertificateIds, failedCertificateIds, exhaustedBatchBudget: false };
      }
    }
    return { recoveredCertificateIds, failedCertificateIds, exhaustedBatchBudget: true };
  };
}

/** SEC-01 EventBridge 生产入口：过期包持久化恢复意图后执行撤证、清包与重签。 */
export async function handler(): Promise<SweepResult> {
  sweep ??= await initialize();
  return sweep();
}
