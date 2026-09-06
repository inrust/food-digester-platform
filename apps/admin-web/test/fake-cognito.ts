/**
 * 测试内独立的 Cognito SRP 服务端模拟：按 SRP-6a 服务端公式独立复算，
 * 用于验证客户端 computePasswordVerifierClaim / AuthFlow 全链路与服务端语义互认。
 *
 * 与客户端共用的只有公开常量（SRP_N_HEX）与 padHex 规则；x/v/B/S/HKDF/签名均独立实现。
 */
import { createHash, createHmac } from 'node:crypto';
import { padHex, SRP_N_HEX } from '../src/auth/srp.js';
import type { IdpFetch, IdpHttpResponse } from '../src/auth/cognito-idp.js';
import { makeJwt } from './helpers.js';

const N = BigInt(`0x${SRP_N_HEX}`);
const G = 2n;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function hexHash(hex: string): string {
  return sha256Hex(hexToBytes(hex));
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

const K = BigInt(`0x${hexHash(`00${SRP_N_HEX}0${'2'}`)}`);

export interface FakeUser {
  readonly password: string;
  readonly groups: readonly string[];
  readonly customerId?: string;
  /** 启用软件令牌 MFA；验证码默认 123456。 */
  readonly mfa?: boolean;
  readonly mfaCode?: string;
  /** 首次登录强制改密。 */
  readonly forceNewPassword?: boolean;
  /** 密码校验后进入 MFA_SETUP（终止态）。 */
  readonly mfaSetup?: boolean;
}

interface PendingSrp {
  readonly username: string;
  readonly bigA: bigint;
  readonly bigB: bigint;
  readonly b: bigint;
  readonly v: bigint;
  readonly secretBlock: Buffer;
}

export interface FakeCognitoCall {
  readonly operation: string;
  readonly payload: Record<string, unknown>;
}

function errorResponse(type: string): IdpHttpResponse {
  return { status: 400, body: { __type: type, message: 'fake-idp' } };
}

export class FakeCognitoServer {
  readonly calls: FakeCognitoCall[] = [];

  /** GlobalSignOut 收到的 AccessToken（登出证据）。 */
  readonly signedOutTokens: string[] = [];

  /** 发放的 RefreshToken 是否有效（用于模拟吊销）。 */
  refreshTokensValid = true;

  private readonly pending = new Map<string, PendingSrp>();

  private sequence = 0;

  constructor(private readonly options: { userPoolId: string; users: Record<string, FakeUser> }) {}

  private get poolName(): string {
    return this.options.userPoolId.split('_')[1] as string;
  }

  private issueTokens(user: FakeUser, username: string, withRefreshToken: boolean): IdpHttpResponse {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return {
      status: 200,
      body: {
        AuthenticationResult: {
          AccessToken: makeJwt({ sub: `sub-${username}`, token_use: 'access', exp }),
          IdToken: makeJwt({
            sub: `sub-${username}`,
            'cognito:username': username,
            'cognito:groups': [...user.groups],
            ...(user.customerId !== undefined ? { 'custom:customer_id': user.customerId } : {}),
            token_use: 'id',
            exp,
          }),
          ...(withRefreshToken ? { RefreshToken: `refresh-${username}` } : {}),
          ExpiresIn: 3600,
          TokenType: 'Bearer',
        },
      },
    };
  }

  /** 服务端 x/v 计算（独立于客户端实现）。 */
  private verifierOf(username: string, password: string, saltHex: string): bigint {
    const inner = sha256Hex(new TextEncoder().encode(`${this.poolName}${username}:${password}`));
    const x = BigInt(`0x${hexHash(padHex(saltHex) + inner)}`);
    return modPow(G, x, N);
  }

  /** 服务端签名校验：独立复算 HKDF 与 HMAC。 */
  private verifyPasswordClaim(pending: PendingSrp, timestamp: string, signature: string): boolean {
    const u = BigInt(`0x${hexHash(padHex(pending.bigA.toString(16)) + padHex(pending.bigB.toString(16)))}`);
    const shared = modPow((pending.bigA * modPow(pending.v, u, N)) % N, pending.b, N);
    const prk = createHmac('sha256', hexToBytes(padHex(u.toString(16))))
      .update(hexToBytes(padHex(shared.toString(16))))
      .digest();
    const info = Buffer.concat([Buffer.from('Caldera Derived Key', 'utf8'), Buffer.from([1])]);
    const key = createHmac('sha256', prk).update(info).digest().subarray(0, 16);
    const message = Buffer.concat([
      Buffer.from(`${this.poolName}${pending.username}`, 'utf8'),
      pending.secretBlock,
      Buffer.from(timestamp, 'utf8'),
    ]);
    const expected = createHmac('sha256', key).update(message).digest('base64');
    return expected === signature;
  }

  readonly fetch: IdpFetch = async (operation, payload) => {
    this.calls.push({ operation, payload });
    switch (operation) {
      case 'InitiateAuth':
        return this.onInitiateAuth(payload);
      case 'RespondToAuthChallenge':
        return this.onRespondToChallenge(payload);
      case 'ForgotPassword':
        // preventUserExistenceErrors：未知用户也返回成功
        return { status: 200, body: {} };
      case 'ConfirmForgotPassword': {
        const code = (payload as Record<string, unknown>)['ConfirmationCode'];
        return code === '000000' ? errorResponse('CodeMismatchException') : { status: 200, body: {} };
      }
      case 'GlobalSignOut': {
        const token = (payload as Record<string, unknown>)['AccessToken'];
        if (typeof token === 'string') this.signedOutTokens.push(token);
        return { status: 200, body: {} };
      }
      default:
        return errorResponse('InvalidAction');
    }
  };

  private onInitiateAuth(payload: Record<string, unknown>): IdpHttpResponse {
    if (payload['AuthFlow'] === 'REFRESH_TOKEN_AUTH') {
      const params = payload['AuthParameters'] as Record<string, string>;
      const refreshToken = params['REFRESH_TOKEN'] ?? '';
      const username = refreshToken.replace(/^refresh-/, '');
      const user = this.options.users[username];
      if (!this.refreshTokensValid || !refreshToken.startsWith('refresh-') || user === undefined) {
        return errorResponse('NotAuthorizedException');
      }
      return this.issueTokens(user, username, false);
    }

    if (payload['AuthFlow'] !== 'USER_SRP_AUTH') return errorResponse('InvalidParameterException');
    const params = payload['AuthParameters'] as Record<string, string>;
    const username = params['USERNAME'] ?? '';
    const user = this.options.users[username];
    if (user === undefined) return errorResponse('NotAuthorizedException');
    const bigA = BigInt(`0x${params['SRP_A'] ?? '0'}`);
    if (bigA % N === 0n) return errorResponse('InvalidParameterException');

    this.sequence += 1;
    const saltHex = 'aa55'.repeat(8);
    const v = this.verifierOf(username, user.password, saltHex);
    const b = BigInt(`0x${'cd'.repeat(32)}`) + BigInt(this.sequence);
    const bigB = (K * v + modPow(G, b, N)) % N;
    const secretBlock = Buffer.from(`secret-block-${this.sequence}`, 'utf8');
    const sessionId = `sess-${this.sequence}`;
    this.pending.set(sessionId, { username, bigA, bigB, b, v, secretBlock });
    return {
      status: 200,
      body: {
        ChallengeName: 'PASSWORD_VERIFIER',
        ChallengeParameters: {
          USERNAME: username,
          USER_ID_FOR_SRP: username,
          SALT: saltHex,
          SRP_B: bigB.toString(16),
          SECRET_BLOCK: secretBlock.toString('base64'),
        },
        Session: sessionId,
      },
    };
  }

  private onRespondToChallenge(payload: Record<string, unknown>): IdpHttpResponse {
    const challengeName = payload['ChallengeName'] as string;
    const responses = payload['ChallengeResponses'] as Record<string, string>;
    const sessionId = payload['Session'] as string;
    const pending = this.pending.get(sessionId);
    if (pending === undefined) return errorResponse('NotAuthorizedException');
    const user = this.options.users[pending.username];
    if (user === undefined) return errorResponse('NotAuthorizedException');

    if (challengeName === 'PASSWORD_VERIFIER') {
      const ok = this.verifyPasswordClaim(
        pending,
        responses['TIMESTAMP'] ?? '',
        responses['PASSWORD_CLAIM_SIGNATURE'] ?? '',
      );
      if (!ok) return errorResponse('NotAuthorizedException');
      if (user.mfaSetup === true) {
        return { status: 200, body: { ChallengeName: 'MFA_SETUP', ChallengeParameters: {}, Session: sessionId } };
      }
      if (user.forceNewPassword === true) {
        return {
          status: 200,
          body: { ChallengeName: 'NEW_PASSWORD_REQUIRED', ChallengeParameters: {}, Session: sessionId },
        };
      }
      if (user.mfa === true) {
        return {
          status: 200,
          body: { ChallengeName: 'SOFTWARE_TOKEN_MFA', ChallengeParameters: {}, Session: sessionId },
        };
      }
      return this.issueTokens(user, pending.username, true);
    }

    if (challengeName === 'SOFTWARE_TOKEN_MFA') {
      const expected = user.mfaCode ?? '123456';
      if (responses['SOFTWARE_TOKEN_MFA_CODE'] !== expected) return errorResponse('CodeMismatchException');
      return this.issueTokens(user, pending.username, true);
    }

    if (challengeName === 'NEW_PASSWORD_REQUIRED') {
      if (typeof responses['NEW_PASSWORD'] !== 'string' || responses['NEW_PASSWORD'] === '') {
        return errorResponse('InvalidParameterException');
      }
      return this.issueTokens(user, pending.username, true);
    }

    return errorResponse('InvalidParameterException');
  }
}
