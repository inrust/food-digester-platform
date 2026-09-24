/**
 * FE-01 管理 API 客户端：Cognito ID Token 注入、401 刷新重试与清会话、403 无权、CT-05 错误包络解析。
 *
 * 技术对接（FE-01 要求）：
 * - 401 清会话：先发前刷新；响应 401 → 强制刷新重试一次；仍 401 或刷新失败 → 清会话 + UnauthenticatedError；
 * - 403 显示无权：抛 ForbiddenError（保留会话，携带 CT-05 code/requestId 供界面展示）；
 * - 错误响应不得依赖内部细节：只透传 CT-05 包络的 code/message/requestId。
 */
import { ApiClientError, ForbiddenError, UnauthenticatedError } from './errors.js';
import type { SessionManager } from '../session/session-manager.js';

export interface ApiFetchResponse {
  readonly status: number;
  readonly body: unknown;
}

export type ApiFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<ApiFetchResponse>;

/** 默认传输：全局 fetch；非 JSON 响应按 null 处理。 */
export function createHttpApiFetch(fetchFn: typeof fetch): ApiFetch {
  return async (url, init) => {
    const response = await fetchFn(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** CT-05 写操作幂等键（Idempotency-Key）。 */
  readonly idempotencyKey?: string;
  /** CT-05 乐观锁（If-Match 版本号）。 */
  readonly ifMatch?: number;
}

export interface ApiClient {
  request<T>(path: string, options?: ApiRequestOptions): Promise<T>;
}

interface ErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

function parseErrorEnvelope(body: unknown): ErrorEnvelope | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as Record<string, unknown>)['error'];
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as Record<string, unknown>)['code'];
  const message = (error as Record<string, unknown>)['message'];
  const requestId = (error as Record<string, unknown>)['requestId'];
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { code, message, requestId: typeof requestId === 'string' ? requestId : null };
}

export interface ApiClientDeps {
  readonly baseUrl: string;
  readonly session: SessionManager;
  readonly fetch: ApiFetch;
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  async function send(path: string, options: ApiRequestOptions, idToken: string): Promise<ApiFetchResponse> {
    const headers: Record<string, string> = {
      // REST API 的 COGNITO_USER_POOLS authorizer 以 Authorization 为 Token source，
      // 这里必须传 Cognito 返回的 ID Token 本体。
      Authorization: idToken,
      ...options.headers,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.ifMatch !== undefined) headers['If-Match'] = String(options.ifMatch);
    return deps.fetch(`${deps.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  }

  async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    let idToken: string;
    try {
      idToken = await deps.session.ensureFreshIdToken();
    } catch {
      // 无会话或刷新失败（会话已被 SessionManager 清除）→ 安全退出到登录页
      throw new UnauthenticatedError();
    }

    let response = await send(path, options, idToken);
    if (response.status === 401) {
      // 竞态兜底：服务端判定过期 → 强制刷新后重试一次；仍 401 → 清会话安全退出
      try {
        idToken = await deps.session.ensureFreshIdToken({ forceRefresh: true });
      } catch {
        throw new UnauthenticatedError();
      }
      response = await send(path, options, idToken);
      if (response.status === 401) {
        deps.session.clearSession('unauthorized');
        throw new UnauthenticatedError();
      }
    }

    if (response.status === 403) {
      const envelope = parseErrorEnvelope(response.body);
      throw new ForbiddenError(
        envelope?.code ?? 'FORBIDDEN',
        envelope?.message ?? 'The caller is not allowed to perform this operation',
        envelope?.requestId ?? null,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      const envelope = parseErrorEnvelope(response.body);
      if (envelope !== null) {
        throw new ApiClientError(response.status, envelope.code, envelope.message, envelope.requestId);
      }
      throw new ApiClientError(response.status, 'INTERNAL_ERROR', 'The request failed');
    }

    return response.body as T;
  }

  return { request };
}
