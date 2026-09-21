import {
  createAwsIotProvisioningClient,
  createKmsDataKeyProvider,
  createProjectCaCertificateIssuer,
  createOtaFirmwareS3Ports,
  createS3MediaObjectStorage,
  createS3MediaUrlSigner,
  resolveDatabaseUrl,
} from '@fdp/aws-clients';
import { getMaintenanceSyncIntervalSeconds } from '@fdp/contracts/lifecycle/maintenance-behavior.js';
import { createPrismaClient } from '@fdp/database';
import {
  createCertificateRotateHandler,
  createCertificateStatusHandler,
  createDeviceDeactivateHandler,
  createDeviceSyncHandler,
} from '../device/index.js';
import { createDeviceOtaDownloadHandler } from '../ota/download.js';
import { createDeviceMediaHandler } from '../media/device-handler.js';
import {
  getDailyUploadQuotaPerDevice,
  getDownloadUrlTtlSeconds,
  getMaxSizeKb,
  getMediaTypes,
  getUploadUrlTtlSeconds,
} from '@fdp/contracts/media/media-upload-policy.js';
import {
  createDeviceApiLambdaHandler,
  type ApiGatewayDeviceEvent,
  type ApiGatewayDeviceResult,
} from './device-lambda.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

const positiveNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Lambda 环境变量 ${name} 必须为正数`);
  return value;
};

let runtimeHandler: ((event: ApiGatewayDeviceEvent) => Promise<ApiGatewayDeviceResult>) | undefined;

async function initialize() {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const certificateValiditySeconds = positiveNumber('CERTIFICATE_VALIDITY_SECONDS', 31_536_000);
  const iot = createAwsIotProvisioningClient({
    region,
    certificateIssuer: createProjectCaCertificateIssuer({
      secretId: required('DEVICE_CA_SECRET_ID'),
      validitySeconds: certificateValiditySeconds,
      region,
    }),
  });
  const keyProvider = createKmsDataKeyProvider({ keyId: required('CERT_PACKAGE_KEY_ARN'), region });
  const ota = createOtaFirmwareS3Ports({ bucket: required('OTA_BUCKET_NAME'), region });
  const mediaBucket = required('MEDIA_BUCKET_NAME');
  return createDeviceApiLambdaHandler({
    certificateStatus: createCertificateStatusHandler({
      client,
      expiringSoonDays: positiveNumber('CERTIFICATE_EXPIRING_SOON_DAYS', 30),
    }),
    certificateRotate: createCertificateRotateHandler({
      client,
      iot,
      keyProvider,
      config: {
        region,
        accountId: required('FDP_AWS_ACCOUNT_ID'),
        certificateValiditySeconds,
      },
    }),
    sync: createDeviceSyncHandler({ client, maintenanceSyncIntervalSeconds: getMaintenanceSyncIntervalSeconds() }),
    deactivate: createDeviceDeactivateHandler({ client, iot }),
    otaDownload: createDeviceOtaDownloadHandler({ client, objectUrlSigner: ota.downloadUrlSigner }),
    mediaUpload: createDeviceMediaHandler({
      client,
      storage: createS3MediaObjectStorage({ bucket: mediaBucket, region }),
      urlSigner: createS3MediaUrlSigner({ bucket: mediaBucket, region }),
      uploadPolicy: {
        getMediaTypes,
        getMaxSizeKb: (mediaType: string) =>
          getMediaTypes().includes(mediaType as ReturnType<typeof getMediaTypes>[number])
            ? getMaxSizeKb(mediaType as ReturnType<typeof getMediaTypes>[number])
            : undefined,
        getDailyUploadQuotaPerDevice,
        getUploadUrlTtlSeconds,
        getDownloadUrlTtlSeconds,
      },
    }),
  });
}

/** AWS Lambda 生产入口：冷启动完成 DB、AUTH-03、IoT/KMS 与冻结策略接线。 */
export async function handler(event: ApiGatewayDeviceEvent): Promise<ApiGatewayDeviceResult> {
  runtimeHandler ??= await initialize();
  return runtimeHandler(event);
}
