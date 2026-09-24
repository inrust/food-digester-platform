import { PAGE_EN } from './pages.js';

/**
 * FE-19 en 语言资源（与 zh-CN key 集 parity 锁定，缺失检测为 0）。
 * 纪律：requestId 原文保留；协议枚举原文与业务数据不翻译。
 */
export const EN: Readonly<Record<string, string>> = {
  ...PAGE_EN,
  'auth.newPassword.badge': 'First sign-in',
  'auth.newPassword.title': 'Set a new sign-in password',
  'auth.newPassword.description':
    'Your temporary password has been verified. Create the new password you will use for future sign-ins before continuing.',
  'auth.newPassword.label': 'Create new password',
  'auth.newPassword.submit': 'Set new password and sign in',
  'auth.error.invalidCredentials': 'The username or password is incorrect. Check both and try again.',
  'auth.error.passwordResetRequired': 'This account requires a password reset. Use “Forgot password” to continue.',
  'auth.error.userNotConfirmed':
    'This account is not confirmed. Check the invitation email or contact an administrator.',
  'auth.error.codeMismatch': 'The verification code is incorrect. Check it and try again.',
  'auth.error.codeExpired': 'The verification code has expired. Go back and request a new code.',
  'auth.error.passwordTooShort': 'The new password is too short. Add more characters and try again.',
  'auth.error.passwordRequiresUppercase': 'The new password must contain at least one uppercase letter (A–Z).',
  'auth.error.passwordRequiresLowercase': 'The new password must contain at least one lowercase letter (a–z).',
  'auth.error.passwordRequiresNumber': 'The new password must contain at least one number (0–9).',
  'auth.error.passwordRequiresSymbol': 'The new password must contain at least one symbol, such as !, @, or #.',
  'auth.error.passwordPolicyViolation':
    'The new password does not meet the current password policy. Adjust its length and character mix, then try again.',
  'auth.error.passwordReuseNotAllowed': 'This password was used recently. Choose a different new password.',
  'auth.error.rateLimited': 'Too many attempts. Wait a while and try again.',
  'auth.error.network': 'The identity service cannot be reached. Check your network and try again.',
  'auth.error.newPasswordUnknown':
    'The new password could not be set. Try a different password; contact an administrator if the problem continues.',
  'auth.error.flowExpired': 'The sign-in flow has expired. Return to sign-in and start again.',
  'auth.error.accountConfiguration': 'The account permissions are misconfigured. Contact an administrator.',
  'auth.error.unknown': 'The sign-in request could not be completed. Try again or contact an administrator.',
  'ui.contractDeviceRequired':
    'Bind at least one eligible device before finishing. The draft is saved and recoverable in this step.',
  'ui.consumableThresholdLoading': 'Loading the consumable display threshold source…',
  'ui.consumableThresholdSetting':
    'Consumable display thresholds come from alarm.thresholds setting version v{version}.',
  'ui.consumableThresholdFallback':
    'Consumable display thresholds use the explicit 10%/30% fallback (reason: {reason}).',
  // ---------- Common ----------
  'common.loading': 'Loading…',
  'common.refresh': 'Refresh',
  'common.prevPage': 'Previous',
  'common.nextPage': 'Next',
  'common.empty': 'No data',
  'common.stale': 'Data may be stale',
  'common.dataTime': 'Data as of: ',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.reason': 'Reason',
  'common.reasonHint': 'Required; recorded in the audit log',
  'common.logout': 'Sign Out',
  'common.timeZone': 'Display Time Zone',
  'common.language': 'Language',
  'common.openNav': 'Open navigation',
  'common.breadcrumb': 'Breadcrumb',
  'common.mainMenu': 'Main menu',
  'common.pageNotFound': 'Page not found',
  'common.notification.unread': 'Notifications, {count} unread',
  'common.notification.none': 'Notifications, none unread',

  // ---------- Menu groups ----------
  'menu.group.device': 'Devices',
  'menu.group.esg': 'ESG',
  'menu.group.contract': 'Contracts',
  'menu.group.platform': 'Platform',

  // ---------- Menu items (pageState) ----------
  'menu.dashboard': 'Overview',
  'menu.device-view': 'View Devices',
  'menu.device-operate': 'Operate Devices',
  'menu.device-group': 'Device Groups',
  'menu.configurations': 'Configurations',
  'menu.device-consumable': 'Consumables',
  'menu.alarms': 'Alarms & Events',
  'menu.media': 'Media',
  'menu.esg-overview': 'ESG Overview',
  'menu.esg-device': 'Device ESG',
  'menu.contract-modify': 'Contracts',
  'menu.settings': 'User Management',
  'menu.customers': 'Customers',
  'menu.sites': 'Sites',
  'menu.licenses': 'Licenses',
  'menu.device-users': 'Device Users',
  'menu.audit-logs': 'Audit Logs',
  'menu.device-manage': 'Device Management',
  'menu.contract-new': 'New Contract',
  'menu.contract-detail': 'Contract Detail',
  'menu.ota-campaigns': 'OTA Campaigns',
  'menu.ota-packages': 'Firmware Packages',
  'menu.login': 'Sign In',
  'menu.forbidden': 'Access Denied',

  // ---------- Error mapping (API error codes; requestId kept verbatim) ----------
  'error.forbidden.title': 'Access Denied',
  'error.forbidden.detail':
    'Your role cannot view or modify this data. Contact an administrator if you believe this is a mistake.',
  'error.versionConflict.title': 'Modified by someone else',
  'error.versionConflict.detail': 'The data on this page is out of date. Refresh and try again.',
  'error.generic.title': 'Operation failed',
  'error.generic.detail': 'Network or service is temporarily unavailable. Please try again later.',
  'error.code.FORBIDDEN': 'Access denied',
  'error.code.UNAUTHENTICATED': 'Unauthenticated or session expired',
  'error.code.NOT_FOUND': 'Resource not found or inaccessible',
  'error.code.VERSION_CONFLICT': 'Data version conflict',
  'error.code.CONFLICT': 'Operation conflict',
  'error.code.VALIDATION_FAILED': 'Request validation failed',
  'error.code.INTERNAL_ERROR': 'Internal server error',
  'error.codeLabel': 'Error code: ',
} as const;
