/**
 * FE-01 认证编排：Cognito 登录（USER_SRP_AUTH）、MFA challenge、首次改密、忘记密码与登出。
 *
 * - login() 完成 SRP-A 交换与 PASSWORD_VERIFIER 应答；成功即建立会话（SessionManager.establish）；
 * - MFA / NEW_PASSWORD_REQUIRED 以 pending challenge 暂存（仅内存、随页面销毁），
 *   submitMfaCode / submitNewPassword 续走同一 Cognito Session；
 * - MFA_SETUP（池级 OPTIONAL 但组策略强制时首登触发）为终止态：前端提示联系管理员完成
 *   MFA 绑定，本任务不实现 Cognito 账号运维界面（FE-01 功能边界）；
 * - 密码只存在于单次调用的参数中，绝不写入会话存储或日志。
 */
import { CHALLENGE_NAMES, CognitoIdpError } from './cognito-idp.js';
import type { AuthChallenge, CognitoIdpClient, IdpAuthReply } from './cognito-idp.js';
import { computePasswordVerifierClaim, generateSrpEphemeral } from './srp.js';
import { buildSessionFromTokens } from '../session/session-manager.js';
import type { EstablishedSession, SessionManager } from '../session/session-manager.js';

export type MfaChallengeKind = 'SOFTWARE_TOKEN_MFA' | 'SMS_MFA';

export type LoginOutcome =
  | { readonly status: 'authenticated'; readonly session: EstablishedSession }
  | { readonly status: 'mfa-required'; readonly mfa: MfaChallengeKind }
  | { readonly status: 'new-password-required' }
  | { readonly status: 'mfa-setup-required' };

export class AuthFlowError extends Error {
  readonly code: 'no-pending-challenge' | 'unexpected-challenge' | 'unsupported-challenge';

  constructor(code: AuthFlowError['code'], message: string) {
    super(message);
    this.name = 'AuthFlowError';
    this.code = code;
  }
}

interface PendingChallenge {
  readonly username: string;
  readonly challenge: AuthChallenge;
}

export interface AuthFlowDeps {
  readonly idp: CognitoIdpClient;
  readonly userPoolId: string;
  readonly sessionManager: SessionManager;
  readonly clock?: () => number;
  readonly random?: (byteLength: number) => Uint8Array;
}

export class AuthFlow {
  private readonly deps: AuthFlowDeps;

  private readonly clock: () => number;

  private pending: PendingChallenge | null = null;

