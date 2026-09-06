/**
 * @fdp/aws-clients：AWS 服务客户端与策略构造。
 * AUTH-04：IoT 单设备最小权限 Policy 生成器；SEC-01：KMS 数据密钥提供者。
 */
export const PACKAGE_NAME = '@fdp/aws-clients';

export { buildDevicePolicy, DOWNLINK_TOPIC_TYPES, TOPIC_PATTERN, UPLINK_TOPIC_TYPES } from './iot-device-policy.js';
export type { DevicePolicy, DevicePolicyInput, IotPolicyDocument, IotPolicyStatement } from './iot-device-policy.js';
export { createKmsDataKeyProvider } from './kms-data-key-provider.js';
export type { DataKeyProvider, GeneratedDataKey, KmsDataKeyProviderConfig } from './kms-data-key-provider.js';
export { resolveDatabaseUrl } from './database-secret.js';
export type { DatabaseSecretResolverConfig } from './database-secret.js';
export { createAwsIotProvisioningClient } from './iot-provisioning-client.js';
export type {
  AwsIotCertificateResult,
  AwsIotProvisioningClient,
  AwsIotProvisioningClientConfig,
} from './iot-provisioning-client.js';
export { createSqsArchiveSender } from './sqs-archive-sender.js';
export type { ArchiveEventMessage, ArchiveEventSender, SqsArchiveSenderConfig } from './sqs-archive-sender.js';
export { createS3ArchiveObjectStore } from './s3-archive-store.js';
export type { ArchiveObjectStorePort, S3ArchiveObjectStoreConfig } from './s3-archive-store.js';
