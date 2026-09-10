// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCognitoIdpClient } from '../src/auth/cognito-idp.js';
import { createAdminWebServices } from '../src/app/composition-root.js';
import { safeReturnPath } from '../src/app/browser-router.js';
import { loadRuntimeConfig, RuntimeConfigError } from '../src/app/runtime-config.js';
import { InMemorySessionStore } from '../src/session/session-store.js';
import type { EstablishedSession } from '../src/session/session-manager.js';

const config = {
  apiBaseUrl: 'https://api.example.test',
  cognitoRegion: 'ap-southeast-1',
  cognitoUserPoolId: 'ap-southeast-1_example',
  cognitoClientId: 'client-id',
};

describe('管理后台运行基础', () => {
  it('严格读取并规范化四项公开运行时配置', () => {
    expect(
      loadRuntimeConfig({
        VITE_ADMIN_API_BASE_URL: ' https://api.example.test/ ',
        VITE_COGNITO_REGION: 'ap-southeast-1',
        VITE_COGNITO_USER_POOL_ID: 'pool',
        VITE_COGNITO_CLIENT_ID: 'client',
      }),
    ).toEqual({
      apiBaseUrl: 'https://api.example.test',
      cognitoRegion: 'ap-southeast-1',
      cognitoUserPoolId: 'pool',
      cognitoClientId: 'client',
    });
    expect(() => loadRuntimeConfig({})).toThrow(RuntimeConfigError);
  });

  it('组合根一次性装配 Cognito、SessionManager、AuthFlow 与 ApiClient', () => {
    const idp = createCognitoIdpClient({
      region: config.cognitoRegion,
      clientId: config.cognitoClientId,
      fetch: vi.fn(),
    });
    const services = createAdminWebServices(config, {
      idp,
      store: new InMemorySessionStore<EstablishedSession>(),
      fetch: vi.fn(),
    });
    expect(services.idp).toBe(idp);
    expect(services.session.current()).toBeNull();
    expect(services.auth).toBeDefined();
    expect(services.api).toBeDefined();
  });

  it('returnTo 保留内部查询与 hash，并拒绝外部或未注册路径', () => {
    expect(safeReturnPath('/sites?status=ACTIVE#list')).toBe('/sites?status=ACTIVE#list');
    expect(safeReturnPath('//evil.example/path')).toBe('/dashboard');
    expect(safeReturnPath('/not-registered')).toBe('/dashboard');
  });
});
