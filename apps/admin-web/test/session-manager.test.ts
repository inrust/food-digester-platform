import { assert, test } from 'vitest';
import { InMemorySessionStore } from '../src/session/session-store.js';
import {
  buildSessionFromTokens,
  SessionEstablishError,
  SessionExpiredError,
  SessionManager,
} from '../src/session/session-manager.js';
import type { EstablishedSession } from '../src/session/session-manager.js';
import { makeAccessToken, makeIdToken, expectRejects, expectThrows } from './helpers.js';

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

function makeSession(options: {
  groups?: string[];
  customerId?: string;
  accessTokenExpiresAtMs?: number;
  refreshToken?: string;
}): EstablishedSession {
  const groups = options.groups ?? ['PlatformSuperAdmin'];
  return buildSessionFromTokens(
    {
      accessToken: makeAccessToken(options.accessTokenExpiresAtMs ?? NOW + 3600_000),
      idToken: makeIdToken({ groups, customerId: options.customerId, expSeconds: NOW / 1000 + 3600 }),
      expiresInSeconds: 3600,
      tokenType: 'Bearer',
    },
    { refreshToken: options.refreshToken ?? 'refresh-1', nowMs: NOW },
  );
}

function makeManager(overrides: {
  session?: EstablishedSession;
  clock?: () => number;
  refreshTokens?: (token: string) => Promise<{
    accessToken: string;
    idToken: string;
    refreshToken?: string;
    expiresInSeconds: number;
    tokenType: string;
  }>;
  signOut?: (token: string) => Promise<void>;
}) {
  const store = new InMemorySessionStore<EstablishedSession>();
  if (overrides.session !== undefined) store.save(overrides.session);
  const refreshCalls: string[] = [];
  const manager = new SessionManager({
    store,
    clock: overrides.clock ?? (() => NOW),
    refreshTokens:
      overrides.refreshTokens ??
      (async (token: string) => {
        refreshCalls.push(token);
        return {
          accessToken: makeAccessToken(NOW + 7200_000),
          idToken: makeIdToken({ groups: ['PlatformSuperAdmin'], expSeconds: NOW / 1000 + 7200 }),
          expiresInSeconds: 7200,
          tokenType: 'Bearer',
        };
      }),
    signOut: overrides.signOut ?? (async () => {}),
  });
  return { manager, store, refreshCalls };
}

test('buildSessionFromTokens：平台角色忽略 customer 声明（customerId 恒 null）', () => {
  const session = makeSession({ groups: ['PlatformOperator'], customerId: 'cust-should-ignore' });
  assert.equal(session.customerId, null);
  assert.equal(session.username, 'zhang@example.com');
});

test('buildSessionFromTokens 失败关闭：未知组 / 平台与 Customer 混绑 / Customer 缺 scope', () => {
  expectThrows(
    () => makeSession({ groups: ['RootAdmin'] }),
    (err) => {
      assert.ok(err instanceof SessionEstablishError);
      assert.equal((err as SessionEstablishError).code, 'unknown-role-group');
    },
  );
  expectThrows(
    () => makeSession({ groups: ['Auditor', 'CustomerViewer'], customerId: 'cust-1' }),
    (err) => {
      assert.ok(err instanceof SessionEstablishError);
      assert.equal((err as SessionEstablishError).code, 'mixed-actor-type');
    },
  );
  expectThrows(
    () => makeSession({ groups: ['CustomerViewer'] }),
    (err) => {
      assert.ok(err instanceof SessionEstablishError);
      assert.equal((err as SessionEstablishError).code, 'missing-customer-scope');
    },
  );
});

test('启动时从存储恢复会话', () => {
  const session = makeSession({});
  const { manager } = makeManager({ session });
  assert.ok(manager.isAuthenticated());
  assert.deepEqual([...(manager.current()?.roles ?? [])], ['PlatformSuperAdmin']);
});

test('Token 未过期：不触发刷新', async () => {
  const { manager, refreshCalls } = makeManager({ session: makeSession({}) });
  const token = await manager.ensureFreshAccessToken();
  assert.equal(refreshCalls.length, 0);
  assert.ok(token.length > 0);
});

test('Admin API 凭据使用 ID Token，不暴露 Access Token', async () => {
  const session = makeSession({});
  const { manager, refreshCalls } = makeManager({ session });
  const token = await manager.ensureFreshIdToken();
  assert.equal(token, session.idToken);
  assert.notEqual(token, session.accessToken);
  assert.equal(refreshCalls.length, 0);
});

test('过期 Token 可刷新：换新 Access/Id Token，Refresh Token 保留旧值', async () => {
  const expired = makeSession({ accessTokenExpiresAtMs: NOW - 1000 });
  const { manager, store, refreshCalls } = makeManager({ session: expired });
  const before = expired.accessToken;
  const after = await manager.ensureFreshAccessToken();
  assert.deepEqual(refreshCalls, ['refresh-1']);
  assert.notEqual(after, before);
  assert.equal(manager.current()?.username, 'zhang@example.com');
  // 刷新响应未携带新 RefreshToken → 保留旧的
  assert.equal(store.load()?.refreshToken, 'refresh-1');
});

test('刷新时角色变更即时生效（Cognito 组调整经刷新传播）', async () => {
  const expired = makeSession({ accessTokenExpiresAtMs: NOW - 1000, groups: ['PlatformOperator'] });
  const { manager } = makeManager({
    session: expired,
    refreshTokens: async () => ({
      accessToken: makeAccessToken(NOW + 7200_000),
      idToken: makeIdToken({ groups: ['Auditor'], expSeconds: NOW / 1000 + 7200 }),
      expiresInSeconds: 7200,
      tokenType: 'Bearer',
    }),
  });
  await manager.ensureFreshAccessToken();
  assert.deepEqual([...(manager.current()?.roles ?? [])], ['Auditor']);
});

test('刷新失败：清会话并抛 SessionExpiredError（安全退出），监听者收到 refresh-failed', async () => {
  const expired = makeSession({ accessTokenExpiresAtMs: NOW - 1000 });
  const { manager, store } = makeManager({
    session: expired,
    refreshTokens: async () => {
      throw new Error('NotAuthorizedException');
    },
  });
  const reasons: string[] = [];
  manager.onClear((reason) => reasons.push(reason));
  await expectRejects(manager.ensureFreshAccessToken(), (err) => {
    assert.ok(err instanceof SessionExpiredError);
    assert.equal((err as SessionExpiredError).reason, 'refresh-failed');
  });
  assert.equal(manager.isAuthenticated(), false);
  assert.equal(store.load(), null);
  assert.deepEqual(reasons, ['refresh-failed']);
});

test('无会话：ensureFreshAccessToken 抛 no-session', async () => {
  const { manager } = makeManager({});
  await expectRejects(manager.ensureFreshAccessToken(), (err) => {
    assert.ok(err instanceof SessionExpiredError);
    assert.equal((err as SessionExpiredError).reason, 'no-session');
  });
});

test('登出：本地清除先于服务端调用；GlobalSignOut 失败不阻塞登出', async () => {
  const { manager, store } = makeManager({
    session: makeSession({}),
    signOut: async () => {
      throw new Error('network down');
    },
  });
  const reasons: string[] = [];
  manager.onClear((reason) => reasons.push(reason));
  await manager.logout();
  assert.equal(manager.isAuthenticated(), false);
  assert.equal(store.load(), null);
  assert.deepEqual(reasons, ['logout']);
});
