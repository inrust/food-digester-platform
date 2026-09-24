import { assert, test } from 'vitest';
import { ApiClientError, ForbiddenError, UnauthenticatedError } from '../src/api/errors.js';
import { createApiClient } from '../src/api/http-client.js';
import { InMemorySessionStore } from '../src/session/session-store.js';
import { buildSessionFromTokens, SessionManager } from '../src/session/session-manager.js';
import type { EstablishedSession } from '../src/session/session-manager.js';
import { makeAccessToken, makeIdToken, expectRejects, scriptedApiFetch } from './helpers.js';

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

function makeSession(accessTokenExpiresAtMs = NOW + 3600_000): EstablishedSession {
  return buildSessionFromTokens(
    {
      accessToken: makeAccessToken(accessTokenExpiresAtMs),
      idToken: makeIdToken({ groups: ['PlatformSuperAdmin'], expSeconds: NOW / 1000 + 3600 }),
      expiresInSeconds: 3600,
      tokenType: 'Bearer',
    },
    { refreshToken: 'refresh-1', nowMs: NOW },
  );
}

function setup(options: {
  session?: EstablishedSession;
  script: { status: number; body: unknown }[];
  refreshResult?: 'ok' | 'fail';
}) {
  const store = new InMemorySessionStore<EstablishedSession>();
  if (options.session !== undefined) store.save(options.session);
  const session = new SessionManager({
    store,
    clock: () => NOW,
    refreshTokens: async () => {
      if (options.refreshResult === 'fail') throw new Error('NotAuthorizedException');
      return {
        accessToken: makeAccessToken(NOW + 7200_000),
        idToken: makeIdToken({ groups: ['PlatformSuperAdmin'], expSeconds: NOW / 1000 + 7200 }),
        expiresInSeconds: 7200,
        tokenType: 'Bearer',
      };
    },
    signOut: async () => {},
  });
  const { fetch, calls } = scriptedApiFetch(options.script);
  const client = createApiClient({ baseUrl: 'https://api.example.com/api/v1', session, fetch });
  return { client, calls, session, store };
}

test('请求携带 API Gateway Token source 所需的原始 ID Token；CT-05 写头 Idempotency-Key / If-Match / JSON body', async () => {
  const session = makeSession();
  const { client, calls } = setup({
    session,
    script: [{ status: 200, body: { data: { ok: true }, meta: { requestId: 'r1' } } }],
  });
  const result = await client.request<{ data: { ok: boolean } }>('/admin/devices', {
    method: 'POST',
    body: { alias: 'x' },
    idempotencyKey: 'idem-1',
    ifMatch: 3,
  });
  assert.equal(result.data.ok, true);
  const call = calls[0];
  assert.equal(call?.url, 'https://api.example.com/api/v1/admin/devices');
  assert.equal(call?.method, 'POST');
  assert.equal(call?.headers['Authorization'], session.idToken);
  assert.notEqual(call?.headers['Authorization'], session.accessToken);
  assert.equal(call?.headers['Idempotency-Key'], 'idem-1');
  assert.equal(call?.headers['If-Match'], '3');
  assert.equal(call?.body, JSON.stringify({ alias: 'x' }));
});

test('401 → 强制刷新后重试一次成功（竞态兜底）', async () => {
  const { client, calls } = setup({
    session: makeSession(),
    script: [
      { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r1' } } },
      { status: 200, body: { data: [1, 2] } },
    ],
  });
  const result = await client.request<{ data: number[] }>('/admin/devices');
  assert.deepEqual(result.data, [1, 2]);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]?.headers['Authorization'], calls[1]?.headers['Authorization']);
});

test('401 且刷新后仍 401 → 清会话并抛 UnauthenticatedError（安全退出）', async () => {
  const { client, session } = setup({
    session: makeSession(),
    script: [
      { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r1' } } },
      { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r2' } } },
    ],
  });
  const reasons: string[] = [];
  session.onClear((reason) => reasons.push(reason));
  await expectRejects(client.request('/admin/devices'), (err) => assert.ok(err instanceof UnauthenticatedError));
  assert.equal(session.isAuthenticated(), false);
  assert.deepEqual(reasons, ['unauthorized']);
});

test('401 且刷新失败 → 清会话并抛 UnauthenticatedError', async () => {
  const { client, session, store } = setup({
    session: makeSession(),
    script: [{ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r1' } } }],
    refreshResult: 'fail',
  });
  await expectRejects(client.request('/admin/devices'), (err) => assert.ok(err instanceof UnauthenticatedError));
  assert.equal(session.isAuthenticated(), false);
  assert.equal(store.load(), null);
});

test('403 → ForbiddenError（携带 code/requestId），会话保留', async () => {
  const { client, session } = setup({
    session: makeSession(),
    script: [{ status: 403, body: { error: { code: 'FORBIDDEN', message: 'denied', requestId: 'req-9' } } }],
  });
  await expectRejects(client.request('/admin/users'), (err) => {
    assert.ok(err instanceof ForbiddenError);
    assert.equal((err as ForbiddenError).code, 'FORBIDDEN');
    assert.equal((err as ForbiddenError).requestId, 'req-9');
  });
  assert.ok(session.isAuthenticated());
});

test('其他错误：解析 CT-05 包络；非包络响应退化为通用错误', async () => {
  const { client } = setup({
    session: makeSession(),
    script: [
      { status: 409, body: { error: { code: 'VERSION_CONFLICT', message: 'modified', requestId: 'r7' } } },
      { status: 500, body: '<html>oops</html>' },
    ],
  });
  await expectRejects(client.request('/admin/devices/1'), (err) => {
    assert.ok(err instanceof ApiClientError);
    assert.equal((err as ApiClientError).code, 'VERSION_CONFLICT');
    assert.equal((err as ApiClientError).status, 409);
  });
  await expectRejects(client.request('/admin/devices/2'), (err) => {
    assert.ok(err instanceof ApiClientError);
    assert.equal((err as ApiClientError).code, 'INTERNAL_ERROR');
  });
});

test('无会话：不发任何请求，直接 UnauthenticatedError', async () => {
  const { client, calls } = setup({ script: [] });
  await expectRejects(client.request('/admin/devices'), (err) => assert.ok(err instanceof UnauthenticatedError));
  assert.equal(calls.length, 0);
});
