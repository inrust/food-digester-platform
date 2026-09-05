/**
 * 管理 API 的可信 Lambda 组合根。
 *
 * API Gateway authorizer/context 中的 claims 只属于传输输入，不能直接成为 ActorContext；
 * 本适配器始终重新验证 Authorization Bearer JWT，再构造业务 Handler 唯一可信的 actor。
 */
import { AuthError, createCognitoAuthenticator } from '@fdp/auth';
import type { CognitoAuthenticatorConfig } from '@fdp/auth';
import type { AdminHttpRequest, AdminHttpResponse } from '../admin/onboarding/handler.js';

export interface ApiGatewayAdminEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly pathParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly identity?: { readonly sourceIp?: string };
    readonly http?: { readonly sourceIp?: string };
    /** 不可信输入：特意不读取 authorizer/claims。 */
    readonly authorizer?: unknown;
  };
  /** 防止调用者把伪造 actor 混进事件后被宽松 spread。 */
  readonly actor?: unknown;
}

export interface ApiGatewayAdminResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type AdminRoute = (request: AdminHttpRequest) => Promise<AdminHttpResponse>;

const header = (headers: Readonly<Record<string, string | undefined>>, wanted: string): string | undefined => {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted.toLowerCase());
  return entry?.[1];
};

function result(status: number, body: unknown): ApiGatewayAdminResult {
  return { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function createAdminLambdaHandler(config: CognitoAuthenticatorConfig, route: AdminRoute) {
  const authenticator = createCognitoAuthenticator(config);

  return async (event: ApiGatewayAdminEvent): Promise<ApiGatewayAdminResult> => {
    const headers = event.headers ?? {};
    const requestId = event.requestContext?.requestId ?? 'unknown';
    let actor;
    try {
      actor = await authenticator.authenticate(header(headers, 'authorization'));
    } catch (error) {
      if (error instanceof AuthError) {
        return result(error.httpStatus, {
          error: { code: error.code, message: error.message, requestId },
        });
      }
      return result(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required', requestId } });
    }

    let body: unknown;
    try {
      const encodedBody = event.body;
      const rawBody =
        encodedBody && event.isBase64Encoded ? Buffer.from(encodedBody, 'base64').toString('utf8') : encodedBody;
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      return result(400, {
        error: { code: 'VALIDATION_FAILED', message: 'Request body must be valid JSON', requestId },
      });
    }

    try {
      const sourceIp = event.requestContext?.http?.sourceIp ?? event.requestContext?.identity?.sourceIp;
      const userAgent = header(headers, 'user-agent');
      const response = await route({
        actor,
        headers,
        ...(event.pathParameters ? { params: event.pathParameters } : {}),
        ...(event.queryStringParameters ? { query: event.queryStringParameters } : {}),
        ...(body !== undefined ? { body } : {}),
        requestId,
        ...(sourceIp !== undefined ? { sourceIp } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
      });
      return result(response.status, response.body);
    } catch (error) {
      if (error instanceof AuthError) {
        return result(error.httpStatus, { error: { code: error.code, message: error.message, requestId } });
      }
      return result(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } });
    }
  };
}
