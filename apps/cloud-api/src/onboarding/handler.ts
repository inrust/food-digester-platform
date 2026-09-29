/**
 * BE-ONB-01 Handler：POST /api/v1/device/onboarding/request（框架无关）。
 *
 * 接线：限频 → AUTH-02 withOnboardingAuth（Token 校验 + 序列号绑定）→ Service。
 * 成功响应严格保持设备源协议顶层 { requestId, status }；
 * 错误 { error{code,message,requestId} }，未知异常一律 500 通用消息（不泄露内部细节）。
 *
 * 功能边界：不审批、不签发证书、无 AWS 资源副作用（纯数据库读写 + 共享限频）。
 */
import type { DbClient } from '@fdp/database';
import { AuthError, createRateLimiter, PostgresRateLimitStore, withOnboardingAuth } from '@fdp/auth';
import type { RateLimiter } from '@fdp/auth';
import { OnboardingApiError } from './errors.js';
import { serialNumberOfBody } from './dto.js';
import { submitOnboardingRequest } from './service.js';
import { createCsrOnboardingRequestHandler } from './csr-request.js';
import type { OnboardingRequestResult } from './service.js';

/** 适配层（API Gateway/Lambda）提供的规范化请求。 */
export interface OnboardingHttpRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  /** 平台请求 ID（如 API Gateway requestId），进入响应 meta 与错误体。 */
  readonly requestId: string;
  /** API Gateway requestContext.identity.sourceIp，经适配层规范化后注入。 */
  readonly sourceIp?: string | undefined;
}

export interface OnboardingHttpResponse {
  readonly status: number;
  readonly body: unknown;
  /** 仅适配层使用：响应字节成功提交后调用；不得序列化到 HTTP body。 */
  readonly onCommitted?: (() => Promise<void>) | undefined;
}

export interface OnboardingRequestHandlerDeps {
  readonly client: DbClient;
  /** 测试/定制覆盖；缺省使用 PostgreSQL 共享 Token+IP 双维限频。 */
  readonly rateLimiter?: RateLimiter;
  /** 注入时钟（测试用）。 */
  readonly now?: () => Date;
}

interface SuccessBody {
  readonly requestId: string;
  readonly status: 'PENDING';
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function bearerTokenOf(req: OnboardingHttpRequest): string | undefined {
  const header = req.headers.authorization ?? req.headers.Authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

function successBody(result: OnboardingRequestResult): SuccessBody {
  return { requestId: result.requestId, status: result.status };
}

function errorBody(code: string, message: string, req: OnboardingHttpRequest): ErrorBody {
  const safe = SENSITIVE_LEAK_PATTERN.test(message) ? 'The request failed' : message;
  return { error: { code, message: safe, requestId: req.requestId } };
}

function toErrorResponse(err: unknown, req: OnboardingHttpRequest): OnboardingHttpResponse {
  if (err instanceof AuthError) {
    return { status: err.httpStatus, body: errorBody(err.code, err.message, req) };
  }
  if (err instanceof OnboardingApiError) {
    return { status: err.httpStatus, body: errorBody(err.code, err.message, req) };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.requestId } },
  };
}

/**
 * 创建 POST /api/v1/device/onboarding/request Handler。
 * 新建返回 201，幂等重放（重复/并发提交）返回 200 与原 requestId。
 */
export function createOnboardingRequestHandler(
  deps: OnboardingRequestHandlerDeps,
): (req: OnboardingHttpRequest) => Promise<OnboardingHttpResponse> {
  const now = deps.now ?? (() => new Date());
  const sharedStore = new PostgresRateLimitStore(deps.client);
  const tokenRateLimiter = deps.rateLimiter ?? createRateLimiter(sharedStore, { limit: 30, windowSeconds: 60 });
  const ipRateLimiter = deps.rateLimiter ? undefined : createRateLimiter(sharedStore, { limit: 60, windowSeconds: 60 });
  const csrHandler = createCsrOnboardingRequestHandler(deps);

  const guarded = withOnboardingAuth<OnboardingHttpRequest, OnboardingHttpResponse>(
    {
      client: deps.client,
      tokenOf: bearerTokenOf,
      serialNumberOf: (req) => serialNumberOfBody(req.body),
      rateLimits: [
        { limiter: tokenRateLimiter, keyOf: (_req, fingerprint) => `onboarding:token:${fingerprint}` },
        ...(ipRateLimiter
          ? [
              {
                limiter: ipRateLimiter,
                keyOf: (req: OnboardingHttpRequest) => `onboarding:ip:${req.sourceIp ?? 'unknown'}`,
              },
            ]
          : []),
      ],
      now,
    },
    async (req, auth) => {
      const result = await submitOnboardingRequest(deps.client, auth, req.body, { now });
      return { status: result.replayed ? 200 : 201, body: successBody(result) };
    },
  );

  return async (req) => {
    if (!bearerTokenOf(req) && req.body && typeof req.body === 'object' && 'csrPem' in req.body) {
      return csrHandler(req);
    }
    try {
      return await guarded(req);
    } catch (err) {
      return toErrorResponse(err, req);
    }
  };
}
