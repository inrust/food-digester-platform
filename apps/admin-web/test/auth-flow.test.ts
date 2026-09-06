import { assert, test } from 'vitest';
import { AuthFlow, AuthFlowError } from '../src/auth/auth-flow.js';
import { CognitoIdpError, createCognitoIdpClient } from '../src/auth/cognito-idp.js';
import { InMemorySessionStore } from '../src/session/session-store.js';
import { SessionEstablishError, SessionManager } from '../src/session/session-manager.js';
import type { EstablishedSession } from '../src/session/session-manager.js';
import { FakeCognitoServer } from './fake-cognito.js';
import type { FakeUser } from './fake-cognito.js';
import { expectRejects, scriptedIdpFetch } from './helpers.js';

const POOL_ID = 'ap-east-1_TestPool';
const CLIENT_ID = 'client-1';

function setup(users: Record<string, FakeUser>) {
  const server = new FakeCognitoServer({ userPoolId: POOL_ID, users });
  const idp = createCognitoIdpClient({ region: 'ap-east-1', clientId: CLIENT_ID, fetch: server.fetch });
  const store = new InMemorySessionStore<EstablishedSession>();
  const session = new SessionManager({
    store,
    refreshTokens: (token) => idp.refreshAuth(token),
    signOut: (token) => idp.globalSignOut(token),
  });
  const flow = new AuthFlow({ idp, userPoolId: POOL_ID, sessionManager: session });
  return { server, idp, store, session, flow };
}

test('登录成功：SRP 交换后建立会话（角色/Customer scope 来自 ID Token）', async () => {
  const { server, session, store, flow } = setup({
    'zhang@example.com': { password: 'Sup3r!Pass', groups: ['PlatformSuperAdmin'] },
  });
  const outcome = await flow.login('zhang@example.com', 'Sup3r!Pass');
  assert.equal(outcome.status, 'authenticated');
  assert.deepEqual([...(session.current()?.roles ?? [])], ['PlatformSuperAdmin']);
  assert.equal(session.current()?.customerId, null);
  assert.ok(store.load()?.refreshToken.startsWith('refresh-'));

  const initiate = server.calls.find((c) => c.operation === 'InitiateAuth');
  assert.equal((initiate?.payload['AuthParameters'] as Record<string, unknown>)['USERNAME'], 'zhang@example.com');
  assert.ok(typeof (initiate?.payload['AuthParameters'] as Record<string, unknown>)['SRP_A'] === 'string');
  // 密码不出现在任何一次网络调用中（SRP 只传公钥与签名）
  for (const call of server.calls) {
    assert.notMatch(JSON.stringify(call.payload), /Sup3r!Pass/);
  }
});

test('Customer 角色登录：customerId 取自 custom:customer_id', async () => {
  const { session, flow } = setup({
    'li@example.com': { password: 'Passw0rd!', groups: ['CustomerAdmin'], customerId: 'cust-1' },
  });
  const outcome = await flow.login('li@example.com', 'Passw0rd!');
  assert.equal(outcome.status, 'authenticated');
  assert.equal(session.current()?.customerId, 'cust-1');
});

test('MFA challenge：软件令牌验证码正确后建立会话；错误码映射 CODE_MISMATCH', async () => {
  const { session, flow } = setup({
    'ops@example.com': { password: 'Passw0rd!', groups: ['PlatformOperator'], mfa: true, mfaCode: '654321' },
  });
  const first = await flow.login('ops@example.com', 'Passw0rd!');
  assert.deepEqual(first, { status: 'mfa-required', mfa: 'SOFTWARE_TOKEN_MFA' });
  assert.equal(session.isAuthenticated(), false);

  await expectRejects(flow.submitMfaCode('000000'), (err) => {
    assert.ok(err instanceof CognitoIdpError);
    assert.equal((err as CognitoIdpError).code, 'CODE_MISMATCH');
  });

  const second = await flow.submitMfaCode('654321');
  assert.equal(second.status, 'authenticated');
  assert.ok(session.isAuthenticated());
});

test('NEW_PASSWORD_REQUIRED：提交新密码后建立会话', async () => {
  const { flow } = setup({
    'new@example.com': { password: 'Temp!12345', groups: ['Auditor'], forceNewPassword: true },
  });
  const first = await flow.login('new@example.com', 'Temp!12345');
  assert.deepEqual(first, { status: 'new-password-required' });
  const second = await flow.submitNewPassword('N3w!Passw0rd');
  assert.equal(second.status, 'authenticated');
});

