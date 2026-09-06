/**
 * FE-01 Cognito IDP 客户端（无凭据、纯 fetch 适配）。
 *
 * 对接 IAC-01 的 AdminWebClient（仅 USER_SRP_AUTH、preventUserExistenceErrors、软件令牌 MFA）。
 * 调用 Cognito IDP JSON API（X-Amz-Target = AWSCognitoIdentityProviderService.<Operation>），
 * 公共客户端不带 ClientSecret。错误映射为封闭错误码；凭证类错误不区分用户不存在/密码错误
 * （与 preventUserExistenceErrors 的防探测语义一致）。
 */

export const CHALLENGE_NAMES = {
  passwordVerifier: 'PASSWORD_VERIFIER',
  softwareTokenMfa: 'SOFTWARE_TOKEN_MFA',
  smsMfa: 'SMS_MFA',
  newPasswordRequired: 'NEW_PASSWORD_REQUIRED',
  mfaSetup: 'MFA_SETUP',
} as const;

export type ChallengeName = (typeof CHALLENGE_NAMES)[keyof typeof CHALLENGE_NAMES];

export interface AuthenticationResult {
  readonly accessToken: string;
  readonly idToken: string;
  /** 刷新响应不返回新 RefreshToken 时保持 undefined（调用方保留旧值）。 */
  readonly refreshToken?: string;
  readonly expiresInSeconds: number;
  readonly tokenType: string;
}

export interface AuthChallenge {
  readonly challengeName: string;
  readonly session: string | undefined;
  readonly parameters: Record<string, string>;
}

export type IdpAuthReply =
  | { readonly kind: 'tokens'; readonly tokens: AuthenticationResult }
  | { readonly kind: 'challenge'; readonly challenge: AuthChallenge };

export type CognitoErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'PASSWORD_RESET_REQUIRED'
  | 'USER_NOT_CONFIRMED'
  | 'CODE_MISMATCH'
  | 'CODE_EXPIRED'
  | 'REFRESH_TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'UNKNOWN';

export class CognitoIdpError extends Error {
  readonly code: CognitoErrorCode;

  constructor(code: CognitoErrorCode, message: string) {
    super(message);
    this.name = 'CognitoIdpError';
    this.code = code;
  }
}

export interface IdpHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 传输层抽象：一次 Cognito IDP 操作调用；测试注入脚本化实现。 */
export type IdpFetch = (operation: string, payload: Record<string, unknown>) => Promise<IdpHttpResponse>;

export interface CognitoIdpClient {
  /** InitiateAuth(USER_SRP_AUTH)：提交 USERNAME + SRP_A。 */
  initiateSrpAuth(username: string, srpA: string): Promise<IdpAuthReply>;
  /** RespondToAuthChallenge：PASSWORD_VERIFIER / *_MFA / NEW_PASSWORD_REQUIRED 应答。 */
  respondToChallenge(
    challengeName: string,
    responses: Record<string, string>,
    session: string | undefined,
  ): Promise<IdpAuthReply>;
  /** InitiateAuth(REFRESH_TOKEN_AUTH)：刷新 Access/Id Token。 */
  refreshAuth(refreshToken: string): Promise<AuthenticationResult>;
  forgotPassword(username: string): Promise<void>;
  confirmForgotPassword(username: string, confirmationCode: string, newPassword: string): Promise<void>;
  /** GlobalSignOut：服务端吊销该用户全部 Token；失败不阻塞本地登出（由调用方兜底）。 */
  globalSignOut(accessToken: string): Promise<void>;
}

export interface CognitoIdpClientConfig {
  readonly region: string;
  readonly clientId: string;
  readonly fetch?: IdpFetch;
}

