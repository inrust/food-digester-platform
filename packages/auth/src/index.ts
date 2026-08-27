/**
 * @fdp/auth（AUTH-01/02）：Cognito JWT 认证授权 + Onboarding Token 认证。
 *
 * AUTH-01：认证 Guard（createCognitoAuthenticator）、授权 Decorator（withAuthorization）、
 * 集中式权限矩阵（PERMISSION_MATRIX）、角色模型与错误类型。
 * AUTH-02：Onboarding Token 签发/校验/撤销/核销、限频保护与 withOnboardingAuth 中间件。
 * 后端授权是唯一可信来源；前端仅消费角色显示名（FE-01/FE-16）。
 */
export {
  AuthError,
  AUTH_ERROR_DEFAULT_MESSAGE,
  AUTH_ERROR_HTTP_STATUS,
  forbidden,
  rateLimited,
  unauthenticated,
  validationFailed,
} from './errors.js';
export type { AuthErrorCode } from './errors.js';
export { actorTypeOf, isRole, CUSTOMER_ROLES, PLATFORM_ROLES, ROLES } from './roles.js';
export type { ActorContext, ActorType, CustomerRole, PlatformRole, Role } from './roles.js';
export { hasPermission, permissionsOf, PERMISSION_MATRIX, PERMISSIONS } from './permissions.js';
export type { Permission } from './permissions.js';
export { createCognitoAuthenticator } from './cognito.js';
export type { CognitoAuthenticator, CognitoAuthenticatorConfig } from './cognito.js';
export { assertCustomerScope, requirePermission, withAuthorization } from './guard.js';
export type { AuthenticatedRequest, AuthorizationRule } from './guard.js';

// ---------- AUTH-02 Onboarding Token ----------
export {
  fingerprintOfHash,
  generateOnboardingToken,
  hashOnboardingToken,
  isWellFormedOnboardingToken,
  ONBOARDING_TOKEN_PREFIX,
  tokenFingerprint,
} from './onboarding/token.js';
export {
  findOnboardingTokenByHash,
  issueOnboardingToken,
  markOnboardingTokenUsed,
  revokeOnboardingToken,
} from './onboarding/repository.js';
export type { IssuedOnboardingToken, OnboardingTokenRecord } from './onboarding/repository.js';
export { verifyOnboardingToken } from './onboarding/verifier.js';
export type { OnboardingAuthContext, VerifyOnboardingTokenOptions } from './onboarding/verifier.js';
export { createRateLimiter, InMemoryRateLimitStore } from './onboarding/rate-limit.js';
export type { RateLimiter, RateLimitRule, RateLimitStore } from './onboarding/rate-limit.js';
export { withOnboardingAuth } from './onboarding/guard.js';
export type { OnboardingGuardOptions } from './onboarding/guard.js';

// ---------- AUTH-03 Device mTLS ----------
export { certificateFingerprintFromPem } from './device/mtls-context.js';
export type { ClientCertIdentity } from './device/mtls-context.js';
export { CERT_STATUS_ACTIVE, verifyDeviceCertificate } from './device/verifier.js';
export type { DeviceAuthContext, VerifyDeviceCertificateOptions } from './device/verifier.js';
export { withDeviceAuth } from './device/guard.js';
export type { DeviceAuthGuardOptions } from './device/guard.js';
