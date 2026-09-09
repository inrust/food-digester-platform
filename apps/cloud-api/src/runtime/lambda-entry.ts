import {
  createAwsIotProvisioningClient,
  createKmsFirmwareSignatureVerifier,
  createOtaFirmwareS3Ports,
  createS3ActivityExportPorts,
  resolveDatabaseUrl,
  resolveSecretString,
} from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { createAdminOnboardingHandlers } from '../admin/onboarding/handler.js';
import { createAdminCertificateRotationHandler } from '../admin/certificate-rotation/handler.js';
import { createAdminReplayHandlers } from '../admin/replay/handler.js';
import { createAdminCustomerHandlers } from '../admin/customer/handler.js';
import { createAdminSiteHandlers } from '../admin/site/handler.js';
import { createAdminDeviceHandlers } from '../admin/device/handler.js';
import { createAdminDeviceAssignmentHandlers } from '../admin/device-assignment/handler.js';
import { createAdminDeviceStatusHandlers } from '../admin/device-status/handler.js';
import { createAdminDeviceRetirementHandlers } from '../admin/device-retirement/handler.js';
import { createAdminDeviceConsoleHandlers } from '../admin/device-console/handler.js';
import { createAdminLicenseHandlers } from '../admin/license/handler.js';
import { createAdminContractHandlers } from '../admin/contract/handler.js';
import { createAdminContractDeviceHandlers } from '../admin/contract-device/handler.js';
import { createAdminConfigurationHandlers } from '../admin/configuration/handler.js';
import { createAdminConsumableHandlers } from '../consumable/handler.js';
import { createAdminConsumableRequestHandlers } from '../consumable/request-handler.js';
import { createAdminDeviceUserHandlers } from '../admin/device-user/handler.js';
import { createAdminAlarmHandlers } from '../admin/alarm/handler.js';
import { createAdminEsgHandlers } from '../admin/esg/handler.js';
import { createAdminCommandHandlers } from '../admin/command/handler.js';
import { createAdminOtaPackageHandlers } from '../admin/ota-package/handler.js';
import { createAdminOtaCampaignHandlers } from '../admin/ota-campaign/handler.js';
import otaSignaturePolicy from '@fdp/contracts/security/ota-package-signature-policy.json' with { type: 'json' };
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
  const activityExportPorts = createS3ActivityExportPorts({ bucket: required('EXPORT_BUCKET_NAME'), region });
  const licenseSigningKey = await resolveSecretString({
    secretArn: required('LICENSE_SIGNING_KEY_SECRET_ARN'),
    region,
  });
  const iot = createAwsIotProvisioningClient({ region });
  const ota = createOtaFirmwareS3Ports({ bucket: required('OTA_BUCKET_NAME'), region });
  const routes = {
    onboarding: createAdminOnboardingHandlers({ client }),
    certificateRotation: createAdminCertificateRotationHandler({ client }),
    replay: createAdminReplayHandlers({ client }),
    customers: createAdminCustomerHandlers({ client }),
    sites: createAdminSiteHandlers({ client }),
    devices: createAdminDeviceHandlers({ client }),
    assignments: createAdminDeviceAssignmentHandlers({ client }),
    statuses: createAdminDeviceStatusHandlers({ client }),
    retirements: createAdminDeviceRetirementHandlers({ client, iot }),
    console: createAdminDeviceConsoleHandlers({ client, ...activityExportPorts }),
    licenses: createAdminLicenseHandlers({ client, signingKey: licenseSigningKey }),
    contracts: createAdminContractHandlers({ client }),
    contractDevices: createAdminContractDeviceHandlers({ client }),
    configurations: createAdminConfigurationHandlers({ client }),
    consumables: createAdminConsumableHandlers({ client }),
    consumableRequests: createAdminConsumableRequestHandlers({ client }),
    deviceUsers: createAdminDeviceUserHandlers({ client }),
    alarms: createAdminAlarmHandlers({ client }),
    esg: createAdminEsgHandlers({ client, ...activityExportPorts }),
    commands: createAdminCommandHandlers({ client }),
    otaPackages: createAdminOtaPackageHandlers({
      client,
      storage: ota.storage,
      uploadUrlSigner: ota.uploadUrlSigner,
      signaturePolicy: {
        getSignatureAlgorithm: () => otaSignaturePolicy.signature.algorithm,
        getSignatureEncoding: () => otaSignaturePolicy.signature.encoding,
        getSignaturePayloadFields: () => otaSignaturePolicy.payload.fields,
        getSignatureTrustRoot: () => otaSignaturePolicy.signature.trustRoot,
      },
      signatureVerifier: createKmsFirmwareSignatureVerifier({ keyId: required('OTA_SIGNING_KEY_ARN'), region }),
    }),
    otaCampaigns: createAdminOtaCampaignHandlers({ client }),
  };
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
