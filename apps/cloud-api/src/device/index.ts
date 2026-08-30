/**
 * device 模块导出（BE-CERT-01/02、BE-SYNC-01/02）。
 */
export { createCertificateStatusHandler, deriveCertificateStatus } from './certificate-status.js';
export type {
  CertificateStatusHandlerDeps,
  CertificateStatusRequest,
  CertificateStatusResponse,
  CertificateStatusView,
  ExternalCertificateStatus,
} from './certificate-status.js';
export { CertificateRotationError, ROTATION_ERROR_HTTP_STATUS, rotateCertificate } from './certificate-rotate.js';
export type { RotationConfig, RotationErrorCode, RotationResult, RotationServiceDeps } from './certificate-rotate.js';
export { createCertificateRotateHandler } from './rotate-handler.js';
export type {
  CertificateRotateHandlerDeps,
  CertificateRotateRequest,
  CertificateRotateResponse,
} from './rotate-handler.js';
export {
  COMPLETION_DEVICE_CONFIRM,
  DEACTIVATE_ERROR_HTTP_STATUS,
  DeviceDeactivateError,
  RETIREMENT_CONFIRMED,
  RETIREMENT_PENDING,
  confirmDeactivation,
  verifyDeactivateIdentity,
} from './deactivate.js';
export type {
  DeactivateErrorCode,
  DeactivateIdentity,
  DeactivationResult,
  RevokedCertificateSummary,
} from './deactivate.js';
export { createDeviceDeactivateHandler } from './deactivate-handler.js';
export type {
  DeviceDeactivateHandlerDeps,
  DeviceDeactivateRequest,
  DeviceDeactivateResponse,
} from './deactivate-handler.js';
export {
  DEVICE_SYNC_ERROR_HTTP_STATUS,
  DeviceSyncError,
  SYNC_INTERVAL_ACTIVE_SECONDS,
  SYNC_INTERVAL_SUSPENDED_SECONDS,
  buildDeviceSyncSnapshot,
  computeSnapshotEtag,
  deriveSyncIntervalSeconds,
  parseSyncRequest,
} from './sync.js';
export type {
  DeviceSyncDeps,
  DeviceSyncErrorCode,
  DeviceSyncSnapshot,
  SyncAssignmentView,
  SyncDeviceUserView,
  SyncDeviceView,
  SyncLicenseView,
  SyncOperationalStatusView,
} from './sync.js';
export { createDeviceSyncHandler } from './sync-handler.js';
export type { DeviceSyncHandlerDeps, DeviceSyncRequest, DeviceSyncResponse } from './sync-handler.js';
