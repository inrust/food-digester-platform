import {
  createAwsIotProvisioningClient,
  createKmsDataKeyProvider,
  createProjectCaCertificateIssuer,
  resolveDatabaseUrl,
} from '@fdp/aws-clients';
import { CERTIFICATE_PACKAGE_MAX_CLAIMS, CERTIFICATE_PACKAGE_RETENTION_SECONDS, SecurePackageService } from '@fdp/auth';
import { createPrismaClient } from '@fdp/database';
import { createOnboardingRequestHandler, createOnboardingStatusHandler } from '../onboarding/index.js';
import { ProvisioningService } from '../provisioning/service.js';
import {
  createDeviceOnboardingLambdaHandler,
  type ApiGatewayOnboardingEvent,
  type ApiGatewayOnboardingResult,
} from './device-onboarding-lambda.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let runtimeHandler: ((event: ApiGatewayOnboardingEvent) => Promise<ApiGatewayOnboardingResult>) | undefined;

async function initialize() {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const keyProvider = createKmsDataKeyProvider({ keyId: required('CERT_PACKAGE_KEY_ARN'), region });
  const certificateValiditySeconds = Number(process.env.CERTIFICATE_VALIDITY_SECONDS ?? 31_536_000);
  const iot = createAwsIotProvisioningClient({
    region,
    certificateIssuer: createProjectCaCertificateIssuer({
      secretId: required('DEVICE_CA_SECRET_ID'),
      validitySeconds: certificateValiditySeconds,
      region,
    }),
  });
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
    iot,
    keyProvider,
    config: {
      region,
      accountId: required('FDP_AWS_ACCOUNT_ID'),
      certificateValiditySeconds,
    },
  });
  return createDeviceOnboardingLambdaHandler({
    request: createOnboardingRequestHandler({ client }),
    status: createOnboardingStatusHandler({
      client,
      securePackage,
      mqttEndpoint: await iot.getDataEndpoint(),
      restEndpoint: required('DEVICE_API_BASE_URL'),
      deliveryRecovery: provisioning,
    }),
  });
}

export async function handler(event: ApiGatewayOnboardingEvent): Promise<ApiGatewayOnboardingResult> {
  runtimeHandler ??= await initialize();
  return runtimeHandler(event);
}