  constructor(deps: AuthFlowDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** Cognito 登录：用户名 + 密码（SRP）。密码不落盘、不进会话。 */
  async login(username: string, password: string): Promise<LoginOutcome> {
    this.pending = null;
    const ephemeral = generateSrpEphemeral(this.deps.random);
    const first = await this.deps.idp.initiateSrpAuth(username, ephemeral.srpAHex);
    if (first.kind !== 'challenge' || first.challenge.challengeName !== CHALLENGE_NAMES.passwordVerifier) {
      return this.handleReply(username, first);
    }
    const params = first.challenge.parameters;
    const userIdForSrp = params['USER_ID_FOR_SRP'];
    const saltHex = params['SALT'];
    const srpBHex = params['SRP_B'];
    const secretBlock = params['SECRET_BLOCK'];
    if (!userIdForSrp || !saltHex || !srpBHex || !secretBlock) {
      throw new CognitoIdpError('UNKNOWN', 'The password verifier challenge is incomplete');
    }
    const claim = await computePasswordVerifierClaim(ephemeral, {
      userPoolId: this.deps.userPoolId,
      userIdForSrp,
      password,
      saltHex,
      srpBHex,
      secretBlockBase64: secretBlock,
    });
    const reply = await this.deps.idp.respondToChallenge(
      CHALLENGE_NAMES.passwordVerifier,
      {
        USERNAME: username,
        PASSWORD_CLAIM_SECRET_BLOCK: secretBlock,
        TIMESTAMP: claim.timestamp,
        PASSWORD_CLAIM_SIGNATURE: claim.passwordClaimSignature,
      },
      first.challenge.session,
    );
    return this.handleReply(username, reply);
  }

  /** 提交 MFA 验证码（软件令牌 / 短信），续走 pending challenge。 */
  async submitMfaCode(code: string): Promise<LoginOutcome> {
    const pending = this.requirePending([CHALLENGE_NAMES.softwareTokenMfa, CHALLENGE_NAMES.smsMfa]);
    const codeParam =
      pending.challenge.challengeName === CHALLENGE_NAMES.softwareTokenMfa ? 'SOFTWARE_TOKEN_MFA_CODE' : 'SMS_MFA_CODE';
    const reply = await this.deps.idp.respondToChallenge(
      pending.challenge.challengeName,
      { USERNAME: pending.username, [codeParam]: code },
      pending.challenge.session,
    );
    return this.handleReply(pending.username, reply);
  }

  /** 提交新密码（NEW_PASSWORD_REQUIRED，如管理员首次下发临时密码）。 */
  async submitNewPassword(newPassword: string): Promise<LoginOutcome> {
    const pending = this.requirePending([CHALLENGE_NAMES.newPasswordRequired]);
    const reply = await this.deps.idp.respondToChallenge(
      CHALLENGE_NAMES.newPasswordRequired,
      { USERNAME: pending.username, NEW_PASSWORD: newPassword },
      pending.challenge.session,
    );
    return this.handleReply(pending.username, reply);
  }

  /** 忘记密码：触发 Cognito 邮件/短信验证码（防用户枚举由池配置兜底）。 */
  async forgotPassword(username: string): Promise<void> {
    await this.deps.idp.forgotPassword(username);
  }

  async confirmForgotPassword(username: string, confirmationCode: string, newPassword: string): Promise<void> {
    await this.deps.idp.confirmForgotPassword(username, confirmationCode, newPassword);
  }

  async logout(): Promise<void> {
    this.pending = null;
    await this.deps.sessionManager.logout();
  }

  private requirePending(accepted: readonly string[]): PendingChallenge {
    const pending = this.pending;
    if (pending === null || !accepted.includes(pending.challenge.challengeName)) {
      throw new AuthFlowError('no-pending-challenge', 'There is no matching pending challenge');
    }
    return pending;
  }

  private handleReply(username: string, reply: IdpAuthReply): LoginOutcome {
    if (reply.kind === 'tokens') {
      const refreshToken = reply.tokens.refreshToken;
      if (refreshToken === undefined) {
        // 登录类响应必须携带 RefreshToken；缺失视为非法响应，失败关闭
        throw new CognitoIdpError('UNKNOWN', 'The sign-in response carries no refresh token');
      }
      const session = buildSessionFromTokens(reply.tokens, { refreshToken, nowMs: this.clock() });
      this.pending = null;
      this.deps.sessionManager.establish(session);
      return { status: 'authenticated', session };
    }
    const name = reply.challenge.challengeName;
    if (name === CHALLENGE_NAMES.softwareTokenMfa || name === CHALLENGE_NAMES.smsMfa) {
      this.pending = { username, challenge: reply.challenge };
      return { status: 'mfa-required', mfa: name };
    }
    if (name === CHALLENGE_NAMES.newPasswordRequired) {
      this.pending = { username, challenge: reply.challenge };
      return { status: 'new-password-required' };
    }
    if (name === CHALLENGE_NAMES.mfaSetup) {
      // 终止态：需管理员/账号流程完成 MFA 绑定（不实现账号运维界面，见 FE-01 功能边界）
      this.pending = null;
      return { status: 'mfa-setup-required' };
    }
    throw new AuthFlowError('unsupported-challenge', `Unsupported Cognito challenge: ${name}`);
  }
}
