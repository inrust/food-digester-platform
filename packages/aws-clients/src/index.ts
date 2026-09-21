/**
 * @fdp/aws-clients：AWS 服务客户端与策略构造。
 * AUTH-04：IoT 单设备最小权限 Policy 生成器；SEC-01：KMS 数据密钥提供者。
 */
export const PACKAGE_NAME = '@fdp/aws-clients';

export { buildDevicePolicy, DOWNLINK_TOPIC_TYPES, TOPIC_PATTERN, UPLINK_TOPIC_TYPES } from './iot-device-policy.js';
export type { DevicePolicy, DevicePolicyInput, IotPolicyDocument, IotPolicyStatement } from './iot-device-policy.js';
export { createKmsDataKeyProvider } from './kms-data-key-provider.js';
export type { DataKeyProvider, GeneratedDataKey, KmsDataKeyProviderConfig } from './kms-data-key-provider.js';
export { resolveDatabaseUrl, resolveSecretString } from './database-secret.js';
export type { DatabaseSecretResolverConfig } from './database-secret.js';
export { createAwsIotProvisioningClient } from './iot-provisioning-client.js';
export type {
  AwsIotCertificateResult,
  AwsIotProvisioningClient,
  AwsIotProvisioningClientConfig,
} from './iot-provisioning-client.js';
export { createSqsArchiveSender } from './sqs-archive-sender.js';
export type { ArchiveEventMessage, ArchiveEventSender, SqsArchiveSenderConfig } from './sqs-archive-sender.js';
export { createIotDataPublisher } from './iot-data-publisher.js';
export type { IotDataPublisherConfig, MqttMessageSender, MqttPublishInput } from './iot-data-publisher.js';
export { createSqsJsonSender } from './sqs-json-sender.js';
export type { JsonMessageSender, SqsJsonSenderConfig } from './sqs-json-sender.js';
export { createS3ArchiveObjectReader, createS3ArchiveObjectStore } from './s3-archive-store.js';
export type {
  ArchiveObjectReaderPort,
  ArchiveObjectStorePort,
  S3ArchiveObjectStoreConfig,
} from './s3-archive-store.js';
export { createS3MediaObjectStorage } from './s3-media-object-storage.js';
export type { MediaObjectStoragePort, S3MediaObjectStorageConfig } from './s3-media-object-storage.js';
export { createS3MediaUrlSigner } from './s3-media-url-signer.js';
export type { MediaUrlSignerPort, S3MediaUrlSignerConfig } from './s3-media-url-signer.js';
export { createCognitoAdminPort } from './cognito-admin.js';
export type { CognitoAdminConfig, CognitoAdminPort } from './cognito-admin.js';
export { createS3ActivityExportPorts } from './s3-activity-export.js';
export type { ActivityExportAwsPorts, S3ActivityExportConfig } from './s3-activity-export.js';
export {
  createKmsFirmwareSignatureVerifier,
  createOtaFirmwareS3Ports,
  OTA_FIRMWARE_SIGNATURE_ALGORITHM,
  OTA_FIRMWARE_TRUST_ROOT,
} from './ota-firmware.js';
export type { KmsFirmwareSignatureVerifierConfig, OtaFirmwareS3Config, OtaFirmwareS3Ports } from './ota-firmware.js';
