export { createAdminCustomerHandlers } from './handler.js';
export type { AdminCustomerHandlerDeps, AdminCustomerHandlers } from './handler.js';
export {
  ADMIN_CUSTOMER_ERROR_HTTP_STATUS,
  AdminCustomerError,
  alreadySuspended,
  customerNotFound,
  deleteConstrained,
  validationFailed,
  versionConflict,
} from './errors.js';
export type { AdminCustomerErrorCode } from './errors.js';
export {
  CUSTOMER_STATUSES,
  EFFECTIVE_LICENSE_STATUSES,
  INACTIVE_DEVICE_LIFECYCLES,
  countActiveDevices,
  countEffectiveLicenses,
  findCustomerById,
  listCustomers,
  toCustomerDto,
  updateCustomerWithVersion,
} from './repository.js';
export type { CustomerDto, CustomerListOptions, CustomerRecord, CustomerStatus } from './repository.js';
export {
  CUSTOMER_NAME_MAX_LENGTH,
  createCustomer,
  deactivateCustomer,
  deleteCustomer,
  parseCustomerName,
  updateCustomer,
} from './service.js';
export type { CustomerWriteInput } from './service.js';
