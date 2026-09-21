import {
  createAwsIotProvisioningClient,
  createKmsDataKeyProvider,
  createProjectCaCertificateIssuer,
  resolveDatabaseUrl,
} from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { processOnboardingProvisioningJobs } from '../provisioning/worker.js';
import { ProvisioningService } from '../provisioning/service.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let run: (() => ReturnType<typeof processOnboardingProvisioningJobs>) | undefined;

async function initialize() {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const certificateValiditySeconds = Number(process.env.CERTIFICATE_VALIDITY_SECONDS ?? 31_536_000);
  const provisioner = new ProvisioningService({
    client,
    iot: createAwsIotProvisioningClient({
      region,
      certificateIssuer: createProjectCaCertificateIssuer({
        secretId: required('DEVICE_CA_SECRET_ID'),
        validitySeconds: certificateValiditySeconds,
        region,
      }),
    }),
    keyProvider: createKmsDataKeyProvider({ keyId: required('CERT_PACKAGE_KEY_ARN'), region }),
    config: {
      region,
      accountId: required('FDP_AWS_ACCOUNT_ID'),
      certificateValiditySeconds,
    },
  });
  return () => processOnboardingProvisioningJobs({ client, provisioner });
}

export async function handler() {
  run ??= await initialize();
  return run();
}