test('MFA_SETUP 为终止态：提示需管理员完成 MFA 绑定，不建立会话', async () => {
  const { session, flow } = setup({
    'setup@example.com': { password: 'Passw0rd!', groups: ['PlatformSuperAdmin'], mfaSetup: true },
  });
  const outcome = await flow.login('setup@example.com', 'Passw0rd!');
  assert.deepEqual(outcome, { status: 'mfa-setup-required' });
  assert.equal(session.isAuthenticated(), false);
});

test('无 pending challenge 时提交 MFA/新密码直接报错', async () => {
  const { flow } = setup({});
  await expectRejects(flow.submitMfaCode('123456'), (err) => assert.ok(err instanceof AuthFlowError));
  await expectRejects(flow.submitNewPassword('x'), (err) => assert.ok(err instanceof AuthFlowError));
});

test('登录失败：错误密码/未知用户统一 INVALID_CREDENTIALS（防探测）', async () => {
  const { flow } = setup({ 'zhang@example.com': { password: 'Sup3r!Pass', groups: ['Auditor'] } });
  for (const [username, password] of [
    ['zhang@example.com', 'wrong'],
    ['ghost@example.com', 'Sup3r!Pass'],
  ]) {
    await expectRejects(flow.login(username, password), (err) => {
      assert.ok(err instanceof CognitoIdpError);
      assert.equal((err as CognitoIdpError).code, 'INVALID_CREDENTIALS');
    });
  }
});

test('失败关闭：ID Token 携带未知角色组时拒绝建立会话', async () => {
  const { session, flow } = setup({
    'evil@example.com': { password: 'Passw0rd!', groups: ['SuperUser'] },
  });
  await expectRejects(flow.login('evil@example.com', 'Passw0rd!'), (err) => {
    assert.ok(err instanceof SessionEstablishError);
    assert.equal(err.code, 'unknown-role-group');
  });
  assert.equal(session.isAuthenticated(), false);
});

test('忘记密码：触发与确认；确认码错误映射 CODE_MISMATCH', async () => {
  const { server, flow } = setup({});
  await flow.forgotPassword('zhang@example.com');
  await flow.confirmForgotPassword('zhang@example.com', '111111', 'N3w!Pass');
  const operations = server.calls.map((c) => c.operation);
  assert.deepEqual(operations, ['ForgotPassword', 'ConfirmForgotPassword']);
  await expectRejects(flow.confirmForgotPassword('zhang@example.com', '000000', 'x'), (err) => {
    assert.ok(err instanceof CognitoIdpError);
    assert.equal(err.code, 'CODE_MISMATCH');
  });
});

test('登出：本地会话清除且服务端 GlobalSignOut 收到 AccessToken', async () => {
  const { server, session, flow } = setup({
    'zhang@example.com': { password: 'Sup3r!Pass', groups: ['CustomerViewer'], customerId: 'cust-9' },
  });
  await flow.login('zhang@example.com', 'Sup3r!Pass');
  assert.ok(session.isAuthenticated());
  await flow.logout();
  assert.equal(session.isAuthenticated(), false);
  assert.equal(server.signedOutTokens.length, 1);
});

test('传输层：请求携带 X-Amz-Target 与 ClientId', async () => {
  const { fetch, calls } = scriptedIdpFetch([
    { status: 200, body: { ChallengeName: 'PASSWORD_VERIFIER', ChallengeParameters: {}, Session: 's1' } },
  ]);
  const idp = createCognitoIdpClient({ region: 'ap-east-1', clientId: CLIENT_ID, fetch });
  await idp.initiateSrpAuth('a@example.com', 'aabb');
  assert.equal(calls[0]?.operation, 'InitiateAuth');
  assert.equal(calls[0]?.payload['ClientId'], CLIENT_ID);
  assert.equal(calls[0]?.payload['AuthFlow'], 'USER_SRP_AUTH');
});

test('传输层错误映射：刷新场景的 NotAuthorized → REFRESH_TOKEN_INVALID', async () => {
  const { fetch } = scriptedIdpFetch([{ status: 400, body: { __type: 'NotAuthorizedException' } }]);
  const idp = createCognitoIdpClient({ region: 'ap-east-1', clientId: CLIENT_ID, fetch });
  await expectRejects(idp.refreshAuth('stale'), (err) => {
    assert.ok(err instanceof CognitoIdpError);
    assert.equal(err.code, 'REFRESH_TOKEN_INVALID');
  });
});
