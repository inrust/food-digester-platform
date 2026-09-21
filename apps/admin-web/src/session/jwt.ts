/**
 * FE-01 会话 JWT 解析（仅前端调度/显示用途）。
 *
 * 安全边界：前端解析 ID/Access Token 载荷只用于角色菜单、显示名和过期调度；
 * 签名与授权校验由 AUTH-01 后端 Guard 完成，本模块不构成任何信任决策。
 */

export class SessionTokenError extends Error {
  readonly code: 'malformed-token';

  constructor(message: string) {
    super(message);
    this.name = 'SessionTokenError';
    this.code = 'malformed-token';
  }
}

/** 解析 JWT 载荷（不验签）；结构非法抛 SessionTokenError。 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === '') {
    throw new SessionTokenError('The token is not a well-formed JWT');
  }
  try {
    const payload = (parts[1] as string).replace(/-/gu, '+').replace(/_/gu, '/');
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new SessionTokenError('The token payload is not decodable');
  }
}

/** exp 声明（秒）→ 毫秒时间戳；缺失/非法返回 null。 */
export function jwtExpiresAtMs(token: string): number | null {
  const claims = decodeJwtPayload(token);
  const exp = claims['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}
