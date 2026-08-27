/**
 * AUTH-01 测试基件：本地 RS256 密钥对 + LocalJWKS + Token 签发 + 错误断言。
 * 仅用于测试；私钥在进程内随机生成，不落盘。
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { GenerateKeyPairResult, JWTVerifyGetKey } from 'jose';
import { assert } from 'vitest';
import { AuthError, AUTH_ERROR_HTTP_STATUS } from '../src/errors.js';
import type { AuthErrorCode } from '../src/errors.js';
import type { CognitoAuthenticatorConfig } from '../src/cognito.js';

export const TEST_REGION = 'ap-southeast-1';
export const TEST_USER_POOL_ID = 'ap-southeast-1_TestPool';
export const TEST_CLIENT_ID = 'test-client-id';
export const TEST_ISSUER = `https://cognito-idp.${TEST_REGION}.amazonaws.com/${TEST_USER_POOL_ID}`;

type SigningKey = GenerateKeyPairResult['privateKey'];

export interface TestKeySet {
  readonly privateKey: SigningKey;
  readonly jwks: JWTVerifyGetKey;
}

export async function generateTestKeySet(): Promise<TestKeySet> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

/** clockTolerance 置 0，便于精确断言过期场景。 */
export function testConfig(jwks: JWTVerifyGetKey): CognitoAuthenticatorConfig {
  return {
    region: TEST_REGION,
    userPoolId: TEST_USER_POOL_ID,
    clientId: TEST_CLIENT_ID,
    jwks,
    clockToleranceSeconds: 0,
  };
}

export interface TokenSpec {
  readonly groups?: readonly string[];
  readonly customerId?: string;
  readonly tokenUse?: 'id' | 'access';
  readonly sub?: string;
  readonly username?: string;
  readonly issuer?: string;
  readonly clientId?: string;
  /** 相对当前时间的秒数；负数表示已过期。 */
  readonly expiresInSeconds?: number;
  /** 伪造场景：使用另一密钥对签名。 */
  readonly signingKey?: SigningKey;
}

export async function signToken(keys: TestKeySet, spec: TokenSpec = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const tokenUse = spec.tokenUse ?? 'access';
  const clientId = spec.clientId ?? TEST_CLIENT_ID;

  const claims: Record<string, unknown> = {
    token_use: tokenUse,
    'cognito:username': spec.username ?? 'tester',
  };
  if (spec.groups) claims['cognito:groups'] = [...spec.groups];
  if (spec.customerId) claims['custom:customer_id'] = spec.customerId;
  // Cognito：Access Token 用 client_id 绑定 client；ID Token 用 aud
  if (tokenUse === 'access') claims['client_id'] = clientId;

  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject(spec.sub ?? 'user-sub-1')
    .setIssuer(spec.issuer ?? TEST_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + (spec.expiresInSeconds ?? 3600));
  if (tokenUse === 'id') builder = builder.setAudience(clientId);

  return builder.sign(spec.signingKey ?? keys.privateKey);
}

/** 断言 AuthError：错误码与 CT-05 状态一致，且消息不泄露内部校验细节。 */
export function assertAuthError(err: unknown, code: AuthErrorCode): AuthError {
  assert.instanceOf(err, AuthError);
  const authErr = err as AuthError;
  assert.equal(authErr.code, code);
  assert.equal(authErr.httpStatus, AUTH_ERROR_HTTP_STATUS[code]);
  assert.notMatch(authErr.message, /signature|issuer|audience|kid|RS256|expired/i);
  return authErr;
}

/** 断言异步调用抛出指定 AuthError。 */
export async function expectAuthError(promise: Promise<unknown>, code: AuthErrorCode): Promise<AuthError> {
  try {
    await promise;
  } catch (err) {
    return assertAuthError(err, code);
  }
  assert.fail(`应抛出 AuthError(${code})，但实际成功返回`);
}

/** 断言同步调用抛出指定 AuthError。 */
export function expectAuthErrorSync(fn: () => unknown, code: AuthErrorCode): AuthError {
  try {
    fn();
  } catch (err) {
    return assertAuthError(err, code);
  }
  assert.fail(`应抛出 AuthError(${code})，但实际成功返回`);
}
