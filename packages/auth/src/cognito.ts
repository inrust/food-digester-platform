/**
 * AUTH-01 Cognito JWT 认证器（认证 Guard 的核心）。
 *
 * - 校验 RS256 签名（User Pool JWKS）、issuer、token_use 与 client 绑定；
 * - ID Token 校验 aud === clientId；Access Token 校验 client_id === clientId；
 * - `cognito:groups` → 封闭角色集（未知组、空组、平台/Customer 混绑均 403 失败关闭）；
 * - `custom:customer_id` → Customer scope（Customer 角色缺失即 403；平台角色忽略）。
 *
 * 凭证问题（缺失/畸形/过期/伪造/错误 issuer 或 client）一律 401 UNAUTHENTICATED，
 * 不对外区分具体失败原因（防探测），内部细节只允许进日志。
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { unauthenticated, forbidden } from './errors.js';
import { actorTypeOf, isRole } from './roles.js';
import type { ActorContext, Role } from './roles.js';

export interface CognitoAuthenticatorConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
  /** 测试注入本地 JWKS；默认从 User Pool 远程拉取（运行时网络，无凭据）。 */
  readonly jwks?: JWTVerifyGetKey;
  /** 过期判定时钟容差（秒），默认 60；测试置 0 以精确断言。 */
  readonly clockToleranceSeconds?: number;
}

export interface CognitoAuthenticator {
  /** 认证 Guard：解析并校验 Authorization 头，返回可信 ActorContext。 */
  authenticate(authorizationHeader: string | null | undefined): Promise<ActorContext>;
}

interface CognitoClaims extends JWTPayload {
  readonly auth_time?: unknown;
  readonly token_use?: string;
  readonly client_id?: string;
  readonly username?: string;
  readonly 'cognito:username'?: string;
  readonly 'cognito:groups'?: unknown;
  readonly 'custom:customer_id'?: unknown;
}

const AUTHORIZATION_TOKEN_PATTERN = /^(?:Bearer )?([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

function extractAuthorizationToken(header: string | null | undefined): string {
  if (!header) throw unauthenticated();
  const match = AUTHORIZATION_TOKEN_PATTERN.exec(header);
  if (!match) throw unauthenticated();
  return match[1] as string;
}

export function createCognitoAuthenticator(config: CognitoAuthenticatorConfig): CognitoAuthenticator {
  const issuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
  const jwks = config.jwks ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const clockTolerance = config.clockToleranceSeconds ?? 60;

  async function authenticate(authorizationHeader: string | null | undefined): Promise<ActorContext> {
    // API Gateway REST 的 Cognito authorizer 将原始 ID Token 作为 Token source；
    // 同时保留标准 Bearer 形式，供无该 authorizer 的受控调用与现有客户端使用。
    const token = extractAuthorizationToken(authorizationHeader);

    let claims: CognitoClaims;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        algorithms: ['RS256'],
        clockTolerance,
      });
      claims = payload as CognitoClaims;
    } catch {
      // 过期/签名错误/issuer 不符/格式错误等统一 401，不外泄原因
      throw unauthenticated();
    }

    // token_use 与 client 绑定（Cognito：ID Token 用 aud，Access Token 用 client_id）
    if (claims.token_use === 'id') {
      if (claims.aud !== config.clientId) throw unauthenticated();
    } else if (claims.token_use === 'access') {
      if (claims.client_id !== config.clientId) throw unauthenticated();
    } else {
      throw unauthenticated();
    }

    return actorFromClaims(claims);
  }

  return { authenticate };
}

function actorFromClaims(claims: CognitoClaims): ActorContext {
  const sub = claims.sub;
  const username = claims['cognito:username'] ?? claims.username;
  if (typeof sub !== 'string' || sub === '' || typeof username !== 'string' || username === '') {
    throw unauthenticated();
  }
  const tokenUse = claims.token_use;
  if (tokenUse !== 'id' && tokenUse !== 'access') throw unauthenticated();
  if (typeof claims.auth_time !== 'number' || !Number.isInteger(claims.auth_time) || claims.auth_time <= 0) {
    throw unauthenticated();
  }
  const authenticatedAt = new Date(claims.auth_time * 1000).toISOString();

  const groups = claims['cognito:groups'];
  if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string')) {
    throw forbidden('The token carries no valid role group');
  }
  // DEC-012 失败关闭：未知组直接拒绝，不做宽松忽略
  if (groups.length === 0 || groups.some((g) => !isRole(g as string))) {
    throw forbidden('The token carries an unknown role group');
  }
  const roles = [...new Set(groups)] as Role[];

  const actorTypes = new Set(roles.map(actorTypeOf));
  if (actorTypes.size !== 1) {
    throw forbidden('Platform and customer roles must not be mixed on one actor');
  }
  const actorType = [...actorTypes][0] as ActorContext['actorType'];

  const customerClaim = claims['custom:customer_id'];
  if (actorType === 'customer') {
    if (typeof customerClaim !== 'string' || customerClaim === '') {
      throw forbidden('A customer role requires a customer scope claim');
    }
    return { actorId: sub, username, actorType, roles, customerId: customerClaim, tokenUse, authenticatedAt };
  }
  // 平台角色忽略 Token 中的 customer 声明，scope 恒为 null（服务端唯一可信来源）
  return { actorId: sub, username, actorType, roles, customerId: null, tokenUse, authenticatedAt };
}
