/**
 * BE-CERT-03 admin/certificate-rotation 模块导出。
 */
export { createCertificateRotationRequest, ROTATION_REQUIRED_NOTIFICATION } from './service.js';
export type { CreateRotationRequestResult, RotationRequestRecord, RotationRequestView } from './service.js';
export { createAdminCertificateRotationHandler } from './handler.js';
export type { AdminCertificateRotationHandler, AdminCertificateRotationHandlerDeps } from './handler.js';
