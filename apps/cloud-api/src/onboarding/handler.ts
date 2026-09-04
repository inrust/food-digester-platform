/**
 * BE-ONB-01 Handler：POST /api/v1/device/onboarding/request（框架无关）。
 *
 * 接线：限频 → AUTH-02 withOnboardingAuth（Token 校验 + 序列号绑定）→ Service。
 * 响应契约对齐 CT-05：成功 { data, meta{requestId,timestamp} }；
 * 错误 { error{code,message,requestId} }，未知异常一律 500 通用消息（不泄露内部细节）。
 *
 * 功能边界：不审批、不签发证书、无 AWS 资源副作用（纯数据库读写 + 进程内限频）。
 */
import type { DbClient } from '@fdp/database';
import { AuthError, createRateLimiter, InMemoryRateLimitStore, withOnboardingAuth } from '@fdp/auth';
import type { RateLimiter } from '@fdp/auth';
import { OnboardingApiError } from './errors.js';
import { serialNumberOfBody } from './dto.js';
import { submitOnboardingRequest } from './service.js';
import type { OnboardingRequestResult } from './service.js';

/** 适配层（API Gateway/Lambda）提供的规范化请求。 */
export interface OnboardingHttpRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  /** 平台请求 ID（如 API Gateway requestId），进入响应 meta 与错误体。 */
  readonly requestId: string;
}

export interface OnboardingHttpResponse {
  readonly status: number;
  readonly body: unknown;
  /** 仅适配层使用：响应字节成功提交后调用；不得序列化到 HTTP body。 */
  readonly onCommitted?: (() => Promise<void>) | undefined;
}

export interface OnboardingRequestHandlerDeps {
  readonly client: DbClient;
  /** 限频器；缺省为进程内固定窗口 30 次/60s（按 Token 指纹）。 */
  readonly rateLimiter?: RateLimiter;
  /** 注入时钟（测试用）。 */
  readonly now?: () => Date;
}

interface SuccessBody {
  readonly data: {
    readonly requestId: string;
    readonly status: 'PENDING';
    readonly serialNumber: string;
    readonly createdAt: string;
  };
  readonly meta: { readonly requestId: string; readonly timestamp: string };
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function bearerTokenOf(req: OnboardingHttpRequest): string | undefined {
  const header = req.headers.authorization ?? req.headers.Authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

function successBody(result: OnboardingRequestResult, req: OnboardingHttpRequest, now: Date): SuccessBody {
  return {
    data: {
      requestId: result.requestId,
      status: result.status,
      serialNumber: result.serialNumber,
      createdAt: result.createdAt.toISOString(),
    },
    meta: { requestId: req.requestId, timestamp: now.toISOString() },
  };
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
  const rateLimiter =
    deps.rateLimiter ?? createRateLimiter(new InMemoryRateLimitStore(), { limit: 30, windowSeconds: 60 });

  const guarded = withOnboardingAuth<OnboardingHttpRequest, OnboardingHttpResponse>(
    {
      client: deps.client,
      tokenOf: bearerTokenOf,
      serialNumberOf: (req) => serialNumberOfBody(req.body),
      rateLimiter,
      now,
    },
    async (req, auth) => {
      const result = await submitOnboardingRequest(deps.client, auth, req.body, { now });
      return { status: result.replayed ? 200 : 201, body: successBody(result, req, now()) };
    },
  );

  return async (req) => {
    try {
      return await guarded(req);
    } catch (err) {
      return toErrorResponse(err, req);
    }
  };
}
