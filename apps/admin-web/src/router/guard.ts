/**
 * FE-01 路由守卫：无 Token 进不了受保护页；角色不符显示无权；已登录访问登录页回首页。
 *
 * 纯函数解析，FE-02 壳层（React/Next）将其绑定到实际路由器。
 * 判定结果封闭：allow / redirect-login / redirect-home / forbidden / not-found。
 */
import type { AppRoute } from './routes.js';
import { findRoute, LOGIN_PATH } from './routes.js';
import { canAccessRoute, homePathForRoles } from '../menu/menu.js';
import type { SessionSnapshot } from '../session/session-manager.js';

export type GuardVerdict =
  | { readonly kind: 'allow'; readonly route: AppRoute }
  | { readonly kind: 'redirect-login'; readonly returnTo: string }
  | { readonly kind: 'redirect-home'; readonly home: string }
  | { readonly kind: 'forbidden'; readonly route: AppRoute }
  | { readonly kind: 'not-found' };

export function resolveRoute(path: string, session: SessionSnapshot | null): GuardVerdict {
  const route = findRoute(path);
  if (route === null) return { kind: 'not-found' };

  if (route.public === true) {
    if (path === LOGIN_PATH && session !== null) {
      return { kind: 'redirect-home', home: homePathForRoles(session.roles) };
    }
    return { kind: 'allow', route };
  }

  if (session === null) {
    return { kind: 'redirect-login', returnTo: path };
  }
  if (!canAccessRoute(route, session.roles)) {
    return { kind: 'forbidden', route };
  }
  return { kind: 'allow', route };
}
