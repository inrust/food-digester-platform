// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminWebApp } from '../src/app/App.js';
import { createAdminWebServices } from '../src/app/composition-root.js';
import { createCognitoIdpClient } from '../src/auth/cognito-idp.js';
import type { EstablishedSession } from '../src/session/session-manager.js';
import { InMemorySessionStore } from '../src/session/session-store.js';
import { makeJwt } from './helpers.js';

const config = {
  apiBaseUrl: 'https://api.example.test',
  cognitoRegion: 'ap-southeast-1',
  cognitoUserPoolId: 'ap-southeast-1_example',
  cognitoClientId: 'client-id',
};

function services(fetchFn: typeof fetch = vi.fn()) {
  const idp = createCognitoIdpClient({
    region: config.cognitoRegion,
    clientId: config.cognitoClientId,
    fetch: vi.fn(),
  });
  return createAdminWebServices(config, {
    idp,
    store: new InMemorySessionStore<EstablishedSession>(),
    fetch: fetchFn,
  });
}

afterEach(() => cleanup());

describe('管理后台浏览器冒烟', () => {
  it('未登录访问带查询参数的受保护页会落到登录页并保留 returnTo', async () => {
    window.history.replaceState({}, '', '/sites?status=ACTIVE#list');
    render(<AdminWebApp services={services()} />);
    expect(await screen.findByRole('heading', { name: '厨余机云平台' })).toBeDefined();
    expect(decodeURIComponent(window.location.search)).toContain('/sites?status=ACTIVE');
  });

  it('已登录会话通过组合根请求 API 并渲染客户页面', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], meta: { nextCursor: null } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const appServices = services(fetchFn as typeof fetch);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    appServices.session.establish({
      username: 'admin@example.test',
      roles: ['PlatformSuperAdmin'],
      customerId: null,
      idToken: makeJwt({ 'cognito:username': 'admin@example.test', 'cognito:groups': ['PlatformSuperAdmin'], exp }),
      accessToken: makeJwt({ sub: 'admin', exp }),
      refreshToken: 'refresh-token',
      expiresInSeconds: 3600,
      obtainedAtMs: Date.now(),
    });
    window.history.replaceState({}, '', '/customers');
    render(<AdminWebApp services={appServices} />);
    expect(await screen.findByTestId('customers-page')).toBeDefined();
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.test/admin/customers?limit=50',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