/** 默认传输：HTTPS POST 到 cognito-idp 端点（无凭据，公开客户端）。 */
export function createHttpIdpFetch(region: string, fetchFn: typeof fetch): IdpFetch {
  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`;
  return async (operation, payload) => {
    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new CognitoIdpError('NETWORK', 'The identity provider is unreachable');
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

function cognitoErrorType(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>)['__type'];
  if (typeof raw !== 'string') return null;
  const hash = raw.indexOf('#');
  return hash >= 0 ? raw.slice(hash + 1) : raw;
}

function mapCognitoError(body: unknown, context: 'auth' | 'refresh'): CognitoIdpError {
  const type = cognitoErrorType(body);
  switch (type) {
    case 'NotAuthorizedException':
      // 刷新场景下 NotAuthorized 表示 RefreshToken 失效/吊销 → 安全退出
      return context === 'refresh'
        ? new CognitoIdpError('REFRESH_TOKEN_INVALID', 'The refresh token is no longer valid')
        : new CognitoIdpError('INVALID_CREDENTIALS', 'The username or password is incorrect');
    case 'UserNotFoundException':
      return new CognitoIdpError('INVALID_CREDENTIALS', 'The username or password is incorrect');
    case 'PasswordResetRequiredException':
      return new CognitoIdpError('PASSWORD_RESET_REQUIRED', 'A password reset is required before sign-in');
    case 'UserNotConfirmedException':
      return new CognitoIdpError('USER_NOT_CONFIRMED', 'The account is not confirmed');
    case 'CodeMismatchException':
      return new CognitoIdpError('CODE_MISMATCH', 'The confirmation code is incorrect');
    case 'ExpiredCodeException':
      return new CognitoIdpError('CODE_EXPIRED', 'The confirmation code has expired');
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return new CognitoIdpError('RATE_LIMITED', 'Too many attempts; try again later');
    default:
      return new CognitoIdpError('UNKNOWN', 'The identity provider rejected the request');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseAuthReply(response: IdpHttpResponse, context: 'auth' | 'refresh'): IdpAuthReply {
  if (response.status < 200 || response.status >= 300) {
    throw mapCognitoError(response.body, context);
  }
  const body = response.body;
  if (isRecord(body) && isRecord(body['AuthenticationResult'])) {
    const result = body['AuthenticationResult'];
    if (typeof result['AccessToken'] === 'string' && typeof result['IdToken'] === 'string') {
      const refreshToken = result['RefreshToken'];
      return {
        kind: 'tokens',
        tokens: {
          accessToken: result['AccessToken'],
          idToken: result['IdToken'],
          ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
          expiresInSeconds: typeof result['ExpiresIn'] === 'number' ? result['ExpiresIn'] : 3600,
          tokenType: typeof result['TokenType'] === 'string' ? result['TokenType'] : 'Bearer',
        },
      };
    }
  }
  if (isRecord(body) && typeof body['ChallengeName'] === 'string') {
    const parameters = body['ChallengeParameters'];
    const session = body['Session'];
    return {
      kind: 'challenge',
      challenge: {
        challengeName: body['ChallengeName'],
        session: typeof session === 'string' ? session : undefined,
        parameters: isRecord(parameters)
          ? Object.fromEntries(
              Object.entries(parameters).filter(([, v]) => typeof v === 'string') as [string, string][],
            )
          : {},
      },
    };
  }
  throw new CognitoIdpError('UNKNOWN', 'The identity provider returned an unexpected response');
}

function parseTokens(response: IdpHttpResponse): AuthenticationResult {
  const reply = parseAuthReply(response, 'refresh');
  if (reply.kind !== 'tokens') {
    throw new CognitoIdpError('UNKNOWN', 'The identity provider returned an unexpected response');
  }
  return reply.tokens;
}

export function createCognitoIdpClient(config: CognitoIdpClientConfig): CognitoIdpClient {
  const transport = config.fetch ?? createHttpIdpFetch(config.region, fetch);

  async function callVoid(operation: string, payload: Record<string, unknown>): Promise<void> {
    const response = await transport(operation, payload);
    if (response.status < 200 || response.status >= 300) {
      throw mapCognitoError(response.body, 'auth');
    }
  }

  return {
    initiateSrpAuth(username, srpA) {
      return call('InitiateAuth', {
        AuthFlow: 'USER_SRP_AUTH',
        ClientId: config.clientId,
        AuthParameters: { USERNAME: username, SRP_A: srpA },
      }).then((r) => parseAuthReply(r, 'auth'));
    },
    respondToChallenge(challengeName, responses, session) {
      return call('RespondToAuthChallenge', {
        ChallengeName: challengeName,
        ClientId: config.clientId,
        ChallengeResponses: responses,
        ...(session !== undefined ? { Session: session } : {}),
      }).then((r) => parseAuthReply(r, 'auth'));
    },
    refreshAuth(refreshToken) {
      return call('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: config.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }).then(parseTokens);
    },
    forgotPassword(username) {
      return callVoid('ForgotPassword', { ClientId: config.clientId, Username: username });
    },
    confirmForgotPassword(username, confirmationCode, newPassword) {
      return callVoid('ConfirmForgotPassword', {
        ClientId: config.clientId,
        Username: username,
        ConfirmationCode: confirmationCode,
        Password: newPassword,
      });
    },
    globalSignOut(accessToken) {
      return callVoid('GlobalSignOut', { AccessToken: accessToken });
    },
  };

  function call(operation: string, payload: Record<string, unknown>): Promise<IdpHttpResponse> {
    return transport(operation, payload);
  }
}
