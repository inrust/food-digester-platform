import { createApiClient, createHttpApiFetch } from '../api/http-client.js';
import type { ApiClient } from '../api/http-client.js';
import { AuthFlow } from '../auth/auth-flow.js';
import { createCognitoIdpClient } from '../auth/cognito-idp.js';
import type { CognitoIdpClient } from '../auth/cognito-idp.js';
import { SessionManager } from '../session/session-manager.js';
import type { EstablishedSession } from '../session/session-manager.js';
import type { SessionStore } from '../session/session-store.js';
import type { AdminWebRuntimeConfig } from './runtime-config.js';

const SESSION_KEY = 'fdp.admin.session.v1';

export class BrowserSessionStore implements SessionStore<EstablishedSession> {
  load(): EstablishedSession | null {
    try {
      const raw = window.sessionStorage.getItem(SESSION_KEY);
      return raw === null ? null : (JSON.parse(raw) as EstablishedSession);
    } catch {
      window.sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  save(session: EstablishedSession): void {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  clear(): void {
    window.sessionStorage.removeItem(SESSION_KEY);
  }
}

export interface AdminWebServices {
  readonly idp: CognitoIdpClient;
  readonly session: SessionManager;
  readonly auth: AuthFlow;
  readonly api: ApiClient;
}

export interface CompositionOverrides {
  readonly fetch?: typeof fetch;
  readonly store?: SessionStore<EstablishedSession>;
  readonly idp?: CognitoIdpClient;
}

/** 唯一浏览器组合根：身份、会话和管理 API 共用同一 SessionManager。 */
export function createAdminWebServices(
  config: AdminWebRuntimeConfig,
  overrides: CompositionOverrides = {},
): AdminWebServices {
  const fetchFn = overrides.fetch ?? fetch;
  const idp =
    overrides.idp ?? createCognitoIdpClient({ region: config.cognitoRegion, clientId: config.cognitoClientId });
  const session = new SessionManager({
    store: overrides.store ?? new BrowserSessionStore(),
    refreshTokens: (refreshToken) => idp.refreshAuth(refreshToken),
    signOut: (accessToken) => idp.globalSignOut(accessToken),
  });
  const auth = new AuthFlow({ idp, userPoolId: config.cognitoUserPoolId, sessionManager: session });
  const api = createApiClient({
    baseUrl: config.apiBaseUrl,
    session,
    fetch: createHttpApiFetch(fetchFn),
  });
  return { idp, session, auth, api };
}
