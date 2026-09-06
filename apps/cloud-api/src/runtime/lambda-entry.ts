import { createAwsIotProvisioningClient, createKmsDataKeyProvider, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { createAdminOnboardingHandlers } from '../admin/onboarding/handler.js';
import { ProvisioningService } from '../provisioning/service.js';
import {
  createAdminLambdaRouter,
  createAdminRoute,
  type ApiGatewayAdminEvent,
  type ApiGatewayAdminResult,
} from './admin-lambda.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let runtimeHandler: ((event: ApiGatewayAdminEvent) => Promise<ApiGatewayAdminResult>) | undefined;

async function initialize() {
  const region = required('AWS_REGION');
  const databaseUrl = await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region });
  const client = createPrismaClient(databaseUrl);
  const provisioning = new ProvisioningService({
    client,
    iot: createAwsIotProvisioningClient({ region }),
    keyProvider: createKmsDataKeyProvider({ keyId: required('CERT_PACKAGE_KEY_ARN'), region }),
    config: {
      region,
      accountId: required('FDP_AWS_ACCOUNT_ID'),
      certificateValiditySeconds: Number(process.env.CERTIFICATE_VALIDITY_SECONDS ?? 31_536_000),
    },
  });
  const routes = { onboarding: createAdminOnboardingHandlers({ client, provisioningTrigger: provisioning }) };
  return createAdminLambdaRouter(
    { region, userPoolId: required('USER_POOL_ID'), clientId: required('USER_POOL_CLIENT_ID') },
    (event) => createAdminRoute(event, routes),
  );
}

/** AWS Lambda 生产入口：冷启动完成 Secret/DB/AWS 适配器接线，热启动复用连接。 */
export async function handler(event: ApiGatewayAdminEvent): Promise<ApiGatewayAdminResult> {
  runtimeHandler ??= await initialize();
  return runtimeHandler(event);
}
