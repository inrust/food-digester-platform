import { createAwsIotProvisioningClient, createKmsDataKeyProvider, resolveDatabaseUrl } from '@fdp/aws-clients';
import { CERTIFICATE_PACKAGE_MAX_CLAIMS, CERTIFICATE_PACKAGE_RETENTION_SECONDS, SecurePackageService } from '@fdp/auth';
import { createPrismaClient } from '@fdp/database';
import { evaluateOnboardingDeadlines, type OnboardingDeadlineBatchResult } from '../onboarding-completion.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let evaluate: (() => Promise<OnboardingDeadlineBatchResult>) | undefined;

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
  const certificateRevoker = createAwsIotProvisioningClient({ region });
  return () => evaluateOnboardingDeadlines({ client, securePackage, certificateRevoker });
}

export async function handler(): Promise<OnboardingDeadlineBatchResult> {
  evaluate ??= await initialize();
  return evaluate();
}
