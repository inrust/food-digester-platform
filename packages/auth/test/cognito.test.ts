/**
 * AUTH-01 验收：过期/伪造 Token 返回 401；角色/scope 非法失败关闭 403。
 * JWKS 经 createLocalJWKSet 注入，无网络依赖。
 */
import { assert, beforeAll, describe, test } from 'vitest';
import { createCognitoAuthenticator } from '../src/index.js';
import type { CognitoAuthenticator } from '../src/index.js';
import { expectAuthError, generateTestKeySet, signToken, testConfig, TEST_ISSUER, type TestKeySet } from './helpers.js';

let keys: TestKeySet;
let authenticator: CognitoAuthenticator;

beforeAll(async () => {
  keys = await generateTestKeySet();
  authenticator = createCognitoAuthenticator(testConfig(keys.jwks));
});

describe('Cognito JWT 认证 Guard', () => {
  test('合法 Access Token → 平台 ActorContext', async () => {
    const token = await signToken(keys, { groups: ['PlatformSuperAdmin'] });
    const actor = await authenticator.authenticate(`Bearer ${token}`);
    assert.equal(actor.actorType, 'platform');
    assert.deepEqual(actor.roles, ['PlatformSuperAdmin']);
    assert.equal(actor.customerId, null);
    assert.equal(actor.actorId, 'user-sub-1');
    assert.equal(actor.username, 'tester');
    assert.equal(actor.tokenUse, 'access');
    assert.ok(actor.authenticatedAt);
  });

  test('合法 ID Token → Customer ActorContext（custom:customer_id 注入 scope）', async () => {
    const token = await signToken(keys, { tokenUse: 'id', groups: ['CustomerAdmin'], customerId: 'cust-a' });
    const actor = await authenticator.authenticate(`Bearer ${token}`);
    assert.equal(actor.actorType, 'customer');
    assert.deepEqual(actor.roles, ['CustomerAdmin']);
    assert.equal(actor.customerId, 'cust-a');
    assert.equal(actor.tokenUse, 'id');
  });

  test('过期 Token → 401', async () => {
    const token = await signToken(keys, { groups: ['PlatformSuperAdmin'], expiresInSeconds: -3600 });
    await expectAuthError(authenticator.authenticate(`Bearer ${token}`), 'UNAUTHENTICATED');
  });

  test('伪造签名（另一密钥对）→ 401', async () => {
    const forged = await generateTestKeySet();
    const token = await signToken(keys, { groups: ['PlatformSuperAdmin'], signingKey: forged.privateKey });
    await expectAuthError(authenticator.authenticate(`Bearer ${token}`), 'UNAUTHENTICATED');
  });

  test('错误 issuer → 401', async () => {
    const token = await signToken(keys, { groups: ['PlatformSuperAdmin'], issuer: `${TEST_ISSUER}-evil` });
    await expectAuthError(authenticator.authenticate(`Bearer ${token}`), 'UNAUTHENTICATED');
  });

  test('client 绑定不符（ID Token 错误 aud / Access Token 错误 client_id）→ 401', async () => {
    const idToken = await signToken(keys, { tokenUse: 'id', groups: ['PlatformSuperAdmin'], clientId: 'other-client' });
    await expectAuthError(authenticator.authenticate(`Bearer ${idToken}`), 'UNAUTHENTICATED');
    const accessToken = await signToken(keys, { groups: ['PlatformSuperAdmin'], clientId: 'other-client' });
    await expectAuthError(authenticator.authenticate(`Bearer ${accessToken}`), 'UNAUTHENTICATED');
  });

  test('缺失/畸形/非 Bearer 凭证 → 401', async () => {
    for (const header of [undefined, null, '', 'Bearer', 'Basic abc', 'Bearer not a jwt']) {
      await expectAuthError(authenticator.authenticate(header), 'UNAUTHENTICATED');
    }
  });

  test('缺失或非法 auth_time → 401，不能伪造近期重新认证上下文', async () => {
    const missing = await signToken(keys, { groups: ['PlatformSuperAdmin'], authenticatedAtSeconds: 0 });
    await expectAuthError(authenticator.authenticate(`Bearer ${missing}`), 'UNAUTHENTICATED');
  });

  test('未知 Cognito 组 → 403 失败关闭（DEC-012）', async () => {
    const token = await signToken(keys, { groups: ['SuperUser'] });
    await expectAuthError(authenticator.authenticate(`Bearer ${token}`), 'FORBIDDEN');
  });

  test('无角色组 → 403', async () => {
    const token = await signToken(keys, { groups: [] });
    await expectAuthError(authenticator.authenticate(`Bearer ${token}`), 'FORBIDDEN');
  });

  test('平台与 Customer 角色混绑 → 403', async () => {
    const token = await signToken(keys, { groups: ['PlatformOperator', 'CustomerAdmin'], customerId: 'cust-a' });
    await expectAuthError(authenticator.authenticate(`Bearer ${token}`), 'FORBIDDEN');
  });

  test('Customer 角色缺少 custom:customer_id → 403', async () => {
    const token = await signToken(keys, { groups: ['CustomerViewer'] });
    await expectAuthError(authenticator.authenticate(`Bearer ${token}`), 'FORBIDDEN');
  });

  test('平台角色 Token 携带 custom:customer_id 时 scope 恒为 null', async () => {
    const token = await signToken(keys, { groups: ['Auditor'], customerId: 'cust-a' });
    const actor = await authenticator.authenticate(`Bearer ${token}`);
    assert.equal(actor.actorType, 'platform');
    assert.equal(actor.customerId, null);
  });
});
