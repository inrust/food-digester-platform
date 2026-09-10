/**
 * FE-01 会话管理器：Token 生命周期、过期刷新、登出与 401 清会话。
 *
 * - 建立会话时从 ID Token 解析角色/Customer scope（失败关闭：未知角色组、平台与
 *   Customer 角色混绑、Customer 角色缺 scope 均拒绝建会话，与 AUTH-01 后端口径一致）；
 * - ensureFreshAccessToken：过期前 refreshSkewMs 内自动走 REFRESH_TOKEN_AUTH；
 *   刷新失败一律清会话并抛 SessionExpiredError（“过期 Token 可刷新或安全退出”）；
 * - 刷新成功会重新解析角色（Cognito 组变更经刷新即时生效，见 AUTH-01 未决风险条款）；
 * - logout：本地清会话为已提交操作，GlobalSignOut 失败不阻塞。
 */
import { actorTypeOf, isRole } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
import { decodeJwtPayload, jwtExpiresAtMs } from './jwt.js';
import type { SessionStore } from './session-store.js';
import type { AuthenticationResult } from '../auth/cognito-idp.js';

export interface SessionSnapshot {
  readonly username: string;
  readonly roles: readonly Role[];
  readonly customerId: string | null;
}

export interface EstablishedSession extends SessionSnapshot {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly obtainedAtMs: number;
}

export type SessionClearReason = 'logout' | 'unauthorized' | 'refresh-failed' | 'invalid-session';

export class SessionExpiredError extends Error {
  readonly reason: 'no-session' | 'refresh-failed';

  constructor(reason: SessionExpiredError['reason'], message: string) {
    super(message);
    this.name = 'SessionExpiredError';
    this.reason = reason;
  }
}

export class SessionEstablishError extends Error {
  readonly code:
    'invalid-id-token' | 'no-valid-role' | 'unknown-role-group' | 'mixed-actor-type' | 'missing-customer-scope';

  constructor(code: SessionEstablishError['code'], message: string) {
    super(message);
    this.name = 'SessionEstablishError';
    this.code = code;
  }
}

export interface SessionManagerDeps {
  readonly store: SessionStore<EstablishedSession>;
  readonly refreshTokens: (refreshToken: string) => Promise<AuthenticationResult>;
  readonly signOut: (accessToken: string) => Promise<void>;
  readonly clock?: () => number;
  /** 提前刷新余量（毫秒），默认 60s。 */
  readonly refreshSkewMs?: number;
}

/**
 * 由认证结果构造会话（ID Token 解析，失败关闭）。
 * refreshToken 缺省（刷新响应不返回新 RefreshToken）时由调用方传入旧值。
 */
export function buildSessionFromTokens(
  tokens: AuthenticationResult,
  options: { refreshToken: string; nowMs: number },
): EstablishedSession {
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtPayload(tokens.idToken);
  } catch {
    throw new SessionEstablishError('invalid-id-token', 'The ID token is not decodable');
  }

  const username = claims['cognito:username'] ?? claims['username'];
  if (typeof username !== 'string' || username === '') {
    throw new SessionEstablishError('invalid-id-token', 'The ID token carries no username');
  }

  const groups = claims['cognito:groups'];
  if (!Array.isArray(groups) || groups.length === 0 || groups.some((g) => typeof g !== 'string')) {
    throw new SessionEstablishError('no-valid-role', 'The ID token carries no role group');
  }
  if (groups.some((g) => !isRole(g as string))) {
    // 与 AUTH-01 一致：未知组失败关闭，不做宽松忽略
    throw new SessionEstablishError('unknown-role-group', 'The ID token carries an unknown role group');
  }
  const roles = [...new Set(groups)] as Role[];

  const actorTypes = new Set(roles.map(actorTypeOf));
  if (actorTypes.size !== 1) {
    throw new SessionEstablishError('mixed-actor-type', 'Platform and customer roles must not be mixed');
  }

  const customerClaim = claims['custom:customer_id'];
  if (actorTypes.has('customer')) {
    if (typeof customerClaim !== 'string' || customerClaim === '') {
      throw new SessionEstablishError('missing-customer-scope', 'A customer role requires a customer scope claim');
    }
  }
  const customerId = actorTypes.has('customer') ? (customerClaim as string) : null;

  return {
    username,
    roles,
    customerId,
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: options.refreshToken,
    expiresInSeconds: tokens.expiresInSeconds,
    obtainedAtMs: options.nowMs,
  };
}

export class SessionManager {
  private session: EstablishedSession | null;

  private readonly deps: SessionManagerDeps;

  private readonly clock: () => number;

  private readonly refreshSkewMs: number;

  private readonly listeners = new Set<(reason: SessionClearReason) => void>();

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
    this.refreshSkewMs = deps.refreshSkewMs ?? 60_000;
    this.session = deps.store.load();
  }

  /** 会话清除订阅（路由层据此跳回登录页）；返回取消订阅函数。 */
  onClear(listener: (reason: SessionClearReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  establish(session: EstablishedSession): void {
    this.session = session;
    this.deps.store.save(session);
  }

  current(): SessionSnapshot | null {
    const s = this.session;
    return s === null ? null : { username: s.username, roles: s.roles, customerId: s.customerId };
  }

  isAuthenticated(): boolean {
    return this.session !== null;
  }

  clearSession(reason: SessionClearReason): void {
    if (this.session === null) return;
    this.session = null;
    this.deps.store.clear();
    for (const listener of this.listeners) listener(reason);
  }

  /** 登出：本地会话先清除（已提交），再尽力 GlobalSignOut。 */
  async logout(): Promise<void> {
    const session = this.session;
    this.clearSession('logout');
    if (session !== null) {
      try {
        await this.deps.signOut(session.accessToken);
      } catch {
        // 网络/服务失败不阻塞本地登出；Refresh Token 随会话删除不再可用
      }
    }
  }

  /** 会话内 Access Token 的过期时刻（优先 exp 声明，退化到签发时刻 + ExpiresIn）。 */
  private accessTokenExpiresAtMs(session: EstablishedSession): number {
    try {
      const exp = jwtExpiresAtMs(session.accessToken);
      if (exp !== null) return exp;
    } catch {
      // 退化到签发时刻推算
    }
    return session.obtainedAtMs + session.expiresInSeconds * 1000;
  }

  /**
   * 返回可用的 Access Token；过期或 forceRefresh 时走 REFRESH_TOKEN_AUTH。
   * 刷新失败：清会话并抛 SessionExpiredError（调用方据此安全退出到登录页）。
   */
  async ensureFreshAccessToken(options?: { forceRefresh?: boolean }): Promise<string> {
    const session = this.session;
    if (session === null) {
      throw new SessionExpiredError('no-session', 'No active session');
    }
    const now = this.clock();
    if (options?.forceRefresh !== true && now < this.accessTokenExpiresAtMs(session) - this.refreshSkewMs) {
      return session.accessToken;
    }
    try {
      const tokens = await this.deps.refreshTokens(session.refreshToken);
      const refreshed = buildSessionFromTokens(tokens, {
        refreshToken: tokens.refreshToken ?? session.refreshToken,
        nowMs: this.clock(),
      });
      this.establish(refreshed);
      return refreshed.accessToken;
    } catch {
      this.clearSession('refresh-failed');
      throw new SessionExpiredError('refresh-failed', 'The session could not be refreshed');
    }
  }
}
