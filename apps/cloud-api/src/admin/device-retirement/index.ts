export { createAdminDeviceRetirementHandlers } from './handler.js';
export type { AdminDeviceRetirementHandlerDeps, AdminDeviceRetirementHandlers } from './handler.js';
export { ADMIN_RETIREMENT_ERROR_HTTP_STATUS, AdminRetirementError } from './errors.js';
export type { AdminRetirementErrorCode } from './errors.js';
export {
  DEVICE_RETIRED_NOTIFICATION,
  RETIREABLE_LIFECYCLES,
  REVOCABLE_LICENSE_STATUSES,
  forceCompleteRetirement,
  evaluateRetirementTimeouts,
  parseForceCompleteBody,
  parseRetireBody,
  retireDevice,
} from './service.js';
export type { RetirementRecordView, RetirementTimeoutEvaluation, RetirementView } from './service.js';
