/**
 * admin-web（FE-01）：登录、会话与权限框架。
 *
 * 事实源：AUTH-01（角色/JWT 语义）、CT-05（错误包络）、CT-06（routeId/菜单角色）、
 * DEC-012（角色封闭映射与显示名）、IAC-01（User Pool 仅 USER_SRP_AUTH + 软件令牌 MFA）。
 * 前端权限仅为体验层，授权唯一可信来源是后端。
 */
export const APP_NAME = 'admin-web';

// 认证（Cognito SRP / Challenge / 忘记密码 / 登出 / 刷新）
export { CHALLENGE_NAMES, CognitoIdpError, createCognitoIdpClient, createHttpIdpFetch } from './auth/cognito-idp.js';
export type {
  AuthChallenge,
  AuthenticationResult,
  CognitoErrorCode,
  CognitoIdpClient,
  CognitoIdpClientConfig,
  IdpAuthReply,
  IdpFetch,
  IdpHttpResponse,
} from './auth/cognito-idp.js';
export {
  computePasswordVerifierClaim,
  formatCognitoTimestamp,
  generateSrpEphemeral,
  padHex,
  SrpError,
  SRP_N_HEX,
  userPoolNameOf,
} from './auth/srp.js';
export type { PasswordVerifierClaim, PasswordVerifierInput, SrpEphemeral } from './auth/srp.js';
export { AuthFlow, AuthFlowError } from './auth/auth-flow.js';
export type { AuthFlowDeps, LoginOutcome, MfaChallengeKind } from './auth/auth-flow.js';

// 会话
export { decodeJwtPayload, jwtExpiresAtMs, SessionTokenError } from './session/jwt.js';
export { InMemorySessionStore } from './session/session-store.js';
export type { SessionStore } from './session/session-store.js';
export {
  buildSessionFromTokens,
  SessionEstablishError,
  SessionExpiredError,
  SessionManager,
} from './session/session-manager.js';
export type {
  EstablishedSession,
  SessionClearReason,
  SessionManagerDeps,
  SessionSnapshot,
} from './session/session-manager.js';

// API 客户端
export { createApiClient, createHttpApiFetch } from './api/http-client.js';
export type { ApiClient, ApiClientDeps, ApiFetch, ApiFetchResponse, ApiRequestOptions } from './api/http-client.js';
export { ApiClientError, ForbiddenError, UnauthenticatedError } from './api/errors.js';

// 路由守卫与角色菜单
export { APP_ROUTES, findRoute, FORBIDDEN_PATH, LOGIN_PATH } from './router/routes.js';
export type { AppRoute, MenuGroupId } from './router/routes.js';
export { resolveRoute } from './router/guard.js';
export type { GuardVerdict } from './router/guard.js';
export {
  canAccessRoute,
  FROZEN_ROLE_DISPLAY_NAMES,
  homePathForRoles,
  MENU_GROUP_LABELS,
  menuForRoles,
  roleDisplayName,
} from './menu/menu.js';
export type { MenuLeaf, MenuNode } from './menu/menu.js';

// ---------- FE-02 壳层 ----------
export { AppShell } from './shell/AppShell.js';
export type { AppShellProps } from './shell/AppShell.js';
export { Sidebar } from './shell/Sidebar.js';
export type { SidebarProps } from './shell/Sidebar.js';
export { Topbar } from './shell/Topbar.js';
export type { TopbarProps } from './shell/Topbar.js';
export { breadcrumbsFor } from './shell/breadcrumb.js';
export type { Crumb } from './shell/breadcrumb.js';

// ---------- FE-02 通用组件 ----------
export { ToastHost, TOAST_AUTO_DISMISS_MS, useToastQueue } from './components/Toast.js';
export type { ToastHostProps, ToastQueue } from './components/Toast.js';
export { toastReducer } from './components/toast-store.js';
export type { ToastAction, ToastItem, ToastKind } from './components/toast-store.js';
export { ConfirmDialog } from './components/ConfirmDialog.js';
export type { ConfirmDialogProps } from './components/ConfirmDialog.js';
export { classifyError, ErrorNotice } from './components/ErrorNotice.js';
export type { ErrorNoticeModel, ErrorNoticeProps, ErrorNoticeVariant } from './components/ErrorNotice.js';
export { CursorTable } from './components/CursorTable.js';
export type { CursorTableColumn, CursorTableProps } from './components/CursorTable.js';
export { applyScopeChange, EMPTY_SCOPE_FILTER } from './components/filter-state.js';
export type { ScopeFilterLevel, ScopeFilterValue } from './components/filter-state.js';
export { ScopeFilter } from './components/ScopeFilter.js';
export type { FilterOption, ScopeFilterProps } from './components/ScopeFilter.js';
export { CustomerScope } from './components/CustomerScope.js';
export type { CustomerScopeProps } from './components/CustomerScope.js';
export { DEFAULT_TIME_ZONE, formatInTimeZone, TimeText } from './components/TimeText.js';
export type { TimeTextProps } from './components/TimeText.js';
export { AxisBadge, AXIS_LABELS, FourAxisBadges } from './components/FourAxisBadge.js';
export type { FourAxisStatusValue, StatusAxis } from './components/FourAxisBadge.js';
