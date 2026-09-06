/**
 * 管理 API 的可信 Lambda 组合根。
 *
 * API Gateway authorizer/context 中的 claims 只属于传输输入，不能直接成为 ActorContext；
 * 本适配器始终重新验证 Authorization Bearer JWT，再构造业务 Handler 唯一可信的 actor。
 */
import { AuthError, createCognitoAuthenticator } from '@fdp/auth';
import type { CognitoAuthenticatorConfig } from '@fdp/auth';
import type { AdminHttpRequest, AdminHttpResponse } from '../admin/onboarding/handler.js';
import type { AdminOnboardingHandlers } from '../admin/onboarding/handler.js';

export interface ApiGatewayAdminEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly pathParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly httpMethod?: string;
  readonly path?: string;
  readonly rawPath?: string;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly identity?: { readonly sourceIp?: string };
    readonly http?: { readonly sourceIp?: string; readonly method?: string; readonly path?: string };
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
export type AdminRouteResolver = (event: ApiGatewayAdminEvent) => AdminRoute;

export interface AdminOnboardingRouteSet {
  readonly onboarding: AdminOnboardingHandlers;
}

const header = (headers: Readonly<Record<string, string | undefined>>, wanted: string): string | undefined => {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted.toLowerCase());
  return entry?.[1];
};

function result(status: number, body: unknown): ApiGatewayAdminResult {
  return { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** AUTH-01 的首个生产路由表；不匹配的接口失败关闭为 404，不回退到未鉴权 Handler。 */
export function createAdminRoute(event: ApiGatewayAdminEvent, routes: AdminOnboardingRouteSet): AdminRoute {
  const method = (event.requestContext?.http?.method ?? event.httpMethod ?? '').toUpperCase();
  const path = event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? '';
  const collection = /^\/api\/v1\/admin\/onboarding\/requests\/?$/;
  const member = /^\/api\/v1\/admin\/onboarding\/requests\/([^/]+?)(?:\/(approve|reject))?\/?$/;
  const matched = member.exec(path);

  return async (request) => {
    if (method === 'GET' && collection.test(path)) return routes.onboarding.list(request);
    if (matched) {
      const [, requestId, action] = matched;
      const routedRequest: AdminHttpRequest = {
        ...request,
        params: { ...(request.params ?? {}), requestId: decodeURIComponent(requestId as string) },
      };
      if (method === 'GET' && !action) return routes.onboarding.detail(routedRequest);
      if (method === 'POST' && action === 'approve') return routes.onboarding.approve(routedRequest);
      if (method === 'POST' && action === 'reject') return routes.onboarding.reject(routedRequest);
    }
    return {
      status: 404,
      body: {
        error: { code: 'NOT_FOUND', message: 'The requested resource was not found', requestId: request.requestId },
      },
    };
  };
}

export function createAdminLambdaHandler(config: CognitoAuthenticatorConfig, route: AdminRoute) {
  return createAdminLambdaRouter(config, () => route);
}

/** 生产路由变体：认证器/JWKS 缓存按 Lambda 容器复用，路由按当前 API Gateway 事件解析。 */
export function createAdminLambdaRouter(config: CognitoAuthenticatorConfig, resolveRoute: AdminRouteResolver) {
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
      const response = await resolveRoute(event)({
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
